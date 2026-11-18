/**
 * 行程单归并：把分轨存储的三类记录归并为可逐条辨识的行程条目。
 *
 * 设计原则：
 * 1. 官方状态、代理容量、人工确认在条目内各自独立成段，不做字段级合并，
 *    任何一方都不会因为更新时间较新而抹掉另一方；
 * 2. 官方渠道对“开/关”具有最终决定权，代理可订只代表其自有库存，
 *    不能让官方关闭时段重新开放；
 * 3. 人工确认带过期时间：有效时作为保留行程的凭据，过期后产生告警级
 *    提醒并要求重新安排，临期（默认 24 小时内）产生提示级提醒。
 */

export const ACTIONS = Object.freeze({
  HOLD_WITH_CONFIRMATION: 'hold_with_confirmation',
  RESCHEDULE: 'reschedule',
  BOOKABLE: 'bookable',
  FULL: 'full',
  VERIFY_OFFICIAL: 'verify_official',
  NO_DATA: 'no_data',
});

const ACTION_LABELS = Object.freeze({
  [ACTIONS.HOLD_WITH_CONFIRMATION]: '凭人工确认保留行程',
  [ACTIONS.RESCHEDULE]: '重新安排行程',
  [ACTIONS.BOOKABLE]: '可预订',
  [ACTIONS.FULL]: '已满，候补或改期',
  [ACTIONS.VERIFY_OFFICIAL]: '向官方核实后再决定',
  [ACTIONS.NO_DATA]: '暂无任何来源数据',
});

const DEFAULT_EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

function latestByRevision(records) {
  return records.reduce((latest, record) => {
    if (!latest || record.revision > latest.revision) return record;
    return latest;
  }, null);
}

function sourceTag(record) {
  return `${record.source} · ${record.channel}@r${record.revision}（观察于 ${record.observedAt ?? '未知时间'}）`;
}

function describeManual(state) {
  if (state === 'expired') return '已过期';
  if (state === 'expiring_soon') return '有效（即将过期）';
  return '有效';
}

function buildEntry(slotId, records, now, expiryWarningMs) {
  const identity = records[0];
  const official = latestByRevision(records.filter((r) => r.channel === 'official'));
  const agency = latestByRevision(records.filter((r) => r.channel === 'agency'));
  const manual = latestByRevision(
    records.filter((r) => r.channel === 'manual' && r.confirmed === true),
  );

  const conflicts = [];
  const reminders = [];

  const officialStatus = official
    ? {
        status: official.status,
        reason: official.reason,
        source: sourceTag(official),
        revision: official.revision,
        observedAt: official.observedAt,
      }
    : null;

  const capacity = agency
    ? {
        bookable: agency.bookable,
        seatsAvailable: agency.seatsAvailable,
        capacity: agency.capacity,
        source: sourceTag(agency),
        revision: agency.revision,
        observedAt: agency.observedAt,
      }
    : null;

  let manualConfirmation = null;
  if (manual) {
    const expiryMs = Date.parse(manual.expiresAt);
    const state = now.getTime() > expiryMs
      ? 'expired'
      : expiryMs - now.getTime() <= expiryWarningMs
        ? 'expiring_soon'
        : 'valid';
    manualConfirmation = {
      state,
      confirmedBy: manual.confirmedBy,
      confirmedAt: manual.confirmedAt,
      expiresAt: manual.expiresAt,
      note: manual.note,
      source: sourceTag(manual),
      revision: manual.revision,
      observedAt: manual.observedAt,
    };
    if (state === 'expired') {
      reminders.push({
        code: 'confirmation_expired',
        severity: 'warning',
        message: `人工确认已于 ${manual.expiresAt} 过期，原确认不再有效，请重新安排该时段行程`,
      });
    } else if (state === 'expiring_soon') {
      reminders.push({
        code: 'confirmation_expiring_soon',
        severity: 'info',
        message: `人工确认将于 ${manual.expiresAt} 过期（${Math.round((expiryMs - now.getTime()) / 3_600_000)} 小时内），请尽快落实或续期`,
      });
    }
  }

  // 官方关闭而代理仍显示可订：典型的过期代理数据，必须显式标注冲突。
  const reopeningConflict = official?.status === 'closed' && agency?.bookable === true;
  if (reopeningConflict) {
    conflicts.push({
      code: 'channel_conflict',
      message: '代理页面仍显示可订，但官方渠道已关闭该时段；以官方状态为准，代理库存不会重开关闭时段',
    });
    reminders.push({
      code: 'channel_conflict',
      severity: 'warning',
      message: '官方关闭与代理可订相互矛盾，请勿按代理页面下单，需向代理同步关闭信息',
    });
  }

  if (!official) {
    reminders.push({
      code: 'official_status_unknown',
      severity: 'warning',
      message: '缺少官方渠道状态，代理可订与人工确认均不能替代官方开/关结论，需先向馆方核实',
    });
  }

  let action;
  if (manualConfirmation?.state === 'expired') {
    action = ACTIONS.RESCHEDULE;
  } else if (official?.status === 'closed') {
    action = manualConfirmation
      ? ACTIONS.HOLD_WITH_CONFIRMATION
      : ACTIONS.RESCHEDULE;
  } else if (official?.status === 'open') {
    if (agency && agency.bookable && agency.seatsAvailable > 0) {
      action = ACTIONS.BOOKABLE;
    } else if (agency) {
      action = ACTIONS.FULL;
    } else {
      action = ACTIONS.VERIFY_OFFICIAL;
    }
  } else if (manualConfirmation) {
    action = ACTIONS.HOLD_WITH_CONFIRMATION;
  } else {
    action = agency ? ACTIONS.VERIFY_OFFICIAL : ACTIONS.NO_DATA;
  }

  const advisory = buildAdvisory(action, { reopeningConflict, hasManual: Boolean(manualConfirmation) });

  return {
    slotId,
    venueName: identity.venueName,
    date: identity.date,
    timeRange: identity.timeRange,
    officialStatus,
    capacity,
    manualConfirmation,
    conflicts,
    reminders,
    action,
    advisory,
  };
}

