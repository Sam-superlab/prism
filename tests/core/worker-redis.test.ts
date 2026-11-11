import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDatabase } from '../../packages/database/src/index';
import { PrismService, loadConfig } from '../../packages/core/src/index';
import { startWorker } from '../../apps/worker/src/index';
import { localDate, nextLocalTime } from '../../packages/shared-utils/src/index';

const redisUrl = process.env.PRISM_TEST_REDIS_URL;
const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
const { Redis } = require('ioredis');
const { Queue } = require('bullmq');
(redisUrl ? describe : describe.skip)('real Redis job delivery', () => {
  it('commits one scheduled ingestion, safely repeats ticks, and respects changed pending digest time', async () => {
    const db = await createDatabase({ memory: true });
    const config = loadConfig({ PRISM_AUTH_MODE: 'development' });
    const service = new PrismService(db, config);
    await service.initialize();
    const offset = 12 - new Date().getUTCHours();
    const timezone = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    await db.transaction(config.userId, async (sql) => {
      await sql.query('UPDATE users SET timezone=$2 WHERE id=$1', [config.userId, timezone]);
      await sql.query(
        'UPDATE user_preferences SET digest_preferences=\'{"enabled":true,"time":"23:50"}\'::jsonb WHERE user_id=$1',
        [config.userId],
      );
    });
    await service.execute({
      userId: config.userId,
      key: randomUUID(),
      method: 'POST',
      path: 'arxiv/subscriptions',
      body: { id: randomUUID(), subscription_type: 'category', subscription_value: 'math.AC' },
    });
    const queueName = `prism-test-${randomUUID()}`;
    let fetched = 0;
    const worker = startWorker({
      db,
      userId: config.userId,
      service,
      redisUrl,
      queueName,
      intervalMs: 60000,
      logger: () => {},
      fetch: async () => {
        fetched++;
        const now = new Date().toISOString();
        return new Response(
          `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2611.99997v1</id><title>Worker test fixture</title><summary>Monomial ideals</summary><author><name>Fixture Author</name></author><category term="math.AC"/><published>${now}</published><updated>${now}</updated></entry></feed>`,
        );
      },
    });
    try {
      await worker.tick();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const job = await db.transaction(config.userId, (sql) =>
          sql.query("SELECT status FROM automation_jobs WHERE job_type='arxiv_ingest'"),
        );
        if (job.rows[0]?.status === 'succeeded') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const papers = await db.transaction(config.userId, (sql) => sql.query('SELECT * FROM user_papers'));
      expect(papers.rows).toHaveLength(1);
      expect(fetched).toBe(1);
      await worker.tick();
      expect(fetched).toBe(1);
      // Choose the final minute of the local day so this pending job has not already executed.
      await db.transaction(config.userId, (sql) =>
        sql.query(
          'UPDATE user_preferences SET digest_preferences=\'{"enabled":true,"time":"23:59"}\'::jsonb WHERE user_id=$1',
          [config.userId],
        ),
      );
      await worker.tick();
      const digest = await db.transaction(config.userId, (sql) =>
        sql.query(
          "SELECT scheduled_at,status FROM automation_jobs WHERE job_type='digest' ORDER BY created_at DESC LIMIT 1",
        ),
      );
      expect(digest.rows[0].status).toBe('pending');
      expect(new Date(digest.rows[0].scheduled_at).toISOString()).toBe(
        new Date(nextLocalTime(localDate(new Date(), timezone), '23:59', timezone)).toISOString(),
      );
      const job = await db.transaction(config.userId, (sql) =>
        sql.query("SELECT attempts,status FROM automation_jobs WHERE job_type='arxiv_ingest'"),
      );
      expect(job.rows[0].status).toBe('succeeded');
      expect(job.rows[0].attempts).toBe(1);
    } finally {
      await worker.close();
      const connection = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
      const queue = new Queue(queueName, { connection: connection as never });
      await queue.obliterate({ force: true });
      await queue.close();
      connection.disconnect();
      await db.close();
    }
  }, 30000);
});
