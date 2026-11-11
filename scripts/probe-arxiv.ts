/** Optional public-source connectivity check; it never writes papers into personal data. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fetchRecentPapers } from '../apps/worker/src/arxiv';
let lastRequest = 0;
const withRateLimit = async <T>(action: () => Promise<T>): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastRequest + 3100 - Date.now())));
  lastRequest = Date.now();
  return action();
};
const started = Date.now();
let report: Record<string, unknown>;
try {
  const result = await fetchRecentPapers(
    [{ subscription_type: 'category', subscription_value: 'math.AC', enabled: true }],
    {
      withRateLimit,
      userAgent: process.env.PRISM_ARXIV_USER_AGENT,
    },
  );
  report = {
    executed_at: new Date().toISOString(),
    status: 'available',
    source: 'https://export.arxiv.org/api/query',
    category: 'math.AC',
    papers_in_overlap_window: result.papers.length,
    quarantined: result.quarantined.length,
    elapsed_ms: Date.now() - started,
    data_written: false,
    limitation:
      'Point-in-time public source connectivity; future ingestion depends on source availability and hosting network policy',
  };
} catch (error) {
  report = {
    executed_at: new Date().toISOString(),
    status: 'source_unavailable',
    source: 'https://export.arxiv.org/api/query',
    elapsed_ms: Date.now() - started,
    data_written: false,
    error: error instanceof Error ? error.message : String(error),
    limitation:
      'Source failure does not invalidate deterministic transport, normalization, retry and deduplication tests',
  };
}
await mkdir('docs/verification', { recursive: true });
await writeFile('docs/verification/arxiv-live.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
