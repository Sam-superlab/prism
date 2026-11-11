import { randomUUID } from 'node:crypto';
import { Queue, Worker as QueueWorker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Database, Row, Sql } from '@prism/database';
import { inQuietHours, localDate, nextLocalTime } from '@prism/shared-utils';
import { ArxivFetchError, fetchRecentPapers, type RankedPaper, type Subscription } from './arxiv';
export * from './arxiv';

export interface WorkerBackend {
  ingestPapers(userId: string, papers: RankedPaper[], idempotencyKey: string): Promise<unknown>;
  dailyAutomation(
    userId: string,
    kind: 'digest' | 'plan' | 'shutdown',
    date: string,
    paperIds?: string[],
  ): Promise<unknown>;
  pendingNotifications(): Promise<Row[]>;
  ackNotification(id: string, userId: string, status: string): Promise<unknown>;
}
export interface WorkerOptions {
  db: Database;
  userId: string;
  service: WorkerBackend;
  redisUrl?: string;
  intervalMs?: number;
  fetch?: typeof fetch;
  userAgent?: string;
  pushEnabled?: boolean;
  queueName?: string;
  logger?: (record: Record<string, unknown>) => void;
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startWorker(options: WorkerOptions) {
  const { db, userId, service } = options;
  const log = options.logger ?? ((record) => console.log(JSON.stringify({ component: 'worker', ...record })));
  const redis = options.redisUrl
    ? new Redis(options.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 })
    : undefined;
  const consumerRedis = redis?.duplicate({ maxRetriesPerRequest: null });
  const queueName = options.queueName ?? process.env.PRISM_QUEUE_NAME ?? `prism-${userId}-jobs`;
  const queue = redis ? new Queue(queueName, { connection: redis as never }) : undefined;
  const abort = new AbortController();
  const remoteFetch: typeof fetch = (input, init) =>
    (options.fetch ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
    });
  let stopped = false,
    ticking = false,
    lastArxivRequest = 0;
  let rateTail: Promise<unknown> = Promise.resolve();

  const withRateLimit = <T>(action: () => Promise<T>): Promise<T> => {
    const result = rateTail.then(async () => {
      const token = randomUUID();
      let acquired = false;
      if (redis) {
        while (!stopped) {
          if (await redis.set('prism:arxiv:connection', token, 'PX', 60000, 'NX')) {
            acquired = true;
            break;
          }
          await wait(1000);
        }
      }
      try {
        if (stopped) throw new Error('Worker stopping');
        const previous = redis ? Number((await redis.get('prism:arxiv:last-start')) ?? 0) : lastArxivRequest;
        await wait(Math.max(0, previous + 3100 - Date.now()));
        if (stopped) throw new Error('Worker stopping');
        lastArxivRequest = Date.now();
        if (redis) await redis.set('prism:arxiv:last-start', String(lastArxivRequest), 'EX', 120);
        return await action();
      } finally {
        if (redis && acquired)
          await redis.eval(
            "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
            1,
            'prism:arxiv:connection',
            token,
          );
      }
    });
    rateTail = result.catch(() => undefined);
    return result;
  };

  const context = async (sql: Sql) => {
    const user = (await sql.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]))
      .rows[0];
    const preferences = (await sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [userId]))
      .rows[0];
    if (!user || !preferences) throw new Error('Worker user not initialized');
    const subscriptions = (
      await sql.query(
        'SELECT * FROM arxiv_subscriptions WHERE user_id=$1 AND enabled AND deleted_at IS NULL',
        [userId],
      )
    ).rows as Subscription[];
    return { user, preferences, subscriptions };
  };

  async function enqueue(kind: string, date: string, scheduledAt: string) {
    const dedupe = `${kind}:${date}:v1`;
    await db.transaction(userId, async (sql) => {
      const conflict =
        kind === 'arxiv_ingest'
          ? 'DO NOTHING'
          : `DO UPDATE SET scheduled_at=EXCLUDED.scheduled_at,payload=EXCLUDED.payload,updated_at=now(),version=automation_jobs.version+1
        WHERE automation_jobs.status='pending' AND automation_jobs.scheduled_at IS DISTINCT FROM EXCLUDED.scheduled_at`;
      await sql.query(
        `INSERT INTO automation_jobs(id,user_id,job_type,scheduled_at,idempotency_key,payload)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(user_id,idempotency_key) ${conflict}`,
        [randomUUID(), userId, kind, scheduledAt, dedupe, JSON.stringify({ local_date: date })],
      );
    });
  }

  async function execute(jobId: string) {
    const job = await db.transaction(userId, async (sql) => {
      const claim = await sql.query(
        `SELECT * FROM automation_jobs WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
        AND job_type IN('arxiv_ingest','digest','plan','shutdown')
        AND attempts<5 AND scheduled_at<=now() AND (status IN('pending','failed') OR (status='running' AND lease_expires_at<now())) FOR UPDATE SKIP LOCKED`,
        [jobId, userId],
      );
      if (!claim.rows[0]) return null;
      return (
        await sql.query(
          `UPDATE automation_jobs SET status='running',attempts=attempts+1,started_at=now(),lease_expires_at=now()+interval '5 minutes',updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
          [jobId],
        )
      ).rows[0];
    });
    if (!job) return;
    log({ event: 'job_started', job_id: job.id, job_type: job.job_type, attempt: job.attempts });
    // Extending the lease protects longer arXiv pagination without holding SQL locks.
    const heartbeat = setInterval(() => {
      void db
        .transaction(userId, (sql) =>
          sql.query(
            "UPDATE automation_jobs SET lease_expires_at=now()+interval '5 minutes' WHERE id=$1 AND status='running'",
            [jobId],
          ),
        )
        .catch((error) => log({ event: 'heartbeat_error', job_id: jobId, message: String(error) }));
    }, 60000);
    heartbeat.unref();
    try {
      const ctx = await db.transaction(userId, context);
      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      if (payload.local_date !== localDate(new Date(), ctx.user.timezone)) {
        await db.transaction(userId, (sql) =>
          sql.query(
            "UPDATE automation_jobs SET status='succeeded',finished_at=now(),lease_expires_at=NULL,payload=payload||'{\"skipped_stale\":true}'::jsonb WHERE id=$1",
            [jobId],
          ),
        );
        log({ event: 'stale_schedule_skipped', job_id: jobId });
        return;
      }
      if (job.job_type === 'arxiv_ingest') {
        if (!Array.isArray(payload.papers)) {
          const previous = await db.transaction(
            userId,
            async (sql) =>
              (
                await sql.query(
                  `SELECT max(finished_at) finished FROM automation_jobs
            WHERE user_id=$1 AND job_type='arxiv_ingest' AND status='succeeded' AND coalesce((payload->>'skipped_stale')::boolean,false)=false`,
                  [userId],
                )
              ).rows[0]?.finished,
          );
          const since = previous ? new Date(new Date(previous).getTime() - 7 * 86400000) : undefined;
          const result = await fetchRecentPapers(ctx.subscriptions, {
            fetch: remoteFetch,
            userAgent: options.userAgent,
            withRateLimit,
            since,
          });
          payload.papers = result.papers;
          payload.quarantined = result.quarantined;
          // Freeze an ingested command across retries: source updates cannot change an already committed idempotency hash.
          await db.transaction(userId, (sql) =>
            sql.query('UPDATE automation_jobs SET payload=$2::jsonb WHERE id=$1', [
              job.id,
              JSON.stringify(payload),
            ]),
          );
        }
        await service.ingestPapers(userId, payload.papers, job.id);
        if (payload.quarantined?.length)
          log({
            event: 'arxiv_quarantine',
            job_id: job.id,
            count: payload.quarantined.length,
            reasons: payload.quarantined.slice(0, 10),
          });
      } else if (['digest', 'plan', 'shutdown'].includes(job.job_type)) {
        await service.dailyAutomation(userId, job.job_type, String(payload.local_date));
      }
      await db.transaction(userId, (sql) =>
        sql.query(
          "UPDATE automation_jobs SET status='succeeded',finished_at=now(),lease_expires_at=NULL,error_message=NULL,updated_at=now(),version=version+1 WHERE id=$1",
          [jobId],
        ),
      );
      log({ event: 'job_succeeded', job_id: jobId });
    } catch (error) {
      const delay = Math.max(
        error instanceof ArxivFetchError ? error.retryAfterMs : 0,
        Math.min(3600000, 5000 * 2 ** Number(job.attempts)),
      );
      await db.transaction(userId, (sql) =>
        sql.query(
          'UPDATE automation_jobs SET status=$2,error_message=$3,finished_at=now(),lease_expires_at=NULL,scheduled_at=$4,updated_at=now(),version=version+1 WHERE id=$1',
          [
            jobId,
            Number(job.attempts) >= 5 ? 'dead' : 'failed',
            error instanceof Error ? error.message : String(error),
            new Date(Date.now() + delay).toISOString(),
          ],
        ),
      );
      log({
        event: 'job_failed',
        job_id: jobId,
        attempt: job.attempts,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  const consumer = consumerRedis
    ? new QueueWorker(
        queueName,
        async (job) => {
          if (job.name === 'projection-invalidated') {
            log({ event: 'projection_invalidated', event_id: job.data.event_id });
            return;
          }
          await execute(String(job.data.id));
        },
        { connection: consumerRedis as never, concurrency: 1 },
      )
    : undefined;
  consumer?.on('error', (error) => log({ event: 'queue_error', message: error.message }));
  redis?.on('error', (error) => log({ event: 'redis_error', message: error.message }));

  async function deliverNotifications() {
    if (!options.pushEnabled) return;
    for (const notification of await service.pendingNotifications()) {
      if (stopped) return;
      const ctx = await db.transaction(userId, context);
      const prefs = ctx.preferences.notification_preferences;
      const digest = ctx.preferences.digest_preferences ?? {};
      if (notification.notification_type === 'digest' && digest.enabled === false) {
        await service.ackNotification(notification.id, userId, 'cancelled');
        continue;
      }
      const date = notification.payload?.date;
      if (
        notification.notification_type === 'digest' &&
        date &&
        Date.now() < Date.parse(nextLocalTime(date, digest.time ?? '08:00', ctx.user.timezone))
      )
        continue;
      if (
        !prefs?.push_enabled ||
        inQuietHours(
          new Date().toISOString(),
          ctx.user.timezone,
          prefs.quiet_start ?? '22:00',
          prefs.quiet_end ?? '08:00',
        )
      )
        continue;
      // Tokens are deliberately exposed only through this server-side callback, never sync/API projections.
      const targets: string[] = Array.isArray(notification.push_tokens) ? notification.push_tokens : [];
      if (!targets.length) continue;
      let failed = false;
      for (const target of targets) {
        if (!/^Expo(nent)?PushToken\[/.test(target)) {
          failed = true;
          continue;
        }
        const response = await remoteFetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            to: target,
            title: notification.payload?.title ?? 'PRISM',
            body: notification.payload?.body ?? 'Your daily digest is ready.',
            data: { notification_id: notification.id },
            sound: 'default',
          }),
        });
        const result = (await response.json()) as { data?: { status?: string } };
        if (!response.ok || result.data?.status !== 'ok') failed = true;
      }
      await service.ackNotification(
        notification.id,
        notification.user_id ?? userId,
        failed ? 'failed' : 'delivered',
      );
    }
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const { user, preferences, subscriptions } = await db.transaction(userId, context);
      const now = new Date(),
        date = localDate(now, user.timezone);
      const digest = preferences.digest_preferences ?? {},
        notifications = preferences.notification_preferences ?? {};
      if (subscriptions.length) await enqueue('arxiv_ingest', date, now.toISOString());
      if (digest.enabled !== false)
        await enqueue('digest', date, nextLocalTime(date, digest.time ?? '08:00', user.timezone));
      await enqueue('plan', date, nextLocalTime(date, '00:05', user.timezone));
      if (notifications.shutdown_reminder_time)
        await enqueue(
          'shutdown',
          date,
          nextLocalTime(date, notifications.shutdown_reminder_time, user.timezone),
        );
      const pending = await db.transaction(
        userId,
        async (sql) =>
          (
            await sql.query(
              `SELECT id FROM automation_jobs WHERE user_id=$1 AND deleted_at IS NULL AND attempts<5
        AND job_type IN('arxiv_ingest','digest','plan','shutdown')
        AND scheduled_at<=now() AND (status IN('pending','failed') OR(status='running' AND lease_expires_at<now())) ORDER BY scheduled_at,id LIMIT 20`,
              [userId],
            )
          ).rows,
      );
      for (const job of pending) {
        if (stopped) break;
        if (queue)
          await queue.add(
            'execute',
            { id: job.id },
            { jobId: job.id, removeOnComplete: true, removeOnFail: 100 },
          );
        else await execute(job.id);
      }
      await deliverNotifications();
      // Other transactional events currently invalidate query-derived projections; no derived cache is persisted.
      const events = await db.transaction(userId, async (sql) => {
        const result = await sql.query(
          `SELECT id,event_type FROM outbox_events WHERE user_id=$1 AND published_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
          [userId],
        );
        for (const event of result.rows)
          await sql.query(
            "UPDATE outbox_events SET lease_expires_at=now()+interval '1 minute',attempts=attempts+1 WHERE id=$1",
            [event.id],
          );
        return result.rows;
      });
      for (const event of events) {
        if (queue)
          await queue.add(
            'projection-invalidated',
            { event_id: event.id },
            { jobId: event.id, removeOnComplete: true },
          );
        await db.transaction(userId, (sql) =>
          sql.query('UPDATE outbox_events SET published_at=now(),lease_expires_at=NULL WHERE id=$1', [
            event.id,
          ]),
        );
      }
    } catch (error) {
      log({ event: 'worker_tick_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      ticking = false;
    }
  }
  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs ?? 60000);
  timer.unref();
  const first = setTimeout(() => {
    void tick();
  }, 1000);
  first.unref();
  return {
    tick,
    async close() {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      clearTimeout(first);
      while (ticking) await wait(10);
      await Promise.race([consumer?.close(), wait(5000)]);
      await queue?.close();
      redis?.disconnect();
      consumerRedis?.disconnect();
    },
  };
}
