export type Json = Record<string, unknown>;
export type RecordEnvelope = {
  entity_type: string;
  entity_id: string;
  entity_version: string;
  deleted_at: string | null;
  data: Json | null;
};
export type Command = {
  client_operation_id: string;
  entity_id: string;
  operation: string;
  payload: Json;
  base_version?: string | null;
  depends_on_operation_id?: string | null;
};
export type Outcome = {
  client_operation_id: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'blocked';
  retryable: boolean;
  records: RecordEnvelope[];
  conflict_id: string | null;
  error: unknown;
  resulting_version: string | null;
};
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, ...values: (string | number | null)[]): Promise<void>;
  all<T>(sql: string, ...values: (string | number | null)[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}
export type RecoverySummary = {
  id: string;
  reason: string;
  created_at: string;
  record_count: number;
  operation_count: number;
  acknowledged_at: string | null;
};
type EntityRow = {
  entity_type: string;
  entity_id: string;
  server_version: string;
  canonical: string | null;
  provisional: string | null;
  deleted_at: string | null;
};
type OutboxRow = {
  operation_id: string;
  entity_type: string;
  entity_id: string;
  command: string;
  projected: string | null;
  status: string;
  error: string | null;
  conflict_id: string | null;
  sequence: number;
  sent_at: string | null;
  result_records: string | null;
  draft_command: string | null;
};

export class LocalStore {
  constructor(readonly db: SqlDriver) {}

  async initialize(): Promise<void> {
    await this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,server_version TEXT NOT NULL DEFAULT '0',canonical TEXT,provisional TEXT,deleted_at TEXT,PRIMARY KEY(entity_type,entity_id));
      CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,command TEXT NOT NULL,projected TEXT,status TEXT NOT NULL DEFAULT 'pending',error TEXT,conflict_id TEXT,created_at TEXT NOT NULL,sent_at TEXT,result_records TEXT,draft_command TEXT);
      CREATE INDEX IF NOT EXISTS outbox_entity ON outbox(entity_type,entity_id,sequence);
      CREATE TABLE IF NOT EXISTS snapshot_records(snapshot_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(snapshot_id,entity_type,entity_id));
      CREATE TABLE IF NOT EXISTS recovery_copies(id TEXT PRIMARY KEY,reason TEXT NOT NULL,source_cursor TEXT NOT NULL,created_at TEXT NOT NULL,record_count INTEGER NOT NULL,operation_count INTEGER NOT NULL,acknowledged_at TEXT,payload TEXT NOT NULL,UNIQUE(reason,source_cursor)); PRAGMA busy_timeout=5000;`);
    const columns = await this.db.all<{ name: string }>('PRAGMA table_info(outbox)');
    for (const name of ['sent_at', 'result_records', 'draft_command'])
      if (!columns.some((c) => c.name === name))
        await this.db.exec(`ALTER TABLE outbox ADD COLUMN ${name} TEXT`);
  }

  async meta(key: string): Promise<string | null> {
    return (
      (await this.db.all<{ value: string }>('SELECT value FROM metadata WHERE key=?', key))[0]?.value ?? null
    );
  }
  async setMeta(key: string, value: string, tx = this.db): Promise<void> {
    await tx.run(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
  async accountId(): Promise<string | null> {
    const bound = await this.meta('account_id');
    if (bound) return bound;
    const cached = await this.meta('cache:/me');
    if (cached) {
      try {
        const id = (JSON.parse(cached) as Json).id;
        if (typeof id === 'string') return id;
      } catch {
        /* preserve malformed legacy metadata without trusting it */
      }
    }
    const users = await this.list('user');
    return typeof users[0]?.id === 'string' ? users[0].id : null;
  }
  async hasUserData(): Promise<boolean> {
    return (
      (
        await this.db.all(
          'SELECT 1 FROM entities WHERE canonical IS NOT NULL OR provisional IS NOT NULL LIMIT 1',
        )
      ).length > 0
    );
  }
  async createRecoveryCopy(
    id: string,
    reason: 'STREAM_RESET' | 'CURSOR_AHEAD',
    now: string,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const cursor =
        (await tx.all<{ value: string }>('SELECT value FROM metadata WHERE key=?', 'sync_cursor'))[0]
          ?.value ?? '';
      const existing = (
        await tx.all<{ id: string }>(
          'SELECT id FROM recovery_copies WHERE reason=? AND source_cursor=?',
          reason,
          cursor,
        )
      )[0];
      if (existing) return existing.id;
      const records = await tx.all<EntityRow>('SELECT * FROM entities ORDER BY entity_type,entity_id');
      const operations = await tx.all<OutboxRow>('SELECT * FROM outbox ORDER BY sequence');
      const metadata = await tx.all<{ key: string; value: string }>(
        "SELECT key,value FROM metadata WHERE key IN ('sync_cursor','device_id','account_id','last_synced')",
      );
      const decode = (value: string | null) => {
        if (!value) return null;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      const payload = {
        schema_version: '1',
        created_at: now,
        reason,
        metadata: Object.fromEntries(metadata.map((x) => [x.key, x.value])),
        records: records.map((row) => ({
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          server_version: row.server_version,
          deleted_at: row.deleted_at,
          canonical: decode(row.canonical),
          provisional: decode(row.provisional),
        })),
        operations: operations.map((row) => ({
          ...row,
          command: decode(row.command),
          draft_command: decode(row.draft_command),
          projected: decode(row.projected),
          result_records: decode(row.result_records),
          error: decode(row.error),
        })),
      };
      await tx.run(
        'INSERT INTO recovery_copies(id,reason,source_cursor,created_at,record_count,operation_count,payload) VALUES(?,?,?,?,?,?,?)',
        id,
        reason,
        cursor,
        now,
        records.length,
        operations.length,
        JSON.stringify(payload),
      );
      return id;
    });
  }
  async recoveryCopies(): Promise<RecoverySummary[]> {
    return this.db.all<RecoverySummary>(
      'SELECT id,reason,created_at,record_count,operation_count,acknowledged_at FROM recovery_copies ORDER BY created_at DESC,id',
    );
  }
  async recoveryNoticeCount(): Promise<number> {
    return Number(
      (
        await this.db.all<{ count: number }>(
          'SELECT count(*) count FROM recovery_copies WHERE acknowledged_at IS NULL',
        )
      )[0]?.count ?? 0,
    );
  }
  async recoveryCopy(id: string): Promise<Json> {
    const row = (
      await this.db.all<{ payload: string }>('SELECT payload FROM recovery_copies WHERE id=?', id)
    )[0];
    if (!row) throw new Error('Recovery copy not found');
    return JSON.parse(row.payload) as Json;
  }
  async acknowledgeRecovery(id: string, now: string): Promise<void> {
    await this.db.run('UPDATE recovery_copies SET acknowledged_at=? WHERE id=?', now, id);
  }
  async get(type: string, id: string, tx = this.db): Promise<Json | null> {
    const row = (
      await tx.all<EntityRow>('SELECT * FROM entities WHERE entity_type=? AND entity_id=?', type, id)
    )[0];
    const data = row?.provisional ?? row?.canonical;
    return data ? (JSON.parse(data) as Json) : null;
  }
  async canonical(type: string, id: string): Promise<Json | null> {
    const row = (
      await this.db.all<EntityRow>('SELECT * FROM entities WHERE entity_type=? AND entity_id=?', type, id)
    )[0];
    return row?.canonical ? (JSON.parse(row.canonical) as Json) : null;
  }
  async list(type: string): Promise<Json[]> {
    const rows = await this.db.all<EntityRow>(
      'SELECT * FROM entities WHERE entity_type=? ORDER BY entity_id',
      type,
    );
    return rows
      .map((row) => row.provisional ?? row.canonical)
      .filter((x): x is string => x !== null)
      .map((x) => JSON.parse(x) as Json)
      .filter((x) => !x.deleted_at);
  }
  async lastOperation(type: string, id: string): Promise<string | undefined> {
    return (
      await this.db.all<OutboxRow>(
        "SELECT * FROM outbox WHERE entity_type=? AND entity_id=? AND status IN ('pending','blocked') ORDER BY sequence DESC LIMIT 1",
        type,
        id,
      )
    )[0]?.operation_id;
  }

  async enqueue(input: {
    id: string;
    operation: string;
    entityType: string;
    entityId: string;
    payload: Json;
    projected: Json | null;
    dependsOn?: string;
    now: string;
  }): Promise<Command> {
    return this.db.transaction(async (tx) => {
      const previous = (
        await tx.all<OutboxRow>(
          "SELECT * FROM outbox WHERE entity_type=? AND entity_id=? AND status IN ('pending','blocked') ORDER BY sequence DESC LIMIT 1",
          input.entityType,
          input.entityId,
        )
      )[0];
      const entity = (
        await tx.all<EntityRow>(
          'SELECT * FROM entities WHERE entity_type=? AND entity_id=?',
          input.entityType,
          input.entityId,
        )
      )[0];
      const create = input.operation.endsWith('.create');
      const baseline = entity?.server_version !== '0' ? entity?.server_version : null;
      const dependency = input.dependsOn ?? previous?.operation_id;
      if (!create && !baseline && !dependency)
        throw new Error('Sync this record first to obtain its server version.');
      const command: Command = {
        client_operation_id: input.id,
        entity_id: input.entityId,
        operation: input.operation,
        payload: input.payload,
      };
      if (!create) command.base_version = baseline ?? '1';
      if (dependency) command.depends_on_operation_id = dependency;
      await tx.run(
        "INSERT INTO outbox(operation_id,entity_type,entity_id,command,projected,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
        input.id,
        input.entityType,
        input.entityId,
        JSON.stringify(command),
        input.projected ? JSON.stringify(input.projected) : null,
        input.now,
      );
      await tx.run(
        `INSERT INTO entities(entity_type,entity_id,server_version,canonical,provisional,deleted_at) VALUES(?,?,?,NULL,?,?)
        ON CONFLICT(entity_type,entity_id) DO UPDATE SET provisional=excluded.provisional,deleted_at=excluded.deleted_at`,
        input.entityType,
        input.entityId,
        entity?.server_version ?? '0',
        input.projected ? JSON.stringify(input.projected) : null,
        (input.projected?.deleted_at as string | null) ?? null,
      );
      return command;
    });
  }

  async pending(): Promise<Command[]> {
    return (
      await this.db.all<OutboxRow>(
        "SELECT * FROM outbox WHERE status IN ('pending','blocked') ORDER BY sequence LIMIT 100",
      )
    ).map((row) => JSON.parse(row.command) as Command);
  }
  async prepare(operationId: string, now: string): Promise<Command> {
    return this.db.transaction(async (tx) => {
      const row = (await tx.all<OutboxRow>('SELECT * FROM outbox WHERE operation_id=?', operationId))[0];
      if (!row) throw new Error('Local operation not found');
      const command = JSON.parse(row.command) as Command;
      if (row.sent_at) return command;
      if (command.depends_on_operation_id && !command.operation.endsWith('.create')) {
        const dependency = (
          await tx.all<OutboxRow>(
            "SELECT * FROM outbox WHERE operation_id=? AND status='applied'",
            command.depends_on_operation_id,
          )
        )[0];
        const records = JSON.parse(dependency?.result_records ?? '[]') as RecordEnvelope[];
        const causal = records.find(
          (r) => r.entity_type === row.entity_type && r.entity_id === row.entity_id && r.data,
        );
        if (causal) {
          command.base_version = causal.entity_version;
          if (command.operation === 'review.rate') command.payload.base_version = causal.entity_version;
          if (command.operation === 'knowledge.update') command.payload.base_snapshot = causal.data;
        }
      }
      await tx.run(
        'UPDATE outbox SET command=?,draft_command=COALESCE(draft_command,?),sent_at=? WHERE operation_id=?',
        JSON.stringify(command),
        row.command,
        now,
        operationId,
      );
      return command;
    });
  }
  async outbox(): Promise<OutboxRow[]> {
    return this.db.all<OutboxRow>(
      "SELECT * FROM outbox WHERE status NOT IN ('applied','superseded') ORDER BY sequence",
    );
  }
  async status(): Promise<{ pending: number; conflicts: number; rejected: number }> {
    const all = await this.outbox();
    return {
      pending: all.filter((x) => x.status === 'pending' || x.status === 'blocked').length,
      conflicts: all.filter((x) => x.status === 'conflict').length,
      rejected: all.filter((x) => x.status === 'rejected').length,
    };
  }

  async applyRecord(record: RecordEnvelope, tx = this.db): Promise<void> {
    const old = (
      await tx.all<EntityRow>(
        'SELECT * FROM entities WHERE entity_type=? AND entity_id=?',
        record.entity_type,
        record.entity_id,
      )
    )[0];
    if (old && BigInt(old.server_version) > BigInt(record.entity_version)) return;
    await tx.run(
      `INSERT INTO entities(entity_type,entity_id,server_version,canonical,provisional,deleted_at) VALUES(?,?,?,?,NULL,?)
      ON CONFLICT(entity_type,entity_id) DO UPDATE SET server_version=excluded.server_version,canonical=excluded.canonical,deleted_at=CASE WHEN entities.provisional IS NOT NULL THEN entities.deleted_at ELSE excluded.deleted_at END`,
      record.entity_type,
      record.entity_id,
      record.entity_version,
      record.data ? JSON.stringify(record.data) : null,
      record.deleted_at,
    );
  }
  async applyOutcome(result: Outcome): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.all<OutboxRow>('SELECT * FROM outbox WHERE operation_id=?', result.client_operation_id)
      )[0];
      if (!row) return;
      const success = result.status === 'applied' || result.status === 'duplicate';
      await tx.run(
        'UPDATE outbox SET status=?,error=?,conflict_id=?,result_records=? WHERE operation_id=?',
        success ? 'applied' : result.status,
        result.error ? JSON.stringify(result.error) : null,
        result.conflict_id,
        JSON.stringify(result.records ?? []),
        result.client_operation_id,
      );
      for (const record of result.records ?? []) await this.applyRecord(record, tx);
      const remaining = (
        await tx.all<OutboxRow>(
          "SELECT * FROM outbox WHERE entity_type=? AND entity_id=? AND status NOT IN ('applied','superseded') ORDER BY sequence DESC LIMIT 1",
          row.entity_type,
          row.entity_id,
        )
      )[0];
      await tx.run(
        'UPDATE entities SET provisional=? WHERE entity_type=? AND entity_id=?',
        remaining?.projected ?? null,
        row.entity_type,
        row.entity_id,
      );
    });
  }
  async applyBatch(records: RecordEnvelope[], cursor: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const record of records) await this.applyRecord(record, tx);
      await this.setMeta('sync_cursor', cursor, tx);
    });
  }
  async stageSnapshot(id: string, records: RecordEnvelope[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const record of records)
        await tx.run(
          'INSERT OR REPLACE INTO snapshot_records VALUES(?,?,?,?)',
          id,
          record.entity_type,
          record.entity_id,
          JSON.stringify(record),
        );
    });
  }
  async installSnapshot(id: string, cursor: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const pending = await tx.all<EntityRow>('SELECT * FROM entities WHERE provisional IS NOT NULL');
      const records = await tx.all<{ record: string }>(
        'SELECT record FROM snapshot_records WHERE snapshot_id=?',
        id,
      );
      await tx.run('DELETE FROM entities');
      for (const record of records) await this.applyRecord(JSON.parse(record.record) as RecordEnvelope, tx);
      for (const row of pending) {
        await tx.run(
          `INSERT INTO entities(entity_type,entity_id,server_version,canonical,provisional,deleted_at) VALUES(?,?,?,NULL,?,?)
          ON CONFLICT(entity_type,entity_id) DO UPDATE SET provisional=excluded.provisional,deleted_at=excluded.deleted_at`,
          row.entity_type,
          row.entity_id,
          '0',
          row.provisional,
          row.deleted_at,
        );
      }
      await this.setMeta('sync_cursor', cursor, tx);
      await tx.run('DELETE FROM snapshot_records');
    });
  }
  async markConflictResolved(operationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = (await tx.all<OutboxRow>('SELECT * FROM outbox WHERE operation_id=?', operationId))[0];
      if (!row) return;
      await tx.run("UPDATE outbox SET status='applied' WHERE operation_id=?", operationId);
      const remaining = (
        await tx.all<OutboxRow>(
          "SELECT * FROM outbox WHERE entity_type=? AND entity_id=? AND status NOT IN ('applied','superseded') ORDER BY sequence DESC LIMIT 1",
          row.entity_type,
          row.entity_id,
        )
      )[0];
      await tx.run(
        'UPDATE entities SET provisional=? WHERE entity_type=? AND entity_id=?',
        remaining?.projected ?? null,
        row.entity_type,
        row.entity_id,
      );
    });
  }
  async rebaseBlocked(operationId: string, replacementId: string, now: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = (
        await tx.all<OutboxRow>("SELECT * FROM outbox WHERE operation_id=? AND status='blocked'", operationId)
      )[0];
      if (!row) throw new Error('Only blocked operations can be resubmitted.');
      const original = JSON.parse(row.command) as Command;
      if (original.operation === 'review.rate')
        throw new Error('An old rating cannot be reapplied. Review the card again.');
      const entity = (
        await tx.all<EntityRow>(
          'SELECT * FROM entities WHERE entity_type=? AND entity_id=?',
          row.entity_type,
          row.entity_id,
        )
      )[0];
      if (entity?.deleted_at)
        throw new Error('The target is archived. Create a new record. The original operation is retained.');
      const dependency = original.depends_on_operation_id
        ? (
            await tx.all<{ value: string }>(
              'SELECT value FROM metadata WHERE key=?',
              `rebased:${original.depends_on_operation_id}`,
            )
          )[0]?.value
        : undefined;
      const command: Command = {
        ...original,
        client_operation_id: replacementId,
        payload: { ...original.payload },
      };
      delete command.depends_on_operation_id;
      if (dependency) command.depends_on_operation_id = dependency;
      if (!original.operation.endsWith('.create')) {
        if ((!entity?.server_version || entity.server_version === '0') && !dependency)
          throw new Error('This target is missing on the server. Recreate its dependencies first.');
        command.base_version = entity?.server_version !== '0' ? entity?.server_version : '1';
        if (command.operation === 'knowledge.update' && entity?.canonical)
          command.payload.base_snapshot = JSON.parse(entity.canonical);
      }
      await tx.run(
        "UPDATE outbox SET status='superseded',error=? WHERE operation_id=?",
        JSON.stringify({ explicitly_rebased_to: replacementId, original_status: row.status }),
        operationId,
      );
      await tx.run(
        "INSERT INTO outbox(operation_id,entity_type,entity_id,command,projected,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
        replacementId,
        row.entity_type,
        row.entity_id,
        JSON.stringify(command),
        row.projected,
        now,
      );
      await this.setMeta(`rebased:${operationId}`, replacementId, tx);
    });
  }
}
