import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { buildApp } from '../../api/src/app';
import { loadConfig } from '../../api/src/config';
import { createDatabase } from '../../../packages/database/src/index';
import { Api, ApiError, SyncEngine } from '../src/services/api';
import { LocalStore, type SqlDriver } from '../src/offline/store';
class Driver implements SqlDriver {
  sql: DatabaseSync;
  constructor(path = ':memory:') {
    this.sql = new DatabaseSync(path);
  }
  async exec(s: string) {
    this.sql.exec(s);
  }
  async run(s: string, ...v: (string | number | null)[]) {
    this.sql.prepare(s).run(...v);
  }
  async all<T>(s: string, ...v: (string | number | null)[]) {
    return this.sql.prepare(s).all(...v) as T[];
  }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    this.sql.exec('BEGIN');
    try {
      const r = await fn(this);
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }
}
it('syncs an entirely offline stable-ID workout and retries a lost review response exactly once', async () => {
  const db = await createDatabase({ memory: true });
  const config = loadConfig({
    PRISM_AUTH_MODE: 'development',
    PRISM_DATA_DIR: await mkdtemp(join(tmpdir(), 'prism-mobile-test-')),
  });
  const app = await buildApp({ db, config });
  let loseReviewResponse = false;
  const api = new Api('http://local/api/v1', async () => null, randomUUID);
  api.request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    version?: string,
    key?: string,
  ): Promise<T> => {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Idempotency-Key'] = key ?? randomUUID();
    if (version) headers['If-Match'] = `"${version}"`;
    const response = await app.inject({
      method: method as any,
      url: `/api/v1${path}`,
      headers,
      payload: body as any,
    });
    const payload = response.statusCode === 204 ? undefined : response.json();
    if (response.statusCode >= 400)
      throw new ApiError(
        response.statusCode,
        payload.error.code,
        payload.error.message,
        payload.error.details,
      );
    if (loseReviewResponse && path === '/sync/push') {
      loseReviewResponse = false;
      throw new Error('Response lost after server commit');
    }
    return payload as T;
  };
  const store = new LocalStore(new Driver());
  await store.initialize();
  const device = randomUUID();
  const sync = new SyncEngine(store, api, device, randomUUID);
  try {
    await sync.sync();
    const exercise = await api.request<any>('/fitness/exercises', 'POST', {
      id: randomUUID(),
      name: 'Bench',
      exercise_type: 'strength',
      measurement_unit: 'kg',
    });
    const template = await api.request<any>('/fitness/templates', 'POST', {
      id: randomUUID(),
      title: 'Upper',
      activity_type: 'strength',
      exercises: [
        {
          id: randomUUID(),
          exercise_id: exercise.id,
          position: 0,
          target_sets: 1,
          target_reps: 8,
          target_weight_kg: 25,
        },
      ],
    });
    const session = randomUUID(),
      actual = randomUUID(),
      set = randomUUID(),
      now = new Date().toISOString();
    const parentOp = randomUUID(),
      exerciseOp = randomUUID(),
      setOp = randomUUID(),
      attachOp = randomUUID();
    const projection = {
      id: session,
      version: '1',
      status: 'in_progress',
      started_at: now,
      template_id: null,
    };
    await store.enqueue({
      id: parentOp,
      operation: 'workout.session.create',
      entityType: 'workout_session',
      entityId: session,
      payload: { id: session, started_at: now, template_id: null },
      projected: projection,
      now,
    });
    await store.enqueue({
      id: exerciseOp,
      operation: 'workout.exercise.create',
      entityType: 'session_exercise',
      entityId: actual,
      payload: { id: actual, session_id: session, exercise_id: exercise.id, position: 0 },
      projected: { id: actual, session_id: session },
      dependsOn: parentOp,
      now,
    });
    await store.enqueue({
      id: setOp,
      operation: 'workout.set.create',
      entityType: 'workout_set',
      entityId: set,
      payload: {
        id: set,
        session_id: session,
        session_exercise_id: actual,
        set_order: 0,
        entered_weight: 25,
        entered_weight_unit: 'kg',
        reps: 8,
        completed_at: now,
      },
      projected: { id: set, session_id: session },
      dependsOn: exerciseOp,
      now,
    });
    await store.enqueue({
      id: attachOp,
      operation: 'workout.session.update',
      entityType: 'workout_session',
      entityId: session,
      payload: { template_id: template.id },
      projected: { ...projection, template_id: template.id },
      dependsOn: setOp,
      now,
    });
    await store.enqueue({
      id: randomUUID(),
      operation: 'workout.session.complete',
      entityType: 'workout_session',
      entityId: session,
      payload: { ended_at: now, complete_planned_task: false },
      projected: { ...projection, status: 'completed' },
      dependsOn: attachOp,
      now,
    });
    await sync.sync();
    expect(await store.status()).toEqual({ pending: 0, conflicts: 0, rejected: 0 });
    const saved = await api.request<any>(`/fitness/sessions/${session}`);
    expect(saved.status).toBe('completed');
    expect(saved.exercises).toHaveLength(1);
    expect(saved.sets).toHaveLength(1);
    expect(saved.sets[0].id).toBe(set);
    expect(saved.template_snapshot.title).toBe('Upper');
    expect(Number(saved.volume_kg_reps)).toBe(200);
    const knowledge = await api.request<any>('/knowledge-items', 'POST', {
      id: randomUUID(),
      title: 'Recall',
      type: 'theorem',
      content: '$x=x$',
    });
    const card = await api.request<any>(`/knowledge-items/${knowledge.id}/cards`, 'POST', {
      id: randomUUID(),
      card_type: 'statement',
      prompt: 'State it',
      answer: '$x=x$',
    });
    await sync.sync();
    const reviewOp = randomUUID();
    const reviewed = new Date().toISOString();
    await store.enqueue({
      id: reviewOp,
      operation: 'review.rate',
      entityType: 'review_card',
      entityId: card.id,
      payload: {
        card_id: card.id,
        device_id: device,
        rating: 'good',
        reviewed_at: reviewed,
        duration_ms: 1000,
        base_version: card.version,
        idempotency_key: reviewOp,
      },
      projected: { ...card, pending_review: true },
      now: reviewed,
    });
    loseReviewResponse = true;
    await expect(sync.sync()).rejects.toThrow('Response lost');
    expect((await store.pending())[0]?.client_operation_id).toBe(reviewOp);
    await sync.sync();
    expect(await store.pending()).toHaveLength(0);
    const history = await api.request<any>(`/review/history?card_id=${card.id}`);
    expect(history.items).toHaveLength(1);
    expect((await api.request<any>(`/fitness/sessions/${session}`)).sets).toHaveLength(1);
  } finally {
    await app.close();
    await db.close();
  }
}, 30000);

