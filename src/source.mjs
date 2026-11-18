import { readFile } from 'node:fs/promises';

export const CHANNELS = Object.freeze(['official', 'agency', 'manual']);

export async function readSource(path = new URL('../data/source.json', import.meta.url)) {
  const text = await readFile(path, 'utf8');
  const page = JSON.parse(text);
  if (!page.source || !page.channels || typeof page.channels !== 'object') {
    throw new Error('来源页缺少 source 或 channels');
  }
  for (const channel of CHANNELS) {
    if (!Array.isArray(page.channels[channel])) {
      throw new Error(`来源页缺少渠道数组: ${channel}`);
    }
  }
  return page;
}
