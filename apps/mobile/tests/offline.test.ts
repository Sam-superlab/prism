import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LocalStore, type SqlDriver, type RecordEnvelope } from '../src/offline/store';

class NodeDriver implements SqlDriver {
  constructor(readonly sql = new DatabaseSync(':memory:')) {}
  async exec(query: string): Promise<void> {
    this.sql.exec(query);
  }
  async run(query: string, ...values: (string | number | null)[]): Promise<void> {
    this.sql.prepare(query).run(...values);
  }
  async all<T>(query: string, ...values: (string | number | null)[]): Promise<T[]> {
    return this.sql.prepare(query).all(...values) as T[];
  }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.sql.exec('COMMIT');
      return result;
    } catch (error) {
      this.sql.exec('ROLLBACK');
      throw error;
    }
  }
}
const stamp = '2026-11-08T12:00:00Z';
const record = (version: string, title = 'server'): RecordEnvelope => ({
  entity_type: 'knowledge_item',
  entity_id: 'item',
  entity_version: version,
  deleted_at: null,
  data: { id: 'item', version, title },
});
async function setup() {
  const driver = new NodeDriver();
  const store = new LocalStore(driver);
  await store.initialize();
  return { store, driver };
}

describe('durable offline commands', () => {
  it('atomically preserves capture and outbox across store reopening', async () => {
    const { store, driver } = await setup();
    await store.enqueue({
      id: 'op-1',
      operation: 'inbox.create',
      entityType: 'inbox_entry',
      entityId: 'note',
      payload: { id: 'note', content: 'offline' },
      projected: { id: 'note', content: 'offline' },
      now: stamp,
    });
    const reopened = new LocalStore(driver);
    expect((await reopened.list('inbox_entry'))[0]?.content).toBe('offline');
    expect((await reopened.pending())[0]?.client_operation_id).toBe('op-1');
  });
  it('rolls back the projection when outbox cannot be written', async () => {
    const { store } = await setup();
    await store.enqueue({
      id: 'same',
      operation: 'inbox.create',
      entityType: 'inbox_entry',
      entityId: 'a',
      payload: { id: 'a' },
      projected: { id: 'a', content: 'first' },
      now: stamp,
    });
    await expect(
      store.enqueue({
        id: 'same',
        operation: 'inbox.create',
        entityType: 'inbox_entry',
        entityId: 'b',
        payload: { id: 'b' },
        projected: { id: 'b' },
        now: stamp,
      }),
    ).rejects.toThrow();
    expect(await store.get('inbox_entry', 'b')).toBeNull();
    expect((await store.pending()).length).toBe(1);
  });
  it('links repeated offline reviews without inventing authoritative schedules', async () => {
    const { store } = await setup();
    await store.applyRecord({ ...record('7'), entity_type: 'review_card' });
    await store.enqueue({
      id: 'review-1',
      operation: 'review.rate',
      entityType: 'review_card',
      entityId: 'item',
      payload: { rating: 'good' },
      projected: { id: 'item', version: '7', provisional: true },
      now: stamp,
    });
    const second = await store.enqueue({
      id: 'review-2',
      operation: 'review.rate',
      entityType: 'review_card',
      entityId: 'item',
      payload: { rating: 'again' },
      projected: { id: 'item', version: '7', provisional: true },
      now: stamp,
    });
    expect(second.base_version).toBe('7');
    expect(second.depends_on_operation_id).toBe('review-1');
  });
  it('preserves client projection and canonical value independently during conflict', async () => {
    const { store } = await setup();
    await store.applyRecord(record('1'));
    await store.enqueue({
      id: 'edit',
      operation: 'knowledge.update',
      entityType: 'knowledge_item',
      entityId: 'item',
      payload: { title: 'mine' },
      projected: { id: 'item', version: '1', title: 'mine' },
      now: stamp,
    });
    await store.applyOutcome({
      client_operation_id: 'edit',
      status: 'conflict',
      retryable: false,
      records: [record('2', 'theirs')],
      conflict_id: 'conflict',
      resulting_version: '2',
      error: null,
    });
    expect((await store.get('knowledge_item', 'item'))?.title).toBe('mine');
    expect((await store.canonical('knowledge_item', 'item'))?.title).toBe('theirs');
    expect((await store.status()).conflicts).toBe(1);
    expect(await store.pending()).toHaveLength(0);
  });
  it('ignores old receipt snapshots and applies cursor with a whole batch', async () => {
    const { store } = await setup();
    await store.applyBatch([record('12')], 'cursor-12');
    await store.applyBatch([record('3', 'old')], 'cursor-13');
    expect((await store.get('knowledge_item', 'item'))?.version).toBe('12');
    expect(await store.meta('sync_cursor')).toBe('cursor-13');
  });
  it('installs snapshot atomically while retaining unsynced capture', async () => {
    const { store } = await setup();
    await store.enqueue({
      id: 'capture',
      operation: 'inbox.create',
      entityType: 'inbox_entry',
      entityId: 'local-only',
      payload: { id: 'local-only', content: 'preserve' },
      projected: { id: 'local-only', content: 'preserve' },
      now: stamp,
    });
    await store.stageSnapshot('snapshot', [record('4')]);
    expect(await store.get('knowledge_item', 'item')).toBeNull();
    await store.installSnapshot('snapshot', 'resume-4');
    expect((await store.get('knowledge_item', 'item'))?.version).toBe('4');
    expect((await store.get('inbox_entry', 'local-only'))?.content).toBe('preserve');
    expect(await store.pending()).toHaveLength(1);
    expect(await store.meta('sync_cursor')).toBe('resume-4');
  });
  it('uses stable operation IDs after a lost server response', async () => {
    const { store } = await setup();
    await store.enqueue({
      id: 'stable',
      operation: 'workout.session.create',
      entityType: 'workout_session',
      entityId: 'session',
      payload: { id: 'session', started_at: stamp },
      projected: { id: 'session' },
      now: stamp,
    });
    const before = await store.pending();
    const after = await store.pending();
    expect(after).toEqual(before);
    await store.applyOutcome({
      client_operation_id: 'stable',
      status: 'duplicate',
      retryable: false,
      records: [],
      conflict_id: null,
      resulting_version: '1',
      error: null,
    });
    expect(await store.pending()).toHaveLength(0);
  });
  it('freezes a causal parent version once and never rebases a retry to unrelated changes', async () => {
    const { store } = await setup();
    await store.applyRecord({
      entity_type: 'workout_session',
      entity_id: 'session',
      entity_version: '1',
      deleted_at: null,
      data: { id: 'session', version: '1', status: 'in_progress' },
    });
    await store.enqueue({
      id: 'set',
      operation: 'workout.set.create',
      entityType: 'workout_set',
      entityId: 'set-id',
      payload: { id: 'set-id' },
      projected: { id: 'set-id' },
      now: stamp,
    });
    await store.enqueue({
      id: 'finish',
      operation: 'workout.session.complete',
      entityType: 'workout_session',
      entityId: 'session',
      payload: { ended_at: stamp },
      projected: { id: 'session', status: 'completed' },
      dependsOn: 'set',
      now: stamp,
    });
    await store.applyOutcome({
      client_operation_id: 'set',
      status: 'applied',
      retryable: false,
      records: [
        {
          entity_type: 'workout_session',
          entity_id: 'session',
          entity_version: '4',
          deleted_at: null,
          data: { id: 'session', version: '4' },
        },
      ],
      conflict_id: null,
      error: null,
      resulting_version: '1',
    });
    const first = await store.prepare('finish', stamp);
    expect(first.base_version).toBe('4');
    await store.applyRecord({
      entity_type: 'workout_session',
      entity_id: 'session',
      entity_version: '5',
      deleted_at: null,
      data: { id: 'session', version: '5', notes: 'other device' },
    });
    const retry = await store.prepare('finish', stamp);
    expect(retry).toEqual(first);
    expect(retry.base_version).toBe('4');
  });
  it('keeps later provisional edits when an earlier operation is acknowledged', async () => {
    const { store } = await setup();
    await store.applyRecord(record('1'));
    await store.enqueue({
      id: 'first',
      operation: 'knowledge.update',
      entityType: 'knowledge_item',
      entityId: 'item',
      payload: { title: 'first' },
      projected: { id: 'item', title: 'first' },
      now: stamp,
    });
    await store.enqueue({
      id: 'second',
      operation: 'knowledge.update',
      entityType: 'knowledge_item',
      entityId: 'item',
      payload: { title: 'second' },
      projected: { id: 'item', title: 'second' },
      now: stamp,
    });
    await store.applyOutcome({
      client_operation_id: 'first',
      status: 'applied',
      retryable: false,
      records: [record('2', 'first')],
      conflict_id: null,
      error: null,
      resulting_version: '2',
    });
    expect((await store.get('knowledge_item', 'item'))?.title).toBe('second');
    expect((await store.canonical('knowledge_item', 'item'))?.title).toBe('first');
  });
  it('requires explicit rebase and preserves the old blocked operation', async () => {
    const { store, driver } = await setup();
    await store.applyRecord(record('2'));
    await store.enqueue({
      id: 'blocked',
      operation: 'knowledge.update',
      entityType: 'knowledge_item',
      entityId: 'item',
      payload: { title: 'my edit', base_snapshot: { version: '1' } },
      projected: { id: 'item', title: 'my edit' },
      now: stamp,
    });
    await store.applyOutcome({
      client_operation_id: 'blocked',
      status: 'blocked',
      retryable: true,
      records: [],
      conflict_id: null,
      error: { code: 'DEPENDENCY_BLOCKED' },
      resulting_version: null,
    });
    await store.rebaseBlocked('blocked', 'replacement', stamp);
    const pending = await store.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.client_operation_id).toBe('replacement');
    expect(pending[0]?.base_version).toBe('2');
    expect(
      (await driver.all<{ status: string }>('SELECT status FROM outbox WHERE operation_id=?', 'blocked'))[0]
        ?.status,
    ).toBe('superseded');
    expect((await store.get('knowledge_item', 'item'))?.title).toBe('my edit');
  });
  it('deduplicates a restore copy while the same old cursor cannot bootstrap', async () => {
    const { store } = await setup();
    await store.applyRecord(record('8', 'device history'));
    await store.setMeta('sync_cursor', 'old-signed-cursor');
    expect(await store.createRecoveryCopy('first', 'CURSOR_AHEAD', stamp)).toBe('first');
    await store.applyRecord(record('9', 'later cache'));
    expect(await store.createRecoveryCopy('duplicate', 'CURSOR_AHEAD', stamp)).toBe('first');
    expect(await store.recoveryCopies()).toHaveLength(1);
    const copy = (await store.recoveryCopy('first')) as any;
    expect(copy.records[0].canonical.title).toBe('device history');
  });
});
