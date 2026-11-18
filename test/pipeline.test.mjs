import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage } from '../src/adapter.mjs';
import { collect } from '../src/pipeline.mjs';
import { RecordStore } from '../src/store.mjs';
import { buildItinerary, renderItinerary, ACTIONS } from '../src/itinerary.mjs';

const NOW = new Date('2026-11-18T20:00:00.000Z');

function page(overrides = {}) {
  const { channels, ...rest } = overrides;
  return {
    source: 'local',
    observedAt: '2026-11-18T02:00:00.000Z',
    ...rest,
    channels: { official: [], agency: [], manual: [], ...(channels ?? {}) },
  };
}

const closedOfficial = {
  slotId: 'm101', venueName: '主展厅', date: '2026-11-20', timeRange: '10:00-12:00',
  status: 'closed', reason: '场地维护', revision: 3, observedAt: '2026-11-18T01:30:00.000Z',
};
const staleAgency = {
  slotId: 'm101', venueName: '主展厅', date: '2026-11-20', timeRange: '10:00-12:00',
  bookable: true, seatsAvailable: 12, capacity: 30, revision: 5,
  observedAt: '2026-11-18T01:55:00.000Z',
};
const validManual = {
  slotId: 'm101', venueName: '主展厅', date: '2026-11-20', timeRange: '10:00-12:00',
  confirmed: true, confirmedBy: '接待员·王敏', confirmedAt: '2026-11-17T10:15:00.000Z',
  expiresAt: '2026-11-19T10:15:00.000Z', note: '维护期间保留团体通道', revision: 1,
  observedAt: '2026-11-17T10:20:00.000Z',
};
const expiredManual = {
  slotId: 'm102', venueName: '主展厅', date: '2026-11-21', timeRange: '14:00-16:00',
  confirmed: true, confirmedBy: '接待员·王敏', confirmedAt: '2026-11-15T09:00:00.000Z',
  expiresAt: '2026-11-17T09:00:00.000Z', note: '上周锁定的团体名额', revision: 1,
  observedAt: '2026-11-15T09:10:00.000Z',
};

test('采集链按渠道分轨规整，官方/代理/人工记录各自独立保留', async () => {
  const store = new RecordStore();
  const result = await collect({
    now: NOW,
    store,
    source: async () => page({
      channels: { official: [closedOfficial], agency: [staleAgency], manual: [validManual] },
    }),
  });

  assert.equal(result.records.length, 3);
  assert.deepEqual([...new Set(result.records.map((r) => r.channel))].sort(), ['agency', 'manual', 'official']);
  assert.equal(store.list().length, 3);
  // 同一时段下三条分轨记录都可按 slotId 取回，不存在互相覆盖
  assert.equal(store.findBySlot('m101').length, 3);
});

test('代理记录更新时间再新，也不会让官方关闭时段重新开放', () => {
  const records = normalizePage(page({
    channels: { official: [closedOfficial], agency: [staleAgency], manual: [validManual] },
  }));
  const { entries } = buildItinerary(records, { now: NOW });
  const entry = entries.find((e) => e.slotId === 'm101');

  assert.equal(entry.officialStatus.status, 'closed');
  assert.equal(entry.capacity.bookable, true);
  assert.ok(entry.conflicts.some((c) => c.code === 'channel_conflict'));
  assert.equal(entry.action, ACTIONS.HOLD_WITH_CONFIRMATION);
  assert.notEqual(entry.action, ACTIONS.BOOKABLE);
});

test('人工确认不会被其他渠道较新的更新时间或修订号抹掉', () => {
  const store = new RecordStore();
  // 先存人工确认，再用修订号更高、时间更新的官方与代理记录“刷新”
  store.save(normalizePage(page({ channels: { manual: [validManual] } }))[0]);
  for (const record of normalizePage(page({ channels: { official: [closedOfficial], agency: [staleAgency] } }))) {
    store.save(record);
  }
  const entry = buildItinerary(store.list(), { now: NOW }).entries[0];

  assert.ok(entry.manualConfirmation);
  assert.equal(entry.manualConfirmation.state, 'expiring_soon');
  assert.equal(entry.manualConfirmation.confirmedBy, '接待员·王敏');
  assert.ok(entry.reminders.some((r) => r.code === 'confirmation_expiring_soon' && r.severity === 'info'));
});

