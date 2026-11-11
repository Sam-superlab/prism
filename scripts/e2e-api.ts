/** Isolated browser-test backend. Metadata fixtures never enter the personal development database. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { createDatabase } from '../packages/database/src/index';
import { startWorker } from '../apps/worker/src/index';

const db = await createDatabase({ memory: true });
const dataDir = await mkdtemp(join(tmpdir(), 'prism-browser-test-'));
const config = loadConfig({
  PRISM_AUTH_MODE: 'development',
  PRISM_PORT: '4100',
  PRISM_DATA_DIR: dataDir,
  PRISM_WEB_ORIGIN: 'http://127.0.0.1:3100',
});
const app = await buildApp({ db, config });
const fixtureFetch: typeof fetch = async () => {
  const now = new Date().toISOString();
  return new Response(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2611.99998v1</id><title>PRISM E2E metadata fixture</title><summary>Test-only fixture about monomial ideals for validating the digest workflow.</summary><author><name>Test Fixture Author</name></author><category term="math.AC"/><published>${now}</published><updated>${now}</updated></entry></feed>`,
    { headers: { 'Content-Type': 'application/atom+xml' } },
  );
};
const worker = startWorker({
  db,
  userId: config.userId,
  service: app.prism.service,
  intervalMs: 1000,
  fetch: fixtureFetch,
  logger: () => {},
});
let exporting = false;
const exportsTimer = setInterval(() => {
  if (exporting) return;
  exporting = true;
  void app.prism.service.processExports().finally(() => {
    exporting = false;
  });
}, 250);
await app.listen({ host: '127.0.0.1', port: 4100 });
console.log('Isolated PRISM E2E API ready at http://127.0.0.1:4100');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    clearInterval(exportsTimer);
    await worker.close();
    await app.close();
    await db.close();
    process.exit(0);
  });