function buildAdvisory(action, { reopeningConflict, hasManual }) {
  switch (action) {
    case ACTIONS.HOLD_WITH_CONFIRMATION:
      return reopeningConflict
        ? '凭人工确认保留团体行程；官方关闭时段不对外开放，代理可订信息忽略，确认一旦过期须立即重新安排'
        : '凭人工确认保留行程，并在确认过期前完成落实';
    case ACTIONS.RESCHEDULE:
      return hasManual
        ? '人工确认已失效，请联系馆方重新确认或改约其他时段'
        : '该时段官方关闭且无有效人工确认，请重新安排行程';
    case ACTIONS.BOOKABLE:
      return '官方开放且代理有余位，可正常预订；出行前仍需复核官方状态';
    case ACTIONS.FULL:
      return '官方开放但代理库存已满，可登记候补或改约邻近时段';
    case ACTIONS.VERIFY_OFFICIAL:
      return '官方状态缺失，代理库存与人工确认都不足以单独决定行程，先向馆方核实';
    default:
      return '暂无可用来源数据，需重新采集后再排程';
  }
}

export function buildItinerary(records, { now = new Date(), expiryWarningMs = DEFAULT_EXPIRY_WARNING_MS } = {}) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.slotId)) groups.set(record.slotId, []);
    groups.get(record.slotId).push(record);
  }
  const entries = [...groups.keys()]
    .sort()
    .map((slotId) => buildEntry(slotId, groups.get(slotId), now, expiryWarningMs));
  return {
    generatedAt: new Date(now).toISOString(),
    expiryWarningMs,
    entries,
  };
}

function renderSection(entry) {
  const lines = [];
  if (entry.officialStatus) {
    const o = entry.officialStatus;
    const statusText = o.status === 'closed' ? `关闭（${o.reason ?? '原因未注明'}）` : '开放';
    lines.push(`  官方状态: ${statusText} · 来源 ${o.source}`);
  } else {
    lines.push('  官方状态: 无记录（状态未知，不能视为开放）');
  }

  if (entry.capacity) {
    const c = entry.capacity;
    const capacityText = c.bookable
      ? `可订，余位 ${c.seatsAvailable}/${c.capacity}`
      : `不可订，余位 ${c.seatsAvailable}/${c.capacity}`;
    lines.push(`  代理容量: ${capacityText} · 来源 ${c.source}`);
  } else {
    lines.push('  代理容量: 无记录');
  }

  if (entry.manualConfirmation) {
    const m = entry.manualConfirmation;
    lines.push(
      `  人工确认: ${describeManual(m.state)} · ${m.confirmedBy}，确认于 ${m.confirmedAt ?? '未知时间'}，有效期至 ${m.expiresAt}`
      + `${m.note ? ` · 备注：${m.note}` : ''} · 来源 ${m.source}`,
    );
  } else {
    lines.push('  人工确认: 无记录');
  }

  for (const conflict of entry.conflicts) {
    lines.push(`  冲突: ${conflict.message}`);
  }
  for (const reminder of entry.reminders) {
    const level = reminder.severity === 'warning' ? '告警' : '提示';
    lines.push(`  提醒[${level}]: ${reminder.message}`);
  }
  return lines;
}

export function renderItinerary(itinerary) {
  const lines = [`行程单（生成于 ${itinerary.generatedAt}）`];
  for (const entry of itinerary.entries) {
    lines.push(`[${entry.slotId}] ${entry.venueName} ${entry.date} ${entry.timeRange}`);
    lines.push(...renderSection(entry));
    lines.push(`  建议: ${ACTION_LABELS[entry.action]} —— ${entry.advisory}`);
  }
  return lines.join('\n');
}
