import { buildApp } from './app';
import { startWorker } from '@prism/worker';
const app = await buildApp({ logger: true });
let exportsRunning = false;
const exportTimer = setInterval(() => {
  if (exportsRunning) return;
  exportsRunning = true;
  void app.prism.service
    .processExports()
    .catch((error) => app.log.error(error))
    .finally(() => {
      exportsRunning = false;
    });
}, 1000);
exportTimer.unref();
const worker =
  app.prism.db.kind === 'pglite' && process.env.PRISM_WORKER_ENABLED !== 'false'
    ? startWorker({
        db: app.prism.db,
        userId: app.prism.config.userId,
        service: app.prism.service,
        redisUrl: process.env.REDIS_URL,
        pushEnabled: process.env.PRISM_PUSH_ENABLED === 'true',
        userAgent: process.env.PRISM_ARXIV_USER_AGENT,
        logger: (record) => app.log.info(record),
      })
    : undefined;
app.addHook('onClose', async () => {
  clearInterval(exportTimer);
  await worker?.close();
});
await app.listen({ host: app.prism.config.host, port: app.prism.config.port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
