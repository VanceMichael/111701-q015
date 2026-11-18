import { CHANNELS } from './source.mjs';

const OFFICIAL_STATUSES = new Set(['open', 'closed']);

function requireText(record, field, channel) {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${channel} 渠道记录缺少 ${field}`);
  }
  return value.trim();
}

function toTimestamp(value, field, channel) {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${channel} 渠道记录的 ${field} 不是有效时间: ${String(value)}`);
  }
  return new Date(ms).toISOString();
}

function normalizeBase(record, channel, page) {
  const slotId = requireText(record, 'slotId', channel);
  return {
    source: page.source,
    channel,
    slotId,
    venueName: requireText(record, 'venueName', channel),
    date: requireText(record, 'date', channel),
    timeRange: requireText(record, 'timeRange', channel),
    revision: Number(record.revision ?? 0),
    observedAt: toTimestamp(record.observedAt ?? page.observedAt, 'observedAt', channel),
  };
}

function normalizeOfficial(record, page) {
  const base = normalizeBase(record, 'official', page);
  const status = requireText(record, 'status', 'official');
  if (!OFFICIAL_STATUSES.has(status)) {
    throw new Error(`official 渠道状态不被支持: ${status}`);
  }
  return {
    ...base,
    status,
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : null,
  };
}

function normalizeAgency(record, page) {
  if (typeof record.bookable !== 'boolean') {
    throw new Error('agency 渠道记录缺少布尔型 bookable');
  }
  const seatsAvailable = Number(record.seatsAvailable);
  const capacity = Number(record.capacity);
  if (!Number.isFinite(seatsAvailable) || !Number.isFinite(capacity)) {
    throw new Error('agency 渠道记录缺少数值型 seatsAvailable 或 capacity');
  }
  if (seatsAvailable < 0 || capacity < 0 || seatsAvailable > capacity) {
    throw new Error('agency 渠道容量数据不合法（需满足 0 <= 余位 <= 容量）');
  }
  return {
    ...normalizeBase(record, 'agency', page),
    bookable: record.bookable,
    seatsAvailable,
    capacity,
  };
}

function normalizeManual(record, page) {
  if (typeof record.confirmed !== 'boolean') {
    throw new Error('manual 渠道记录缺少布尔型 confirmed');
  }
  const expiresAt = toTimestamp(record.expiresAt, 'expiresAt', 'manual');
  if (!expiresAt) {
    throw new Error('manual 渠道记录缺少 expiresAt（人工确认必须带过期时间）');
  }
  return {
    ...normalizeBase(record, 'manual', page),
    confirmed: record.confirmed,
    confirmedBy: requireText(record, 'confirmedBy', 'manual'),
    confirmedAt: toTimestamp(record.confirmedAt, 'confirmedAt', 'manual'),
    expiresAt,
    note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : null,
  };
}

const NORMALIZERS = {
  official: normalizeOfficial,
  agency: normalizeAgency,
  manual: normalizeManual,
};

/**
 * 把来源页按渠道展开为统一信封记录。
 * 三类记录（官方状态 / 代理容量 / 人工确认）只规整、不合并，
 * 渠道边界在信封的 channel 字段上显式保留。
 */
export function normalizePage(page) {
  const records = [];
  for (const channel of CHANNELS) {
    for (const raw of page.channels[channel]) {
      records.push(NORMALIZERS[channel](raw, page));
    }
  }
  return records;
}
