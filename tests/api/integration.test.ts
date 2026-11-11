import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../../packages/database/src/index';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { createTestPostgres } from '../../apps/api/src/testing';
import { validateApiResponse } from '../../apps/api/src/contract';
let app: Awaited<ReturnType<typeof buildApp>>, db: Database;
let postgres: Awaited<ReturnType<typeof createTestPostgres>> | undefined;
const id = () => randomUUID();
async function post(path: string, body: any, key = id(), version?: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1' + path,
    headers: { 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) },
    payload: body,
  });
  expect(
    await validateApiResponse('POST', path, r.statusCode, r.statusCode === 204 ? null : r.json()),
    r.body,
  ).toEqual([]);
  return r;
}
async function patch(path: string, body: any, version: string, key = id()) {
  const r = await app.inject({
    method: 'PATCH',
    url: '/api/v1' + path,
    headers: { 'Idempotency-Key': key, 'If-Match': `"${version}"` },
    payload: body,
  });
  expect(
    await validateApiResponse('PATCH', path, r.statusCode, r.statusCode === 204 ? null : r.json()),
    r.body,
  ).toEqual([]);
  return r;
}
const get = async (path: string) => {
  const r = await app.inject({ method: 'GET', url: '/api/v1' + path });
  if (r.headers['content-type']?.includes('application/json'))
    expect(await validateApiResponse('GET', path, r.statusCode, r.json()), r.body).toEqual([]);
  return r;
};
beforeAll(async () => {
  if (process.env.PRISM_API_TEST_POSTGRES === '1') {
    postgres = await createTestPostgres();
    db = postgres.db;
  } else db = await createDatabase({ memory: true });
  const dir = await mkdtemp(join(tmpdir(), 'prism-api-test-'));
  app = await buildApp({
    db,
    config: loadConfig({
      PRISM_AUTH_MODE: 'development',
      PRISM_DATA_DIR: dir,
      ...(postgres ? { PRISM_USER_ID: postgres.userId, PRISM_ALLOWED_SUBJECT: postgres.subject } : {}),
    }),
  });
});
afterAll(async () => {
  await app?.close();
  if (postgres) await postgres.cleanup();
  else await db?.close();
});
describe('PRISM canonical backend', () => {
  it('serves initialized user with closed validation', async () => {
    expect((await get('/me')).statusCode).toBe(200);
    const r = await post('/knowledge-items', {
      id: id(),
      title: 'Test',
      type: 'theorem',
      content: 'x',
      user_id: id(),
    });
    expect(r.statusCode).toBe(422);
  });
  it('rejects malformed query values without server errors', async () => {
    expect((await get('/today?date=bad')).statusCode).toBe(422);
    expect((await get('/tasks?limit=-1')).statusCode).toBe(422);
    expect((await get('/tasks?project_id=bad')).statusCode).toBe(422);
  });
  it('preserves concurrent mathematical edits for explicit merge', async () => {
    const note = (
      await post('/knowledge-items', {
        id: id(),
        title: 'Concurrent theorem',
        type: 'theorem',
        content: 'Original',
      })
    ).json();
    const first = await patch(
      '/knowledge-items/' + note.id,
      { content: 'Version A', base_snapshot: note },
      note.version,
    );
    expect(first.statusCode, first.body).toBe(200);
    const stale = await patch(
      '/knowledge-items/' + note.id,
      { content: 'Version B', base_snapshot: note },
      note.version,
    );
    expect(stale.statusCode, stale.body).toBe(412);
    expect(stale.json().error.details.conflict_id).toBeTruthy();
    const conflict = (await get('/sync/conflicts/' + stale.json().error.details.conflict_id)).json();
    expect(conflict.base_payload.content).toBe('Original');
    expect(conflict.client_payload.content).toBe('Version B');
    expect(conflict.server_payload.content).toBe('Version A');
  });
  it('runs independent FSRS cards and exactly-once replay under duplicate concurrency', async () => {
    const k = await post('/knowledge-items', {
      id: id(),
      title: 'Nakayama lemma',
      type: 'lemma',
      content: 'M = IM implies M = 0 under the hypotheses.',
    });
    expect(k.statusCode, k.body).toBe(201);
    const item = k.json();
    const c1 = (
      await post(`/knowledge-items/${item.id}/cards`, {
        id: id(),
        card_type: 'statement',
        prompt: 'State',
        answer: 'Statement',
      })
    ).json();
    const c2 = (
      await post(`/knowledge-items/${item.id}/cards`, {
        id: id(),
        card_type: 'proof',
        prompt: 'Prove',
        answer: 'Proof',
      })
    ).json();
    expect(c1.fsrs_state).toBeTruthy();
    const device = (await post('/devices', { id: id(), name: 'Test phone', platform: 'ios' })).json();
    const key = id();
    const rating = {
      card_id: c1.id,
      device_id: device.id,
      rating: 'good',
      reviewed_at: new Date(Date.now() + 10).toISOString(),
      duration_ms: 2000,
      base_version: c1.version,
      idempotency_key: key,
    };
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/review/events', rating, key)),
    );
    for (const r of responses) expect(r.statusCode, r.body).toBe(201);
    expect(new Set(responses.map((r) => r.json().event.id)).size).toBe(1);
    expect((await get(`/review/cards/${c2.id}`)).json().version).toBe(c2.version);
    expect((await get(`/review/history?card_id=${c1.id}`)).json().items).toHaveLength(1);
    const staleKey = id();
    const stale = await post('/review/events', { ...rating, idempotency_key: staleKey }, staleKey);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.details.conflict_id).toBeTruthy();
    expect((await get(`/review/history?card_id=${c1.id}`)).json().items).toHaveLength(1);
    const changed = await post('/review/events', { ...rating, rating: 'easy' }, key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('preserves mathematical claim status when completing linked task and audits changes', async () => {
    const project = (await post('/research/projects', { id: id(), title: 'Strong Persistence' })).json();
    const object = (
      await post(`/research/projects/${project.id}/objects`, {
        id: id(),
        object_type: 'conjecture',
        title: 'Claim',
        content: '...',
        claim_status: 'conjecture',
      })
    ).json();
    const task = (
      await post('/tasks', {
        id: id(),
        title: 'Try a proof',
        source_type: 'research',
        project_id: project.id,
        research_object_id: object.id,
        estimated_minutes: 25,
      })
    ).json();
    const done = await post(
      `/tasks/${task.id}/complete`,
      { completed_at: new Date().toISOString() },
      id(),
      task.version,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect((await get(`/research/objects/${object.id}`)).json().claim_status).toBe('conjecture');
    expect(
      (await get(`/research/projects/${project.id}/timeline`)).json().items.length,
    ).toBeGreaterThanOrEqual(2);
    const invalid = await patch(
      `/research/objects/${object.id}`,
      { claim_status: 'proved', base_snapshot: object },
      object.version,
    );
    expect(invalid.statusCode).toBe(422);
  });
  it('logs normalized strength/cardio records and preserves completed workout history', async () => {
    const exercise = (
      await post('/fitness/exercises', {
        id: id(),
        name: 'Bench press',
        exercise_type: 'strength',
        measurement_unit: 'kg',
      })
    ).json();
    const template = (
      await post('/fitness/templates', {
        id: id(),
        title: 'Upper',
        activity_type: 'strength',
        exercises: [{ id: id(), exercise_id: exercise.id, position: 0, target_sets: 3, target_reps: 5 }],
      })
    ).json();
    const started = await post('/fitness/sessions', {
      id: id(),
      template_id: template.id,
      started_at: new Date().toISOString(),
    });
    expect(started.statusCode, started.body).toBe(201);
    const session = started.json();
    expect(session.exercises).toHaveLength(1);
    const set = await post(`/fitness/sessions/${session.id}/sets`, {
      id: id(),
      session_exercise_id: session.exercises[0].id,
      set_order: 0,
      entered_weight: 100,
      entered_weight_unit: 'lb',
      reps: 5,
      completed_at: new Date().toISOString(),
    });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.json().weight_kg).toBeCloseTo(45.359237);
    const cardio = await post(`/fitness/sessions/${session.id}/cardio`, {
      id: id(),
      activity_type: 'Run',
      duration_seconds: 600,
      distance: 1,
      distance_unit: 'mi',
    });
    expect(cardio.statusCode, cardio.body).toBe(201);
    expect(cardio.json().distance_meters).toBe(1609.344);
    const current = (await get(`/fitness/sessions/${session.id}`)).json();
    const completed = await post(
      `/fitness/sessions/${session.id}/complete`,
      { ended_at: new Date().toISOString() },
      id(),
      current.version,
    );
    expect(completed.statusCode, completed.body).toBe(200);
    const edited = await patch(`/fitness/sets/${set.json().id}`, { reps: 6 }, set.json().version);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await get(`/fitness/sessions/${session.id}`)).json().volume_kg_reps).toBeCloseTo(45.359237 * 6);
  });
  it('preserves DATE-only values and microsecond-safe pagination', async () => {
    const date = '2026-11-08',
      project = await post('/research/projects', { id: id(), title: 'Date-only', started_at: date });
    expect(project.json().started_at).toBe(date);
    const task = (
      await post('/tasks', {
        id: id(),
        title: 'Ordinary planned task',
        source_type: 'general',
        planned_date: date,
        estimated_minutes: 5,
      })
    ).json();
    const plan = await post('/daily-plans/generate', {
      plan_date: date,
      timezone: 'Europe/Budapest',
      as_of: '2026-11-08T10:00:00Z',
      capacity_minutes: 1440,
    });
    expect(plan.json().items.some((x: any) => x.task_id === task.id && x.status === 'planned')).toBe(true);
    const label = 'pagination-' + id(),
      ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const note = (
        await post('/knowledge-items', { id: id(), title: label, type: 'note', content: 'Page' })
      ).json();
      ids.push(note.id);
      await db.transaction(app.prism.config.userId, (sql) =>
        sql.query(
          "UPDATE knowledge_items SET created_at='2026-11-08T00:00:00.123456Z'::timestamptz+($2*interval '1 microsecond') WHERE id=$1",
          [note.id, n],
        ),
      );
    }
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; next_cursor: string | null } = (
        await get(
          '/knowledge-items?limit=1&q=' + label + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        )
      ).json();
      found.push(...page.items.map((x: any) => x.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(found)).toEqual(new Set(ids));
  });
  it('generates a capacity-aware plan and preserves pinned tasks', async () => {
    await post('/tasks', {
      id: id(),
      title: 'Pinned research',
      source_type: 'general',
      estimated_minutes: 120,
      pinned: true,
    });
    const date = '2026-11-08';
    const plan = await post('/daily-plans/generate', {
      plan_date: date,
      timezone: 'Europe/Budapest',
      as_of: '2026-11-08T10:00:00Z',
      capacity_minutes: 15,
    });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().overload_minutes).toBeGreaterThan(0);
    expect(plan.json().items.some((x: any) => x.pinned)).toBe(true);
    expect((await get('/today?date=' + date)).statusCode).toBe(200);
  });
  it('creates an atomic snapshot and syncs offline capture without duplicate entities', async () => {
    const device = (await post('/devices', { id: id(), name: 'Offline phone', platform: 'ios' })).json();
    const snapshot = await post('/sync/snapshots', { device_id: device.id });
    expect(snapshot.statusCode, snapshot.body).toBe(201);
    const page = (await get(`/sync/snapshots/${snapshot.json().id}/records`)).json();
    expect(page.resume_sync_cursor).toBeTruthy();
    const captureId = id(),
      operation = id();
    const batch = {
      device_id: device.id,
      operations: [
        {
          client_operation_id: operation,
          entity_id: captureId,
          operation: 'inbox.create',
          payload: { id: captureId, content: 'Offline observation' },
        },
      ],
    };
    const first = await post('/sync/push', batch);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().results[0].status).toBe('applied');
    const again = await post('/sync/push', batch);
    expect(again.json().results[0].status).toBe('duplicate');
    const changes = await get('/sync/pull?cursor=' + encodeURIComponent(page.resume_sync_cursor));
    expect(changes.statusCode, changes.body).toBe(200);
    expect(
      changes.json().batches.some((b: any) => b.changes.some((x: any) => x.entity_id === captureId)),
    ).toBe(true);
  });
  it('shares permanent receipts and dependency proofs across REST and sync transports', async () => {
    const device = (await post('/devices', { id: id(), name: 'Mixed transport', platform: 'ios' })).json();
    const key = id(),
      noteId = id(),
      payload = { id: noteId, title: 'Mixed transport note', type: 'note', content: 'Original' };
    const note = (await post('/knowledge-items', payload, key)).json();
    const update = id();
    const result = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: update,
          entity_id: noteId,
          operation: 'knowledge.update',
          base_version: note.version,
          depends_on_operation_id: key,
          payload: { content: 'After sync', base_snapshot: note },
        },
        { client_operation_id: key, entity_id: noteId, operation: 'knowledge.create', payload },
      ],
    });
    expect(result.json().results.find((x: any) => x.client_operation_id === key).status, result.body).toBe(
      'duplicate',
    );
    expect(result.json().results.find((x: any) => x.client_operation_id === update).status, result.body).toBe(
      'applied',
    );
    expect((await get('/knowledge-items/' + noteId)).json().content).toBe('After sync');
    const parent = id(),
      second = (
        await post(
          '/knowledge-items',
          { id: id(), title: 'Direct dependency', type: 'note', content: 'Before' },
          parent,
        )
      ).json();
    const onlyChild = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: second.id,
          operation: 'knowledge.update',
          base_version: second.version,
          depends_on_operation_id: parent,
          payload: { content: 'Parent need not be replayed', base_snapshot: second },
        },
      ],
    });
    expect(onlyChild.json().results[0].status, onlyChild.body).toBe('applied');
  });
  it('replays REST reviews through sync without double scheduling and unblocks later reviews', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Transport review', type: 'note', content: 'Recall' })
    ).json();
    const card = (
      await post('/knowledge-items/' + note.id + '/cards', {
        id: id(),
        card_type: 'custom',
        prompt: 'Q',
        answer: 'A',
      })
    ).json();
    const device = (await post('/devices', { id: id(), name: 'Review transport', platform: 'ios' })).json(),
      key = id(),
      next = id(),
      time = Date.now();
    const payload = {
      card_id: card.id,
      device_id: device.id,
      rating: 'good',
      reviewed_at: new Date(time).toISOString(),
      duration_ms: 100,
      base_version: card.version,
      idempotency_key: key,
    };
    expect((await post('/review/events', payload, key)).statusCode).toBe(201);
    const replay = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: key,
          entity_id: card.id,
          operation: 'review.rate',
          base_version: card.version,
          payload,
        },
        {
          client_operation_id: next,
          entity_id: card.id,
          operation: 'review.rate',
          base_version: card.version,
          depends_on_operation_id: key,
          payload: {
            ...payload,
            idempotency_key: next,
            reviewed_at: new Date(time + 100).toISOString(),
            depends_on_operation_id: key,
          },
        },
      ],
    });
    expect(replay.json().results[0].status, replay.body).toBe('duplicate');
    expect(replay.json().results[1].status, replay.body).toBe('applied');
    expect((await get('/review/history?card_id=' + card.id)).json().items).toHaveLength(2);
  });
  it('applies original delete and complete actions when explicitly resolving offline conflicts', async () => {
    const device = (await post('/devices', { id: id(), name: 'Conflict actions', platform: 'ios' })).json(),
      note = (
        await post('/knowledge-items', {
          id: id(),
          title: 'Delete conflict',
          type: 'note',
          content: 'Before',
        })
      ).json();
    const updated = (
      await patch(
        '/knowledge-items/' + note.id,
        { content: 'Server version', base_snapshot: note },
        note.version,
      )
    ).json();
    const remove = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: note.id,
          operation: 'knowledge.delete',
          base_version: note.version,
          payload: {},
        },
      ],
    });
    expect(remove.json().results[0].status).toBe('conflict');
    const conflict = (await get('/sync/conflicts/' + remove.json().results[0].conflict_id)).json();
    expect(
      (
        await post(
          '/sync/conflicts/' + conflict.id + '/resolve',
          { resolution: 'apply_client', current_entity_version: updated.version },
          id(),
          conflict.version,
        )
      ).statusCode,
    ).toBe(200);
    expect((await get('/knowledge-items/' + note.id)).statusCode).toBe(404);
    const session = (
      await post('/fitness/sessions', { id: id(), started_at: new Date(Date.now() - 1000).toISOString() })
    ).json();
    const edited = (
      await patch('/fitness/sessions/' + session.id, { notes: 'Server note' }, session.version)
    ).json();
    const finish = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: session.id,
          operation: 'workout.session.complete',
          base_version: session.version,
          payload: { ended_at: new Date().toISOString() },
        },
      ],
    });
    expect(finish.json().results[0].status).toBe('conflict');
    const finishConflict = (await get('/sync/conflicts/' + finish.json().results[0].conflict_id)).json();
    const resolved = await post(
      '/sync/conflicts/' + finishConflict.id + '/resolve',
      { resolution: 'apply_client', current_entity_version: edited.version },
      id(),
      finishConflict.version,
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await get('/fitness/sessions/' + session.id)).json().status).toBe('completed');
  });
  it('recovers after backup rollback and rejects old stream cursors even when revisions are reused', async () => {
    const device = (await post('/devices', { id: id(), name: 'Restore recovery', platform: 'ios' })).json();
    const snapshot = (await post('/sync/snapshots', { device_id: device.id })).json();
    expect(snapshot.schema_version).toBe('1');
    const initial = (await get('/sync/snapshots/' + snapshot.id + '/records')).json();
    await post('/inbox', { id: id(), content: 'Change before simulated restore' });
    const advanced = (
      await get('/sync/pull?cursor=' + encodeURIComponent(initial.resume_sync_cursor))
    ).json();
    const oldCursor = advanced.next_cursor;
    const head = (
      await db.transaction(app.prism.config.userId, (sql) =>
        sql.query('SELECT id,revision::text revision FROM user_sync_state WHERE user_id=$1', [
          app.prism.config.userId,
        ]),
      )
    ).rows[0];
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_sync_state SET revision=$2 WHERE user_id=$1', [
        app.prism.config.userId,
        String(BigInt(head.revision) - 1n),
      ]),
    );
    const ahead = await get('/sync/pull?cursor=' + encodeURIComponent(oldCursor));
    expect(ahead.statusCode, ahead.body).toBe(410);
    expect(ahead.json().error.code).toBe('SYNC_CURSOR_EXPIRED');
    expect(ahead.json().error.details.reason).toBe('CURSOR_AHEAD');
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_sync_state SET revision=$2 WHERE user_id=$1', [
        app.prism.config.userId,
        head.revision,
      ]),
    );
    const rotated = await app.prism.service.rotateSyncStream(app.prism.config.userId);
    expect(rotated.previous_generation).toBe(head.id);
    expect(rotated.generation).not.toBe(head.id);
    await post('/inbox', { id: id(), content: 'New stream advances past the old revision' });
    const old = await get('/sync/pull?cursor=' + encodeURIComponent(oldCursor));
    expect(old.statusCode, old.body).toBe(410);
    expect(old.json().error.details.reason).toBe('STREAM_RESET');
    const oldPage = await get('/sync/snapshots/' + snapshot.id + '/records');
    expect(oldPage.statusCode, oldPage.body).toBe(410);
    expect(oldPage.json().error.details.reason).toBe('STREAM_RESET');
    const fresh = (await post('/sync/snapshots', { device_id: device.id })).json();
    expect(fresh.schema_version).toBe('1');
    const page = (await get('/sync/snapshots/' + fresh.id + '/records')).json();
    expect((await get('/sync/pull?cursor=' + encodeURIComponent(page.resume_sync_cursor))).statusCode).toBe(
      200,
    );
    expect((await get('/sync/pull?cursor=not-a-valid-cursor')).statusCode).toBe(400);
    const forged = page.resume_sync_cursor.slice(0, -1) + (page.resume_sync_cursor.endsWith('A') ? 'B' : 'A');
    expect((await get('/sync/pull?cursor=' + encodeURIComponent(forged))).statusCode).toBe(400);
  });
  it('uses changed retention on the next review without silently moving existing due times', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Retention', type: 'note', content: 'Recall' })
    ).json();
    const card = (
      await post('/knowledge-items/' + note.id + '/cards', {
        id: id(),
        card_type: 'custom',
        prompt: 'Q',
        answer: 'A',
      })
    ).json();
    const prefs = (await get('/me/preferences')).json();
    expect((await patch('/me/preferences', { desired_retention: 0.95 }, prefs.version)).statusCode).toBe(200);
    expect((await get('/review/cards/' + card.id)).json().due_at).toBe(card.due_at);
    const device = (await post('/devices', { id: id(), name: 'Retention phone', platform: 'ios' })).json(),
      key = id();
    const reviewed = await post(
      '/review/events',
      {
        card_id: card.id,
        device_id: device.id,
        rating: 'good',
        reviewed_at: new Date().toISOString(),
        duration_ms: 100,
        base_version: card.version,
        idempotency_key: key,
      },
      key,
    );
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect(reviewed.json().card.scheduler_config.desired_retention).toBe(0.95);
    expect(reviewed.json().event.scheduler_config.id).not.toBe(card.scheduler_config.id);
  });
  it('synchronizes a complete offline workout with causal parent versions and no duplicate sets', async () => {
    const device = (await post('/devices', { id: id(), name: 'Workout phone', platform: 'ios' })).json();
    const exercise = (
      await post('/fitness/exercises', {
        id: id(),
        name: 'Offline row',
        exercise_type: 'strength',
        measurement_unit: 'kg',
      })
    ).json();
    const session = id(),
      sx = id(),
      set = id(),
      create = id(),
      actual = id(),
      log = id();
    const operations = [
      {
        client_operation_id: log,
        entity_id: set,
        operation: 'workout.set.create',
        depends_on_operation_id: actual,
        payload: {
          id: set,
          session_id: session,
          session_exercise_id: sx,
          set_order: 0,
          entered_weight: 40,
          entered_weight_unit: 'kg',
          reps: 8,
          completed_at: new Date().toISOString(),
        },
      },
      {
        client_operation_id: create,
        entity_id: session,
        operation: 'workout.session.create',
        payload: { id: session, started_at: new Date(Date.now() - 1000).toISOString() },
      },
      {
        client_operation_id: actual,
        entity_id: sx,
        operation: 'workout.exercise.create',
        depends_on_operation_id: create,
        payload: { id: sx, session_id: session, exercise_id: exercise.id, position: 0 },
      },
    ];
    const pushed = await post('/sync/push', { device_id: device.id, operations });
    expect(pushed.statusCode, pushed.body).toBe(200);
    for (const r of pushed.json().results) expect(r.status, JSON.stringify(r)).toBe('applied');
    const parent = pushed
      .json()
      .results.find((x: any) => x.client_operation_id === log)
      .records.find((x: any) => x.entity_id === session);
    expect(parent).toBeTruthy();
    const complete = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: session,
          operation: 'workout.session.complete',
          base_version: parent.entity_version,
          depends_on_operation_id: log,
          payload: { ended_at: new Date().toISOString() },
        },
      ],
    });
    expect(complete.json().results[0].status, complete.body).toBe('applied');
    const repeated = await post('/sync/push', { device_id: device.id, operations });
    for (const r of repeated.json().results) expect(r.status).toBe('duplicate');
    const current = (await get('/fitness/sessions/' + session)).json();
    expect(current.status).toBe('completed');
    expect(current.exercises).toHaveLength(1);
    expect(current.sets).toHaveLength(1);
    expect(current.volume_kg_reps).toBe(320);
  });
  it('keeps arXiv versions unique and digests only newly ingested versions', async () => {
    const now = new Date(),
      paper = {
        arxiv_id: '2611.99999',
        latest_version: 1,
        title: 'Test metadata fixture',
        abstract: 'Commutative algebra',
        authors: ['Fixture Author'],
        categories: ['math.AC'],
        published_at: now.toISOString(),
        updated_at: now.toISOString(),
        source_url: 'https://arxiv.org/abs/2611.99999',
        pdf_url: 'https://arxiv.org/pdf/2611.99999',
        relevance_score: 4,
        match_reasons: ['category:math.AC'],
      };
    const subscription = (
      await post('/arxiv/subscriptions', {
        id: id(),
        subscription_type: 'category',
        subscription_value: 'math.AC',
      })
    ).json();
    await post('/arxiv/subscriptions', {
      id: id(),
      subscription_type: 'category',
      subscription_value: 'math.NT',
    });
    const activePaper = {
      ...paper,
      arxiv_id: '2611.99997',
      categories: ['math.NT'],
      source_url: 'https://arxiv.org/abs/2611.99997',
      pdf_url: 'https://arxiv.org/pdf/2611.99997',
    };
    await app.prism.service.ingestPapers(app.prism.config.userId, [paper, activePaper], id());
    await app.prism.service.ingestPapers(app.prism.config.userId, [paper, activePaper], id());
    const feed = (await get('/arxiv/feed')).json();
    const fixture = feed.items.find((x: any) => x.paper.arxiv_id === paper.arxiv_id),
      active = feed.items.find((x: any) => x.paper.arxiv_id === activePaper.arxiv_id);
    expect(fixture.paper.versions).toHaveLength(1);
    expect(active.paper.versions).toHaveLength(1);
    expect(
      (await patch('/arxiv/subscriptions/' + subscription.id, { enabled: false }, subscription.version))
        .statusCode,
    ).toBe(200);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const tomorrow = new Date(now.getTime() + 86400000);
    const next = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
    await app.prism.service.dailyAutomation(app.prism.config.userId, 'digest', today);
    await app.prism.service.dailyAutomation(app.prism.config.userId, 'digest', next);
    const notifications = await db.transaction(app.prism.config.userId, (sql) =>
      sql.query(
        "SELECT payload FROM notification_events WHERE notification_type='digest' ORDER BY created_at",
      ),
    );
    expect(notifications.rows.find((x) => x.payload.date === today)!.payload.paper_ids).not.toContain(
      fixture.paper_id,
    );
    expect(notifications.rows.find((x) => x.payload.date === today)!.payload.paper_ids).toContain(
      active.paper_id,
    );
    expect(notifications.rows.find((x) => x.payload.date === next)!.payload.paper_ids).not.toContain(
      active.paper_id,
    );
    expect((await get('/arxiv/feed')).json().items.some((x: any) => x.paper_id === fixture.paper_id)).toBe(
      true,
    );
  });
  it('exposes push tokens only to the server worker and bounds failed delivery retries', async () => {
    app.prism.config.pushEncryptionKey = Buffer.alloc(32, 7).toString('base64');
    const token = 'ExpoPushToken[private-test-fixture]';
    const device = await post('/devices', {
      id: id(),
      name: 'Push phone',
      platform: 'ios',
      push_token: token,
    });
    expect(device.statusCode, device.body).toBe(201);
    expect(device.body).not.toContain(token);
    expect(device.json().push_registered).toBe(true);
    const pending = await app.prism.service.pendingNotifications();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].push_tokens).toContain(token);
    for (let n = 0; n < 5; n++)
      await app.prism.service.ackNotification(pending[0].id, app.prism.config.userId, 'failed');
    const status = await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('SELECT status,payload FROM notification_events WHERE id=$1', [pending[0].id]),
    );
    expect(status.rows[0].status).toBe('failed');
    expect(status.rows[0].payload.delivery_attempts).toBe(5);
  });
  it('soft deletes records with a repeatable204 receipt and exports all product data', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Temporary', type: 'note', content: 'x' })
    ).json();
    const key = id();
    const req = {
      method: 'DELETE' as const,
      url: '/api/v1/knowledge-items/' + note.id,
      headers: { 'Idempotency-Key': key, 'If-Match': `"${note.version}"` },
    };
    expect((await app.inject(req)).statusCode).toBe(204);
    expect((await app.inject(req)).statusCode).toBe(204);
    expect((await get('/knowledge-items/' + note.id)).statusCode).toBe(404);
    const created = await post('/exports', { formats: ['json', 'markdown'] });
    expect(created.statusCode, created.body).toBe(202);
    await app.prism.service.processExports();
    const exported = (await get('/exports/' + created.json().id)).json();
    expect(exported.status, JSON.stringify(exported)).toBe('ready');
    expect(exported.manifest.files.length).toBeGreaterThan(0);
    const zip = await get('/exports/' + exported.id + '/download');
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
  });
});
