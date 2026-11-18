import { normalizePage } from './adapter.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';
import { buildItinerary, renderItinerary } from './itinerary.mjs';

export async function collect({
  source = readSource,
  store = new RecordStore(),
  now = new Date(),
  expiryWarningMs,
} = {}) {
  const page = await source();
  const records = normalizePage(page).map((record) => store.save(record));
  const itinerary = buildItinerary(store.list(), { now, ...(expiryWarningMs ? { expiryWarningMs } : {}) });
  return {
    source: page.source,
    observedAt: page.observedAt ?? null,
    records,
    itinerary,
    store,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        source: result.source,
        observedAt: result.observedAt,
        recordCount: result.records.length,
        itinerary: result.itinerary,
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log(renderItinerary(result.itinerary));
}
