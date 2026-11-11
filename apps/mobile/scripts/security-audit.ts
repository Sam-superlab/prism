// Read-only application audit reproduction. Uses isolated memory SQL and temporary Web session state.
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../api/src/app';
import { loadConfig } from '../../api/src/config';
import { createDatabase } from '../../../packages/database/src/index';
import { NextRequest } from '../../web/node_modules/next/server.js';
import {
  createServerSession,
  deleteServerSession,
  seal,
  sessionFor,
  SESSION_COOKIE,
} from '../../web/lib/server-auth';

async function main() {
  const db = await createDatabase({ memory: true });
  const app = await buildApp({
    db,
    config: loadConfig({
      PRISM_AUTH_MODE: 'development',
      PRISM_DATA_DIR: await mkdtemp(join(tmpdir(), 'prism-audit-')),
    }),
  });
  const request = async (
    path: string,
    method = 'GET',
    payload?: any,
    version?: string,
    key = randomUUID(),
  ) => {
    const headers: Record<string, string> = { 'Idempotency-Key': key };
    if (version) headers['If-Match'] = `"${version}"`;
    const r = await app.inject({ method: method as any, url: `/api/v1${path}`, payload, headers });
    return { status: r.statusCode, body: r.statusCode === 204 ? null : r.json() };
  };
  const device = randomUUID();
  try {
    await request('/devices', 'POST', { id: device, name: 'audit', platform: 'ios' });
    const knowledgeKey = randomUUID(),
      knowledgeId = randomUUID();
    const createBody = { id: knowledgeId, title: 'Original', type: 'note', content: 'content' };
    const knowledge = (await request('/knowledge-items', 'POST', createBody, undefined, knowledgeKey)).body;
    const childKey = randomUUID();
    const mixed = await request('/sync/push', 'POST', {
      device_id: device,
      operations: [
        {
          client_operation_id: knowledgeKey,
          entity_id: knowledgeId,
          operation: 'knowledge.create',
          payload: createBody,
        },
        {
          client_operation_id: childKey,
          entity_id: knowledgeId,
          operation: 'knowledge.update',
          base_version: knowledge.version,
          depends_on_operation_id: knowledgeKey,
          payload: { title: 'After dependency', base_snapshot: knowledge },
        },
      ],
    });
    const card = (
      await request(`/knowledge-items/${knowledgeId}/cards`, 'POST', {
        id: randomUUID(),
        card_type: 'statement',
        prompt: 'Recall',
        answer: 'Answer',
      })
    ).body;
    const reviewKey = randomUUID();
    const review = {
      card_id: card.id,
      device_id: device,
      rating: 'good',
      reviewed_at: new Date().toISOString(),
      duration_ms: 1000,
      base_version: card.version,
      idempotency_key: reviewKey,
    };
    const direct = await request('/review/events', 'POST', review, undefined, reviewKey);
    const replay = await request('/sync/push', 'POST', {
      device_id: device,
      operations: [
        {
          client_operation_id: reviewKey,
          entity_id: card.id,
          operation: 'review.rate',
          base_version: card.version,
          payload: review,
        },
      ],
    });
    const session = (
      await request('/fitness/sessions', 'POST', { id: randomUUID(), started_at: new Date().toISOString() })
    ).body;
    const changed = (
      await request(`/fitness/sessions/${session.id}`, 'PATCH', { notes: 'Other edit' }, session.version)
    ).body;
    const completion = (
      await request('/sync/push', 'POST', {
        device_id: device,
        operations: [
          {
            client_operation_id: randomUUID(),
            entity_id: session.id,
            operation: 'workout.session.complete',
            base_version: session.version,
            payload: { ended_at: new Date().toISOString(), complete_planned_task: false },
          },
        ],
      })
    ).body.results[0];
    const conflict = (await request(`/sync/conflicts/${completion.conflict_id}`)).body;
    const resolved = await request(
      `/sync/conflicts/${conflict.id}/resolve`,
      'POST',
      { resolution: 'apply_client', current_entity_version: changed.version },
      conflict.version,
    );
    const after = (await request(`/fitness/sessions/${session.id}`)).body;
    console.log(
      JSON.stringify(
        {
          restCreateThenDependentSync: mixed.body.results.map((r: any) => ({
            status: r.status,
            error: r.error?.error?.code,
          })),
          directReviewStatus: direct.status,
          reviewRestToSync: replay.body.results.map((r: any) => ({
            status: r.status,
            error: r.error?.error?.code,
          })),
          applyCompletionResolutionStatus: resolved.status,
          actualSessionStatusAfterApply: after.status,
        },
        null,
        2,
      ),
    );
    const snapshot = (await request('/sync/snapshots', 'POST', { device_id: device })).body;
    const snapshotPage = (await request(`/sync/snapshots/${snapshot.id}/records`)).body;
    // Simulate the signed high-water mark a real client retains when an older backup is restored.
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_sync_state SET revision=0 WHERE user_id=$1', [app.prism.config.userId]),
    );
    const ahead = await request(`/sync/pull?cursor=${encodeURIComponent(snapshotPage.resume_sync_cursor)}`);
    console.log(
      JSON.stringify(
        {
          restoredBehindSignedCursorStatus: ahead.status,
          restoredBehindSignedCursorCode: ahead.body?.error?.code,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    await db.close();
  }

  const original = {
    fetch: globalThis.fetch,
    mode: process.env.NODE_ENV,
    client: process.env.PRISM_OIDC_CLIENT_ID,
    redis: process.env.REDIS_URL,
  };
  process.env.NODE_ENV = 'test';
  process.env.PRISM_OIDC_CLIENT_ID = 'audit-client';
  delete process.env.REDIS_URL;
  let release!: () => void, called!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    called = r;
  });
  globalThis.fetch = async () => {
    called();
    await gate;
    return new Response(
      JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  let req: NextRequest | undefined;
  try {
    const saved = await createServerSession({
      accessToken: 'expired',
      refreshToken: 'refresh',
      expiresAt: Date.now() - 1000,
      tokenEndpoint: 'https://issuer.invalid/token',
    });
    req = new NextRequest('http://localhost:3000/api/v1/me', {
      headers: { cookie: `${SESSION_COOKIE}=${seal({ id: saved.id })}` },
    });
    const refresh = sessionFor(req);
    await started;
    await deleteServerSession(req);
    release();
    await refresh;
    const replay = await sessionFor(req);
    console.log(
      JSON.stringify({ logoutDuringRefreshOldCookieStillAuthorized: Boolean(replay.session) }, null, 2),
    );
  } finally {
    release();
    if (req) await deleteServerSession(req);
    globalThis.fetch = original.fetch;
    for (const [key, value] of [
      ['NODE_ENV', original.mode],
      ['PRISM_OIDC_CLIENT_ID', original.client],
      ['REDIS_URL', original.redis],
    ])
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