test('人工确认过期后产生告警并要求重新安排', () => {
  const records = normalizePage(page({
    channels: { agency: [{ ...staleAgency, slotId: 'm102' }], manual: [expiredManual] },
  }));
  const entry = buildItinerary(records, { now: NOW }).entries.find((e) => e.slotId === 'm102');

  assert.equal(entry.manualConfirmation.state, 'expired');
  assert.ok(entry.reminders.some((r) => r.code === 'confirmation_expired' && r.severity === 'warning'));
  assert.equal(entry.action, ACTIONS.RESCHEDULE);
  assert.match(entry.advisory, /重新确认|改约/);
});

test('官方开放且代理有余位时判为可预订，三类信息仍然分段可辨', () => {
  const records = normalizePage(page({
    channels: {
      official: [{ ...closedOfficial, slotId: 'm103', status: 'open', reason: null, revision: 1 }],
      agency: [{ ...staleAgency, slotId: 'm103', bookable: true, seatsAvailable: 18, revision: 1 }],
    },
  }));
  const entry = buildItinerary(records, { now: NOW }).entries[0];

  assert.equal(entry.action, ACTIONS.BOOKABLE);
  assert.equal(entry.officialStatus.status, 'open');
  assert.equal(entry.capacity.seatsAvailable, 18);
  assert.equal(entry.manualConfirmation, null);
  assert.equal(entry.conflicts.length, 0);
});

test('缺少官方状态时，代理可订不能替代开放结论，需先核实', () => {
  const records = normalizePage(page({ channels: { agency: [staleAgency] } }));
  const entry = buildItinerary(records, { now: NOW }).entries[0];

  assert.equal(entry.officialStatus, null);
  assert.equal(entry.action, ACTIONS.VERIFY_OFFICIAL);
  assert.ok(entry.reminders.some((r) => r.code === 'official_status_unknown'));
});

test('同一渠道内仍按修订号更新，跨渠道互不影响', () => {
  const store = new RecordStore();
  const oldManual = { ...validManual, note: '旧备注', revision: 1 };
  const newManual = { ...validManual, note: '新备注', revision: 2 };
  store.save(normalizePage(page({ channels: { manual: [oldManual] } }))[0]);
  for (const record of normalizePage(page({ channels: { manual: [newManual], official: [closedOfficial] } }))) {
    store.save(record);
  }

  const manualTrack = store.findBySlot('m101').find((r) => r.channel === 'manual');
  const officialTrack = store.findBySlot('m101').find((r) => r.channel === 'official');
  assert.equal(manualTrack.note, '新备注');
  assert.equal(officialTrack.status, 'closed');
  assert.equal(store.findBySlot('m101').length, 2);
});

test('不完整或不合法的渠道记录被拒绝', () => {
  assert.throws(() => normalizePage(page({ channels: { official: [{ slotId: 'x' }] } })), /venueName/);
  assert.throws(
    () => normalizePage(page({ channels: { agency: [{ ...staleAgency, seatsAvailable: 40 }] } })),
    /容量数据不合法/,
  );
  assert.throws(
    () => normalizePage(page({ channels: { manual: [{ ...validManual, expiresAt: undefined }] } })),
    /expiresAt/,
  );
});

test('渲染文本中官方状态、代理容量、人工确认分段出现且包含过期重排提醒', () => {
  const records = normalizePage(page({
    channels: {
      official: [closedOfficial],
      agency: [staleAgency, { ...staleAgency, slotId: 'm102' }],
      manual: [validManual, expiredManual],
    },
  }));
  const text = renderItinerary(buildItinerary(records, { now: NOW }));

  assert.match(text, /官方状态: 关闭（场地维护）/);
  assert.match(text, /代理容量: 可订，余位 12\/30/);
  assert.match(text, /人工确认: 有效（即将过期）/);
  assert.match(text, /人工确认: 已过期/);
  assert.match(text, /提醒\[告警\]: 人工确认已于 .* 过期.*重新安排/);
  assert.match(text, /建议: 凭人工确认保留行程/);
  assert.match(text, /建议: 重新安排行程/);
});

test('端到端运行仓库自带样例：关闭时段不被代理重开，过期确认触发重排', async () => {
  const result = await collect({ now: NOW });
  const byId = Object.fromEntries(result.itinerary.entries.map((e) => [e.slotId, e]));

  assert.equal(byId.m101.action, ACTIONS.HOLD_WITH_CONFIRMATION);
  assert.ok(byId.m101.conflicts.some((c) => c.code === 'channel_conflict'));
  assert.equal(byId.m102.action, ACTIONS.RESCHEDULE);
  assert.ok(byId.m102.reminders.some((r) => r.code === 'confirmation_expired'));
  assert.equal(byId.m103.action, ACTIONS.BOOKABLE);
});