it('preserves acknowledged device history before a real server stream rollback and snapshot retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prism-restore-mobile-'));
  const db = await createDatabase({ memory: true });
  const config = loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DATA_DIR: directory });
  const app = await buildApp({ db, config });
  const file = join(directory, 'mobile.sqlite');
  const driver = new Driver(file);
  const store = new LocalStore(driver);
  await store.initialize();
  const device = randomUUID(),
    api = new Api('http://local/api/v1', async () => null, randomUUID);
  let dropSnapshotPage = false,
    snapshots = 0;
  api.request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    version?: string,
    key?: string,
  ): Promise<T> => {
    if (path === '/sync/snapshots' && method === 'POST') snapshots++;
    if (dropSnapshotPage && /^\/sync\/snapshots\/[^/]+\/records/.test(path)) {
      dropSnapshotPage = false;
      const id = path.split('/')[3]!;
      await db.transaction(config.userId, async (sql) => {
        await sql.query('ALTER TABLE sync_snapshots DISABLE TRIGGER USER');
        await sql.query('DELETE FROM sync_snapshots WHERE user_id=$1 AND id=$2', [config.userId, id]);
        await sql.query('ALTER TABLE sync_snapshots ENABLE TRIGGER USER');
      });
    }
    const headers: Record<string, string> = { 'Idempotency-Key': key ?? randomUUID() };
    if (version) headers['If-Match'] = `"${version}"`;
    const response = await app.inject({
      method: method as any,
      url: `/api/v1${path}`,
      headers,
      payload: body as any,
    });
    const data = response.statusCode === 204 ? undefined : response.json();
    if (response.statusCode >= 400)
      throw new ApiError(response.statusCode, data.error.code, data.error.message, data.error.details);
    return data as T;
  };
  const sync = new SyncEngine(store, api, device, randomUUID);
  let localClosed = false;
  try {
    const knowledge = await api.request<any>('/knowledge-items', 'POST', {
      id: randomUUID(),
      title: 'Keep my acknowledged history',
      type: 'theorem',
      content: '$x=x$',
    });
    const card = await api.request<any>(`/knowledge-items/${knowledge.id}/cards`, 'POST', {
      id: randomUUID(),
      card_type: 'statement',
      prompt: 'Recall',
      answer: '$x=x$',
    });
    await sync.sync();
    const reviewOp = randomUUID(),
      reviewedAt = new Date().toISOString();
    await store.enqueue({
      id: reviewOp,
      operation: 'review.rate',
      entityType: 'review_card',
      entityId: card.id,
      payload: {
        card_id: card.id,
        device_id: device,
        rating: 'good',
        reviewed_at: reviewedAt,
        duration_ms: 1000,
        base_version: card.version,
        idempotency_key: reviewOp,
      },
      projected: { ...card, pending_review: true },
      now: reviewedAt,
    });
    await sync.sync();
    expect((await api.request<any>(`/review/history?card_id=${card.id}`)).items).toHaveLength(1);
    const event = (await store.list('review_event'))[0]!;
    const captureOp = randomUUID(),
      captureId = randomUUID();
    await store.enqueue({
      id: captureOp,
      operation: 'inbox.create',
      entityType: 'inbox_entry',
      entityId: captureId,
      payload: { id: captureId, content: 'Still unsynced at restore time' },
      projected: { id: captureId, content: 'Still unsynced at restore time' },
      now: new Date().toISOString(),
    });

    // Isolated administrator fixture models an older backup: acknowledged review and receipts
    // are absent, the card has its old state, and restore rotates the existing sync-head UUID.
    await db.transaction(config.userId, async (sql) => {
      for (const table of [
        'review_events',
        'review_submissions',
        'sync_change_batches',
        'sync_operations',
        'api_idempotency',
        'sync_snapshots',
      ]) {
        await sql.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        await sql.query(`DELETE FROM ${table} WHERE user_id=$1`, [config.userId]);
        await sql.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      }
      await sql.query(
        'UPDATE review_cards SET version=1,review_count=0,lapse_count=0,last_reviewed_at=NULL,fsrs_state=$3::jsonb,due_at=$4 WHERE user_id=$1 AND id=$2',
        [config.userId, card.id, JSON.stringify(card.fsrs_state), card.due_at],
      );
      await sql.query(
        'UPDATE user_sync_state SET id=$2,revision=0,min_available_revision=0 WHERE user_id=$1',
        [config.userId, randomUUID()],
      );
    });
    dropSnapshotPage = true;
    await sync.sync();
    expect(snapshots).toBe(3); // Initial snapshot, cleared restore snapshot, successful replacement.
    const copies = await store.recoveryCopies();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.reason).toBe('STREAM_RESET');
    const recovery = (await store.recoveryCopy(copies[0]!.id)) as any;
    expect(
      recovery.records.some((r: any) => r.entity_type === 'review_event' && r.canonical?.id === event.id),
    ).toBe(true);
    expect(
      recovery.operations.some(
        (op: any) =>
          op.operation_id === reviewOp && op.status === 'applied' && op.command.payload.rating === 'good',
      ),
    ).toBe(true);
    expect(
      recovery.operations.some((op: any) => op.operation_id === captureOp && op.status === 'pending'),
    ).toBe(true);
    expect((await store.get('inbox_entry', captureId))?.content).toBe('Still unsynced at restore time');
    expect((await store.status()).pending).toBe(0);
    expect((await api.request<any>(`/review/history?card_id=${card.id}`)).items).toHaveLength(0); // No blind replay of acknowledged history.
    expect((await api.request<any>(`/review/cards/${card.id}`)).review_count).toBe(0);
    await sync.sync();
    expect(await store.recoveryCopies()).toHaveLength(1);
    driver.sql.close();
    localClosed = true;
    const reopenedDriver = new Driver(file);
    const reopened = new LocalStore(reopenedDriver);
    await reopened.initialize();
    expect(
      ((await reopened.recoveryCopy(copies[0]!.id)) as any).operations.some(
        (op: any) => op.operation_id === reviewOp,
      ),
    ).toBe(true);
    expect(await reopened.recoveryNoticeCount()).toBe(1);
    await reopened.acknowledgeRecovery(copies[0]!.id, new Date().toISOString());
    expect(await reopened.recoveryNoticeCount()).toBe(0);
    expect(await reopened.recoveryCopies()).toHaveLength(1);
    reopenedDriver.sql.close();
  } finally {
    if (!localClosed) driver.sql.close();
    await app.close();
    await db.close();
  }
}, 30000);
