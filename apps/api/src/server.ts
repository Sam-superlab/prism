import { buildApp } from './app';
import { startWorker } from '@prism/worker';
import { enableLocalWorkspaceBackup } from './local-workspace-backup';
import { ApiError } from './errors';
const app = await buildApp({ logger: true });
const recovery = app.prism.config.authMode === 'desktop' && process.env.PRISM_RECOVERY_PREVIEW === 'true';
if (recovery) {
  const localReads = /^\/api\/v1\/(?:me(?:\/preferences)?|today(?:\/shutdown)?|knowledge(?:-items|-subjects|-chapters|-relations)(?:\/.*)?|review\/(?:queue|history)|practice(?:\/.*)?|research\/(?:activity|projects|objects|question-links|knowledge-links|reference-knowledge-links|paper-links|references|reference-pdfs|attachments|pdf-annotations|text-annotations|library)(?:\/.*)?|graph|tasks(?:\/.*)?|arxiv\/(?:feed|subscriptions|saved)(?:\/.*)?)$/;
  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0];
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (!read || (path !== '/health' && (!localReads.test(path) ||
      /(?:%|\/\.{1,2}(?:\/|$)|\/open-access(?:\/|$)|\/library\/lookup(?:\/|$))/i.test(path))))
      throw new ApiError(403, 'FORBIDDEN', 'Recovered workspaces are read-only and offline.');
  });
}
if (!recovery && app.prism.config.authMode === 'desktop' && process.env.PRISM_WORKSPACE_BACKUP_DIR)
  enableLocalWorkspaceBackup(app.prism.db, process.env.PRISM_WORKSPACE_BACKUP_DIR, app.prism.config.userId);
let exportsRunning = false;
const exportTimer = recovery ? undefined : setInterval(() => {
  if (exportsRunning) return;
  exportsRunning = true;
  const accounts = app.prism.config.hostedAccounts ?? [{ userId: app.prism.config.userId }];
  void Promise.allSettled(accounts.map(({ userId }) => app.prism.service.processExports(userId)))
    .then((results) => {
      if (results.some((result) => result.status === 'rejected')) app.log.error('Account export processing failed');
    })
    .catch((error) => app.log.error(error))
    .finally(() => {
      exportsRunning = false;
    });
}, 1000);
exportTimer?.unref();
const worker =
  !recovery && app.prism.db.kind === 'pglite' && process.env.PRISM_WORKER_ENABLED !== 'false'
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
