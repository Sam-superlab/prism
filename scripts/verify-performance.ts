import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildApp } from '../apps/api/src/app';
import { loadConfig } from '../apps/api/src/config';
import { createTestPostgres } from '../apps/api/src/testing';

const fixture = await createTestPostgres();
const app = await buildApp({
  db: fixture.db,
  config: loadConfig({
    PRISM_AUTH_MODE: 'development',
    PRISM_USER_ID: fixture.userId,
    PRISM_ALLOWED_SUBJECT: fixture.subject,
  }),
});
try {
  for (let n = 0; n < 100; n++) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge-items',
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        id: randomUUID(),
        title: `Performance fixture ${n}`,
        type: 'note',
        content: 'Test-only mathematical note. '.repeat(40),
      },
    });
    if (r.statusCode !== 201) throw new Error(`Performance fixture failed: ${r.statusCode}`);
  }
  const samples: number[] = [];
  for (let n = 0; n < 100; n++) {
    const start = performance.now();
    const r = await app.inject({ method: 'GET', url: '/api/v1/knowledge-items?limit=50' });
    if (r.statusCode !== 200 || r.json().items.length !== 50) throw new Error('Measured CRUD query failed');
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const report = {
    executed_at: new Date().toISOString(),
    status: 'passed',
    database: 'PostgreSQL 17, non-owner RLS role',
    fixture_notes: 100,
    note_bytes_approx: 1080,
    response_records: 50,
    samples: samples.length,
    median_ms: Number(samples[49].toFixed(2)),
    p95_ms: Number(samples[94].toFixed(2)),
    max_ms: Number(samples[99].toFixed(2)),
    target_p95_ms: 500,
    limitation:
      'Local Fastify injection includes authorization hooks, SQL, projection and serialization; excludes public TLS/network and production contention. Not an availability SLA.',
  };
  if (report.p95_ms > report.target_p95_ms)
    throw new Error(`Local CRUD P95 ${report.p95_ms}ms exceeds the target`);
  await mkdir('docs/verification', { recursive: true });
  await writeFile('docs/verification/performance.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await fixture.cleanup();
}
