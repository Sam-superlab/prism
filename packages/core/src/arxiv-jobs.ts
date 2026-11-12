import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '@prism/database';
import { localDate } from '@prism/shared-utils';
import { normalizeArxivCategory, type SubscriptionMatchRule } from './relevance';

export async function activeArxivSubscriptions(sql: Sql, userId: string) {
  const result = await sql.query(
    `SELECT subscription_type,subscription_value,enabled,weight FROM arxiv_subscriptions
     WHERE user_id=$1 AND enabled AND deleted_at IS NULL ORDER BY subscription_type,subscription_value,weight`,
    [userId],
  );
  return (result.rows as SubscriptionMatchRule[]).flatMap((rule) => {
    if (rule.subscription_type !== 'category') return [rule];
    const value = normalizeArxivCategory(rule.subscription_value);
    return value ? [{ ...rule, subscription_value: value }] : [];
  });
}

export function arxivSubscriptionKey(subscriptions: SubscriptionMatchRule[]) {
  const rules = subscriptions
    .map((rule) => JSON.stringify([rule.subscription_type, rule.subscription_value, rule.weight ?? 1]))
    .sort();
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

/** The API and worker share this queue so a manual refresh and a scheduled run can use the same job. */
export async function enqueueArxivIngestion(sql: Sql, userId: string, manual: boolean) {
  // Serialize competing enqueue requests. Do not hold this lock while fetching arXiv.
  const user = (
    await sql.query('SELECT timezone FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId])
  ).rows[0];
  if (!user) return null;
  const subscriptions = await activeArxivSubscriptions(sql, userId);
  if (!subscriptions.length) return null;
  const date = localDate(new Date(), user.timezone);
  const subscriptionKey = arxivSubscriptionKey(subscriptions);
  const prior = (
    await sql.query(
      `SELECT * FROM automation_jobs WHERE user_id=$1 AND job_type='arxiv_ingest' AND deleted_at IS NULL
     AND payload->>'subscription_key'=$2 AND (
       (status IN('pending','running','failed') AND (attempts<5 OR (status='running' AND lease_expires_at>=now()))
        AND (payload->>'local_date'=$3 OR payload->>'manual'='true')
        AND (NOT $4::boolean OR payload->>'manual'='true'))
       OR (status='succeeded' AND NOT COALESCE((payload->>'skipped_stale')::boolean,false)
           AND CASE WHEN $4::boolean THEN finished_at>=now()-interval '1 minute' ELSE payload->>'local_date'=$3 END)
       OR (status='dead' AND (scheduled_at>now() OR (NOT $4::boolean AND payload->>'local_date'=$3)))
     ) ORDER BY created_at DESC LIMIT 1`,
      [userId, subscriptionKey, date, manual],
    )
  ).rows[0];
  if (prior) return prior;
  const id = randomUUID();
  const dedupe = `arxiv_ingest:${id}`;
  return (
    (
      await sql.query(
        `INSERT INTO automation_jobs(id,user_id,job_type,scheduled_at,idempotency_key,payload)
     VALUES($1,$2,'arxiv_ingest',GREATEST(now(), (SELECT max(scheduled_at) FROM automation_jobs
       WHERE user_id=$2 AND job_type='arxiv_ingest' AND deleted_at IS NULL AND status IN('failed','dead')
       AND (payload->>'subscription_key'=$5 OR error_message IN('arXiv HTTP 429','arXiv HTTP 503')))),
       $3,$4::jsonb) RETURNING *`,
        [
          id,
          userId,
          dedupe,
          JSON.stringify({ local_date: date, subscription_key: subscriptionKey, manual }),
          subscriptionKey,
        ],
      )
    ).rows[0] ?? null
  );
}
