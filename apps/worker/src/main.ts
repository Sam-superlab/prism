import { createDatabase } from '@prism/database';
import { loadConfig, PrismService } from '@prism/core';
import { startWorker } from './index';

const config = loadConfig();
if (!config.databaseUrl)
  throw new Error(
    'The separate Worker requires DATABASE_URL. Local PGlite uses the API process worker to avoid opening one data directory twice.',
  );
if (config.production && !process.env.REDIS_URL)
  throw new Error('Production Worker requires REDIS_URL for deployment-wide arXiv coordination.');
const db = await createDatabase({ url: config.databaseUrl, production: config.production });
const service = new PrismService(db, config);
await service.initialize();
const worker = startWorker({
  db,
  userId: config.userId,
  service,
  redisUrl: process.env.REDIS_URL,
  userAgent: process.env.PRISM_ARXIV_USER_AGENT,
  pushEnabled: process.env.PRISM_PUSH_ENABLED === 'true',
});
console.log(JSON.stringify({ component: 'worker', event: 'started', persistence: 'postgres' }));
await worker.tick();
// Retain this dedicated process even when no job is pending.
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    clearInterval(keepAlive);
    await worker.close();
    await db.close();
    process.exit(0);
  });
