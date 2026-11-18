/**
 * 按“时段 + 渠道”分轨存储。
 * 同一时段的官方状态、代理容量、人工确认各自独立成轨，
 * 任何渠道都不会因为更新时间或修订号较新而覆盖另一渠道的记录。
 */
export class RecordStore {
  #records = new Map();

  static keyFor(slotId, channel) {
    return `${slotId}:${channel}`;
  }

  save(record) {
    if (!record.slotId || !record.channel) {
      throw new Error('存储记录缺少 slotId 或 channel');
    }
    const key = RecordStore.keyFor(record.slotId, record.channel);
    const previous = this.#records.get(key);
    // 仅在修订号严格增大时更新：同修订号重放不得静默替换既有记录，
    // 跨渠道记录键不同，天然互不覆盖。
    if (!previous || record.revision > previous.revision) {
      this.#records.set(key, structuredClone(record));
    }
    return structuredClone(this.#records.get(key));
  }

  list() {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  findBySlot(slotId) {
    return this.list().filter((record) => record.slotId === slotId);
  }
}
