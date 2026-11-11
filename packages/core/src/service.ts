import {
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, Sql, Row } from '@prism/database';
import { createCard, reviewCard, getRetrievability, schedulerConfig } from '@prism/fsrs';
import { generatePlan, type PlannerTask, type PlannerItem } from '@prism/planner';
import { localDayRange, localDate, validTimezone } from '@prism/shared-utils';
import { zipSync, strToU8 } from 'fflate';
import { ApiError, notFound, validation } from './errors';
import { models, tableKinds, protectedTables } from './models';
import { rankSubscriptionMatches, type SubscriptionMatchRule } from './relevance';
import type { ApiConfig } from './config';
export interface Command {
  userId: string;
  key: string;
  method: string;
  path: string;
  body?: Row;
  expected?: string;
  sync?: boolean;
  deviceId?: string;
  dependsOn?: string;
  entityId?: string;
  entityType?: string;
}
export interface Result {
  status: number;
  body: any;
  headers?: Record<string, string>;
  replayed?: boolean;
}
interface Context {
  sql: Sql;
  userId: string;
  operationId: string;
  changes: any[];
  sync: boolean;
  deviceId?: string;
  expected?: string;
  dependsOn?: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const immutable = new Set([
  'review_events',
  'research_events',
  'scheduler_configs',
  'review_submissions',
  'conflict_resolution_events',
]);
const numeric = new Set([
  'desired_retention',
  'target_weight_kg',
  'entered_weight',
  'weight_kg',
  'rpe',
  'rir',
  'distance',
  'distance_meters',
  'relevance_score',
  'bytes',
]);
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const hash = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
const dateOnly = (v: any): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const commandHash = (command: Command) =>
  hash({
    method: command.method,
    path: command.path,
    body: command.body ?? {},
    expected:
      command.path === 'review/events' ? (command.body?.base_version ?? null) : (command.expected ?? null),
    dependsOn: command.dependsOn ?? null,
  });
export class PrismService {
  columns = new Map<string, Set<string>>();
  constructor(
    readonly db: Database,
    readonly config: ApiConfig,
  ) {}
  async initialize() {
    const cols = await this.db.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='prism'",
    );
    for (const r of cols.rows) {
      const set = this.columns.get(r.table_name) ?? new Set();
      set.add(r.column_name);
      this.columns.set(r.table_name, set);
    }
    if (this.config.authMode === 'development')
      await this.db.transaction(this.config.userId, async (sql) => {
        await sql.query(
          "INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,'local@prism.invalid','Researcher') ON CONFLICT(id) DO NOTHING",
          [this.config.userId, this.config.allowedSubject],
        );
        await sql.query(
          'INSERT INTO user_preferences(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
          [randomUUID(), this.config.userId],
        );
        await sql.query(
          'INSERT INTO user_sync_state(id,user_id) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',
          [randomUUID(), this.config.userId],
        );
      });
    if (this.config.authMode === 'oidc')
      await this.db.transaction(this.config.userId, async (sql) => {
        const u = (
          await sql.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [this.config.userId])
        ).rows[0];
        const p = (await sql.query('SELECT id FROM user_preferences WHERE user_id=$1', [this.config.userId]))
          .rows[0];
        const h = (await sql.query('SELECT id FROM user_sync_state WHERE user_id=$1', [this.config.userId]))
          .rows[0];
        if (!u || u.oidc_subject !== this.config.allowedSubject || !p || !h)
          throw new Error('Configured account has not been provisioned with preferences and sync state');
      });
  }
  async read<T>(userId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.db.transaction(userId, fn);
  }
  private encode(value: Row): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return payload + '.' + createHmac('sha256', this.config.secret).update(payload).digest('base64url');
  }
  private decode(token: string, userId: string, type: string): Row {
    const segments = token.split('.');
    const [p, s] = segments;
    if (segments.length !== 2 || !p || !s) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor');
    const expected = createHmac('sha256', this.config.secret).update(p).digest('base64url');
    if (s.length !== expected.length || !timingSafeEqual(Buffer.from(s), Buffer.from(expected)))
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor');
    let d: Row;
    try {
      d = JSON.parse(Buffer.from(p, 'base64url').toString());
    } catch {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor');
    }
    if (
      !d ||
      typeof d !== 'object' ||
      Array.isArray(d) ||
      typeof d.exp !== 'number' ||
      !Number.isFinite(d.exp)
    )
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor');
    if (d.user !== userId) throw new ApiError(403, 'FORBIDDEN', 'Cursor belongs to another account');
    if (d.type !== type || d.schema !== '1')
      throw new ApiError(400, 'VALIDATION_ERROR', 'Cursor type mismatch');
    if (d.exp < Date.now())
      throw new ApiError(
        410,
        type === 'sync' ? 'SYNC_CURSOR_EXPIRED' : 'SNAPSHOT_EXPIRED',
        'Cursor expired; create a new snapshot',
      );
    return d;
  }
  private cursor(userId: string, type: string, rest: Row): string {
    return this.encode({
      user: userId,
      type,
      schema: '1',
      exp: Date.now() + (type === 'sync' ? 90 : 1) * 86400000,
      ...rest,
    });
  }
  async row(sql: Sql, userId: string, table: string, id: string, deleted = false): Promise<Row> {
    if (!this.columns.has(table)) throw validation('Unknown entity');
    const owner = table === 'users' ? 'id' : 'user_id';
    const result = await sql.query(
      `SELECT * FROM ${table} WHERE ${owner}=$1 AND id=$2${!deleted && this.columns.get(table)?.has('deleted_at') ? ' AND deleted_at IS NULL' : ''}`,
      [userId, id],
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  async insert(sql: Sql, table: string, body: Row, userId?: string): Promise<Row> {
    const data: Row = { ...body, id: body.id ?? randomUUID(), ...(userId ? { user_id: userId } : {}) };
    const allowed = this.columns.get(table)!;
    const keys = Object.keys(data).filter(
      (k) => allowed.has(k) && data[k] !== undefined && !['weight_kg', 'distance_meters'].includes(k),
    );
    const values = keys.map((k) => this.value(data[k], k));
    const result = await sql.query(
      `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
      values,
    );
    return result.rows[0];
  }
  private value(v: any, key = ''): any {
    const json = new Set([
      'changes',
      'payload',
      'result',
      'response_body',
      'event_payload',
      'parameters',
      'fsrs_state',
      'evidence_metadata',
      'summary',
      'match_reasons',
      'records',
      'metadata_snapshot',
      'notification_preferences',
      'digest_preferences',
      'template_snapshot',
      'previous_state',
      'resulting_state',
      'resolved_payload',
      'client_payload',
      'base_payload',
      'server_payload',
    ]);
    return json.has(key)
      ? JSON.stringify(v)
      : v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        ? JSON.stringify(v)
        : v;
  }
  async update(sql: Sql, userId: string, table: string, id: string, body: Row): Promise<Row> {
    const columns = this.columns.get(table)!;
    const keys = Object.keys(body).filter(
      (k) =>
        columns.has(k) &&
        !['id', 'user_id', 'created_at', 'updated_at', 'version', 'weight_kg', 'distance_meters'].includes(
          k,
        ) &&
        body[k] !== undefined,
    );
    const sets = keys.map((k, i) => `${k}=$${i + 3}`);
    if (columns.has('version')) sets.push('version=version+1');
    if (columns.has('updated_at')) sets.push('updated_at=now()');
    const result = await sql.query(
      `UPDATE ${table} SET ${sets.join(',')} WHERE ${table === 'users' ? 'id' : 'user_id'}=$1 AND id=$2 RETURNING *`,
      [userId, id, ...keys.map((k) => this.value(body[k], k))],
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }
  async serialize(sql: Sql, userId: string, table: string, raw: Row): Promise<Row> {
    const row = { ...raw };
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Date)
        row[k] =
          ['plan_date', 'planned_date'].includes(k) || (k === 'started_at' && table === 'research_projects')
            ? v.toISOString().slice(0, 10)
            : v.toISOString();
      if (k === 'version' && v !== undefined) row[k] = String(v);
      if (numeric.has(k) && v !== null && v !== undefined) row[k] = Number(v);
    }
    delete row.user_id;
    delete row.oidc_subject;
    delete row.push_token_ciphertext;
    delete row.__cursor_time;
    if (table === 'devices') {
      row.push_registered = !!raw.push_token_ciphertext;
      delete row.last_ack_revision;
    }
    if (table === 'users')
      return {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        timezone: row.timezone,
        version: row.version,
      };
    if (table === 'user_preferences')
      return {
        desired_retention: Number(row.desired_retention),
        daily_review_limit: row.daily_review_limit,
        default_study_capacity_minutes: row.default_study_capacity_minutes,
        notification_preferences: row.notification_preferences,
        digest_preferences: row.digest_preferences,
        version: row.version,
      };
    if (table === 'review_cards') {
      const cfg = await this.row(sql, userId, 'scheduler_configs', raw.scheduler_config_id);
      row.scheduler_config = await this.serialize(sql, userId, 'scheduler_configs', cfg);
      delete row.scheduler_config_id;
      row.retrievability = await getRetrievability(raw.fsrs_state, new Date().toISOString(), {
        ...cfg,
        desired_retention: Number(cfg.desired_retention),
      });
      row.retrievability_computed_at = new Date().toISOString();
    }
    if (table === 'scheduler_configs') {
      delete row.created_at;
      return row;
    }
    if (table === 'daily_shutdowns') return raw.summary;
    if (table === 'review_events') {
      row.card_version_before = String(row.card_version_before);
      row.card_version_after = String(row.card_version_after);
      row.scheduler_config = await this.serialize(
        sql,
        userId,
        'scheduler_configs',
        await this.row(sql, userId, 'scheduler_configs', raw.scheduler_config_id),
      );
      delete row.scheduler_config_id;
      delete row.idempotency_key;
    }
    if (table === 'workout_templates')
      row.exercises = await this.childRows(
        sql,
        userId,
        'workout_template_exercises',
        'template_id',
        raw.id,
        'position',
      );
    if (table === 'workout_sessions') {
      row.exercises = await this.childRows(
        sql,
        userId,
        'workout_session_exercises',
        'session_id',
        raw.id,
        'position',
      );
      row.sets = await this.childRows(sql, userId, 'workout_sets', 'session_id', raw.id, 'set_order');
      row.cardio = await this.childRows(sql, userId, 'cardio_entries', 'session_id', raw.id, 'created_at');
      row.volume_kg_reps = row.sets
        .filter((x: Row) => x.completed_at && x.weight_kg !== null)
        .reduce((s: number, x: Row) => s + Number(x.weight_kg) * x.reps, 0);
    }
    if (table === 'user_papers') row.paper = await this.paper(sql, raw.paper_id);
    if (table === 'daily_plans')
      row.items = await this.childRows(sql, userId, 'daily_plan_items', 'daily_plan_id', raw.id, 'position');
    if (table === 'daily_plan_items') {
      const cards = await sql.query(
        'SELECT card_id FROM daily_plan_review_cards WHERE user_id=$1 AND plan_item_id=$2 AND deleted_at IS NULL ORDER BY position,id',
        [userId, raw.id],
      );
      row.review_card_ids = cards.rows.map((x) => x.card_id);
      row.next_available_at = null;
      if (row.review_card_ids.length) {
        const due = await sql.query(
          'SELECT min(due_at) due FROM review_cards WHERE user_id=$1 AND id=ANY($2::uuid[])',
          [userId, row.review_card_ids],
        );
        const d = due.rows[0]?.due;
        if (d && new Date(d) > new Date()) row.next_available_at = new Date(d).toISOString();
      }
    }
    if (table === 'daily_plan_review_cards') delete row.item_type;
    if (table === 'sync_conflicts') delete row.resolved_payload;
    if (table === 'automation_jobs')
      return {
        id: row.id,
        job_type: row.job_type,
        scheduled_at: row.scheduled_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status,
        attempts: row.attempts,
        error_message: row.error_message,
      };
    if (table === 'exports') {
      const manifest = raw.object_key ? await this.exportManifest(raw.object_key) : null;
      return {
        id: row.id,
        status: row.status,
        formats: row.formats,
        expires_at: row.expires_at,
        sha256: row.sha256,
        bytes: row.bytes,
        error_message: row.error_message,
        manifest,
      };
    }
    return row;
  }
  private async childRows(
    sql: Sql,
    userId: string,
    table: string,
    col: string,
    id: string,
    order: string,
  ): Promise<Row[]> {
    const r = await sql.query(
      `SELECT * FROM ${table} WHERE user_id=$1 AND ${col}=$2 AND deleted_at IS NULL ORDER BY ${order},id`,
      [userId, id],
    );
    return Promise.all(r.rows.map((x) => this.serialize(sql, userId, table, x)));
  }
  async paper(sql: Sql, id: string): Promise<Row> {
    const p = await sql.query('SELECT * FROM arxiv_papers WHERE id=$1', [id]);
    if (!p.rows[0]) throw notFound();
    const row = p.rows[0];
    const versions = await sql.query(
      'SELECT version,updated_at,metadata_snapshot FROM arxiv_paper_versions WHERE paper_id=$1 ORDER BY version',
      [id],
    );
    return {
      ...row,
      published_at: new Date(row.published_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      ingested_at: new Date(row.ingested_at).toISOString(),
      versions: versions.rows.map((x) => ({ ...x, updated_at: new Date(x.updated_at).toISOString() })),
    };
  }
  private async change(ctx: Context, table: string, row: Row): Promise<void> {
    if (!tableKinds[table] || protectedTables.has(table)) return;
    const record = {
      entity_type: tableKinds[table],
      entity_id: row.id,
      entity_version: String(row.version ?? 1),
      deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      data: row.deleted_at ? null : await this.serialize(ctx.sql, ctx.userId, table, row),
    };
    const i = ctx.changes.findIndex(
      (x) => x.entity_type === record.entity_type && x.entity_id === record.entity_id,
    );
    if (i >= 0) ctx.changes[i] = record;
    else ctx.changes.push(record);
  }
  private version(row: Row, expected?: string): void {
    if (!expected) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match version is required');
    if (String(row.version) !== expected)
      throw new ApiError(412, 'VERSION_CONFLICT', 'This record changed on another device', {
        current_version: String(row.version),
      });
  }
  async execute(command: Command, fn?: (ctx: Context) => Promise<Result>): Promise<Result> {
    if (!uuid.test(command.key)) throw validation('Idempotency-Key must be a UUID');
    const fingerprint = commandHash(command);
    return this.db.transaction(
      command.userId,
      async (sql) => {
        await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [command.userId]);
        const prior = await sql.query(
          'SELECT * FROM api_idempotency WHERE user_id=$1 AND idempotency_key=$2',
          [command.userId, command.key],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== fingerprint)
            throw new ApiError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Operation ID was already used with different content',
            );
          const result = { status: prior.rows[0].response_status, body: prior.rows[0].response_body };
          if (result.body?.error && !result.body.error.request_id)
            result.body.error.request_id = randomUUID();
          if (command.sync && command.deviceId) {
            const old = (
              await sql.query('SELECT id FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
                command.userId,
                command.key,
              ])
            ).rows[0];
            if (!old) {
              const batch = (
                await sql.query(
                  'SELECT revision,changes FROM sync_change_batches WHERE user_id=$1 AND $2=ANY(operation_ids) ORDER BY revision LIMIT 1',
                  [command.userId, command.key],
                )
              ).rows[0];
              await this.insert(
                sql,
                'sync_operations',
                {
                  device_id: command.deviceId,
                  client_operation_id: command.key,
                  entity_type: command.entityType ?? 'command',
                  entity_id: command.entityId ?? command.body?.card_id ?? command.body?.id ?? command.userId,
                  operation_type: command.method + ' ' + command.path,
                  payload: command.body ?? {},
                  payload_hash: fingerprint,
                  status: result.status === 409 || result.status === 412 ? 'conflict' : 'applied',
                  result: {
                    ...result,
                    sync_revision: batch ? String(batch.revision) : null,
                    records: batch?.changes ?? [],
                  },
                },
                command.userId,
              );
            }
          }
          return { ...result, replayed: true };
        }
        const priorOperation = (
          await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
            command.userId,
            command.key,
          ])
        ).rows[0];
        if (priorOperation && priorOperation.payload_hash !== fingerprint)
          throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Operation key reused with different content');
        const ctx: Context = {
          sql,
          userId: command.userId,
          operationId: command.key,
          changes: [],
          sync: !!command.sync,
          deviceId: command.deviceId,
          expected: command.expected,
          dependsOn: command.dependsOn,
        };
        let result: Result;
        try {
          result = await (fn ? fn(ctx) : this.dispatchMutation(ctx, command));
        } catch (error) {
          const table = command.path.startsWith('knowledge-items/')
            ? 'knowledge_items'
            : command.path.startsWith('research/objects/')
              ? 'research_objects'
              : undefined;
          if (
            !fn &&
            error instanceof ApiError &&
            error.status === 412 &&
            command.method === 'PATCH' &&
            table &&
            command.body?.base_snapshot
          ) {
            const target = await this.row(sql, command.userId, table, command.path.split('/').at(-1)!);
            const conflict = await this.insert(
              sql,
              'sync_conflicts',
              {
                entity_type: tableKinds[table],
                entity_id: target.id,
                client_operation_id: command.key,
                conflict_type: 'version',
                base_payload: command.body.base_snapshot,
                client_payload: command.body,
                server_payload: await this.serialize(sql, command.userId, table, target),
              },
              command.userId,
            );
            await this.change(ctx, 'sync_conflicts', conflict);
            result = {
              status: 412,
              body: {
                error: {
                  code: 'VERSION_CONFLICT',
                  message: 'Edit preserved; reconcile the concurrent mathematical content',
                  details: { conflict_id: conflict.id, current_version: String(target.version) },
                },
              },
            };
          } else throw error;
        }
        if (result.body?.error && !result.body.error.request_id) result.body.error.request_id = randomUUID();
        let revision: string | null = null;
        if (ctx.changes.length) {
          const rev = await sql.query(
            'UPDATE user_sync_state SET revision=revision+1,updated_at=now(),version=version+1 WHERE user_id=$1 RETURNING revision',
            [command.userId],
          );
          revision = String(rev.rows[0].revision);
          await this.insert(
            sql,
            'sync_change_batches',
            { revision, changes: ctx.changes, operation_ids: [command.key] },
            command.userId,
          );
          await this.insert(
            sql,
            'outbox_events',
            {
              event_type: 'projection_invalidated',
              payload: { revision, entity_ids: ctx.changes.map((x) => x.entity_id) },
              dedupe_key: command.key,
            },
            command.userId,
          );
        }
        if (result.body && result.body.sync_revision === null) result.body.sync_revision = revision;
        await this.insert(
          sql,
          'api_idempotency',
          {
            idempotency_key: command.key,
            method: command.method,
            path: command.path,
            request_hash: fingerprint,
            response_status: result.status,
            response_body: result.body ?? null,
          },
          command.userId,
        );
        if (command.sync && command.deviceId) {
          const existing = await sql.query(
            'SELECT id FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2',
            [command.userId, command.key],
          );
          const receipt = {
            device_id: command.deviceId,
            client_operation_id: command.key,
            entity_type: command.entityType ?? ctx.changes[0]?.entity_type ?? 'command',
            entity_id:
              command.entityId ??
              ctx.changes[0]?.entity_id ??
              command.body?.card_id ??
              command.body?.id ??
              command.userId,
            operation_type: command.method + ' ' + command.path,
            payload: command.body ?? {},
            payload_hash: fingerprint,
            status: result.status === 409 ? 'conflict' : 'applied',
            result: { ...result, sync_revision: revision, records: ctx.changes },
          };
          if (existing.rows[0])
            await this.update(sql, command.userId, 'sync_operations', existing.rows[0].id, receipt);
          else await this.insert(sql, 'sync_operations', receipt, command.userId);
        }
        return result;
      },
      command.path === 'sync/snapshots' ? 'repeatable read' : 'read committed',
    );
  }
  private async audit(ctx: Context, projectId: string, objectId: string | null, type: string, payload: Row) {
    const event = await this.insert(
      ctx.sql,
      'research_events',
      { project_id: projectId, object_id: objectId, event_type: type, event_payload: payload },
      ctx.userId,
    );
    await this.change(ctx, 'research_events', event);
  }
  private async validateRefs(ctx: Context, body: Row): Promise<void> {
    const refs: Record<string, string> = {
      knowledge_item_id: 'knowledge_items',
      source_item_id: 'knowledge_items',
      target_item_id: 'knowledge_items',
      project_id: 'research_projects',
      research_object_id: 'research_objects',
      exercise_id: 'exercises',
      template_id: 'workout_templates',
      workout_template_id: 'workout_templates',
      session_id: 'workout_sessions',
      session_exercise_id: 'workout_session_exercises',
      user_paper_id: 'user_papers',
      planned_task_id: 'tasks',
    };
    for (const [key, table] of Object.entries(refs))
      if (body[key]) await this.row(ctx.sql, ctx.userId, table, body[key]);
    if (body.paper_id) await this.paper(ctx.sql, body.paper_id);
    if (body.timezone && !validTimezone(body.timezone)) throw validation('Invalid IANA timezone');
  }
  private async createEntity(ctx: Context, table: string, input: Row): Promise<Row> {
    const body = { ...input };
    delete body.base_snapshot;
    await this.validateRefs(ctx, body);
    if (table === 'devices') {
      if (body.push_token) {
        if (!this.config.pushEncryptionKey)
          throw validation('Push token storage requires PRISM_PUSH_ENCRYPTION_KEY');
        body.push_token_ciphertext = this.encryptToken(body.push_token);
      }
      delete body.push_token;
      const old = await ctx.sql.query('SELECT * FROM devices WHERE user_id=$1 AND id=$2', [
        ctx.userId,
        body.id,
      ]);
      if (old.rows[0]) {
        const updated = await this.update(ctx.sql, ctx.userId, table, body.id, { ...body, deleted_at: null });
        await this.change(ctx, table, updated);
        return this.serialize(ctx.sql, ctx.userId, table, updated);
      }
    }
    let exercises = body.exercises;
    delete body.exercises;
    if (table === 'review_cards') {
      const prefs = await ctx.sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [ctx.userId]);
      const retention = Number(prefs.rows[0].desired_retention);
      const cfg = await schedulerConfig({ desired_retention: retention });
      const configRow = await this.insert(
        ctx.sql,
        'scheduler_configs',
        { ...cfg, id: randomUUID(), desired_retention: retention, fuzz_enabled: false },
        ctx.userId,
      );
      const state = await createCard(new Date(), {
        ...configRow,
        desired_retention: Number(configRow.desired_retention),
      });
      body.scheduler_config_id = configRow.id;
      body.fsrs_state = state;
      body.due_at = state.dueAt;
    }
    if (table === 'workout_sessions' && body.template_id) {
      const template = await this.row(ctx.sql, ctx.userId, 'workout_templates', body.template_id);
      body.template_snapshot = await this.serialize(ctx.sql, ctx.userId, 'workout_templates', template);
    }
    if (table === 'workout_session_exercises') {
      const ex = await this.row(ctx.sql, ctx.userId, 'exercises', body.exercise_id);
      body.name_snapshot = ex.name;
    }
    if (table === 'workout_sets') {
      const ex = await this.row(ctx.sql, ctx.userId, 'workout_session_exercises', body.session_exercise_id);
      if (body.session_id && body.session_id !== ex.session_id)
        throw validation('Set belongs to another session');
      body.session_id = ex.session_id;
      body.exercise_id = ex.exercise_id;
    }
    const row = await this.insert(ctx.sql, table, body, ctx.userId);
    if (table === 'workout_templates' && Array.isArray(exercises)) {
      for (const ex of exercises) {
        await this.validateRefs(ctx, ex);
        const child = await this.insert(
          ctx.sql,
          'workout_template_exercises',
          { ...ex, template_id: row.id },
          ctx.userId,
        );
        await this.change(ctx, 'workout_template_exercises', child);
      }
    }
    if (table === 'workout_sessions' && row.template_id) {
      const xs = await ctx.sql.query(
        'SELECT * FROM workout_template_exercises WHERE user_id=$1 AND template_id=$2 AND deleted_at IS NULL ORDER BY position,id',
        [ctx.userId, row.template_id],
      );
      for (const x of xs.rows) {
        const ex = await this.row(ctx.sql, ctx.userId, 'exercises', x.exercise_id);
        const child = await this.insert(
          ctx.sql,
          'workout_session_exercises',
          { session_id: row.id, exercise_id: x.exercise_id, name_snapshot: ex.name, position: x.position },
          ctx.userId,
        );
        await this.change(ctx, 'workout_session_exercises', child);
      }
    }
    await this.change(ctx, table, row);
    if (table === 'research_objects')
      await this.audit(ctx, row.project_id, row.id, 'object_created', {
        object_type: row.object_type,
        claim_status: row.claim_status,
        title: row.title,
      });
    if (['workout_sets', 'cardio_entries', 'workout_session_exercises'].includes(table))
      await this.touchSession(ctx, row.session_id);
    return this.serialize(ctx.sql, ctx.userId, table, row);
  }
  private encryptToken(token: string): string {
    const key = Buffer.from(this.config.pushEncryptionKey!, 'base64');
    if (key.length !== 32) throw validation('Push encryption key must be a base64-encoded 32-byte key');
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  private decryptToken(ciphertext: string): string {
    const key = Buffer.from(this.config.pushEncryptionKey ?? '', 'base64');
    if (key.length !== 32) return '';
    try {
      const bytes = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
  private async touchSession(ctx: Context, id: string) {
    const row = await this.update(ctx.sql, ctx.userId, 'workout_sessions', id, {});
    await this.change(ctx, 'workout_sessions', row);
  }
  private async updateEntity(ctx: Context, table: string, id: string, input: Row): Promise<Row> {
    const old = await this.row(ctx.sql, ctx.userId, table, id);
    this.version(old, ctx.expected);
    const body = { ...input };
    delete body.base_snapshot;
    await this.validateRefs(ctx, body);
    if (table === 'devices' && 'push_token' in body) {
      if (body.push_token) {
        if (!this.config.pushEncryptionKey) throw validation('Push token storage is not configured');
        body.push_token_ciphertext = this.encryptToken(body.push_token);
      } else body.push_token_ciphertext = null;
      delete body.push_token;
    }
    if (table === 'workout_sessions' && body.template_id) {
      const template = await this.row(ctx.sql, ctx.userId, 'workout_templates', body.template_id);
      body.template_snapshot = await this.serialize(ctx.sql, ctx.userId, 'workout_templates', template);
    }
    const exercises = body.exercises;
    delete body.exercises;
    if (table === 'workout_templates' && Array.isArray(exercises)) {
      const existing = await ctx.sql.query(
        'SELECT * FROM workout_template_exercises WHERE user_id=$1 AND template_id=$2 AND deleted_at IS NULL',
        [ctx.userId, id],
      );
      for (const ex of existing.rows) {
        const deleted = await this.update(ctx.sql, ctx.userId, 'workout_template_exercises', ex.id, {
          deleted_at: new Date(),
        });
        await this.change(ctx, 'workout_template_exercises', deleted);
      }
      for (const ex of exercises) {
        await this.validateRefs(ctx, ex);
        const previous = existing.rows.find((x) => x.id === ex.id);
        const child = previous
          ? await this.update(ctx.sql, ctx.userId, 'workout_template_exercises', ex.id, {
              ...ex,
              deleted_at: null,
            })
          : await this.insert(ctx.sql, 'workout_template_exercises', { ...ex, template_id: id }, ctx.userId);
        await this.change(ctx, 'workout_template_exercises', child);
      }
    }
    const row = await this.update(ctx.sql, ctx.userId, table, id, body);
    await this.change(ctx, table, row);
    if (table === 'research_objects')
      await this.audit(
        ctx,
        row.project_id,
        row.id,
        old.claim_status !== row.claim_status ? 'claim_status_changed' : 'object_updated',
        {
          previous_status: old.claim_status,
          claim_status: row.claim_status,
          evidence_reference: row.evidence_reference,
          title: row.title,
        },
      );
    if (['workout_sets', 'cardio_entries', 'workout_session_exercises'].includes(table))
      await this.touchSession(ctx, row.session_id);
    return this.serialize(ctx.sql, ctx.userId, table, row);
  }
  private async removeEntity(ctx: Context, table: string, id: string, checkVersion = true): Promise<void> {
    const old = await this.row(ctx.sql, ctx.userId, table, id);
    if (checkVersion) this.version(old, ctx.expected);
    const children: Record<string, [string, string][]> = {
      knowledge_items: [
        ['review_cards', 'knowledge_item_id'],
        ['knowledge_relations', 'source_item_id'],
        ['knowledge_relations', 'target_item_id'],
        ['research_knowledge_links', 'knowledge_item_id'],
      ],
      research_projects: [
        ['research_objects', 'project_id'],
        ['research_paper_links', 'project_id'],
      ],
      research_objects: [['research_knowledge_links', 'research_object_id']],
      workout_templates: [['workout_template_exercises', 'template_id']],
      workout_sessions: [
        ['workout_session_exercises', 'session_id'],
        ['workout_sets', 'session_id'],
        ['cardio_entries', 'session_id'],
      ],
      workout_session_exercises: [['workout_sets', 'session_exercise_id']],
    };
    for (const [child, col] of children[table] ?? []) {
      const rs = await ctx.sql.query(
        `SELECT id FROM ${child} WHERE user_id=$1 AND ${col}=$2 AND deleted_at IS NULL`,
        [ctx.userId, id],
      );
      for (const r of rs.rows) await this.removeEntity(ctx, child, r.id, false);
    }
    if (table === 'research_projects') {
      const ts = await ctx.sql.query(
        "SELECT * FROM tasks WHERE user_id=$1 AND project_id=$2 AND deleted_at IS NULL AND status<>'completed'",
        [ctx.userId, id],
      );
      for (const task of ts.rows) {
        const x = await this.update(ctx.sql, ctx.userId, 'tasks', task.id, { status: 'archived' });
        await this.change(ctx, 'tasks', x);
      }
    }
    const deleted = await this.update(ctx.sql, ctx.userId, table, id, { deleted_at: new Date() });
    await this.change(ctx, table, deleted);
    if (table === 'research_objects')
      await this.audit(ctx, old.project_id, id, 'object_archived', { title: old.title });
    if (['workout_sets', 'cardio_entries'].includes(table)) await this.touchSession(ctx, old.session_id);
  }
  async dispatchMutation(ctx: Context, c: Command): Promise<Result> {
    const path = c.path.replace(/^\/api\/v1/, '').replace(/^\//, ''),
      parts = path.split('/'),
      body = c.body ?? {};
    if (path === 'me' || path === 'me/preferences') {
      const table = path === 'me' ? 'users' : 'user_preferences';
      const old = (
        await ctx.sql.query(`SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'}=$1`, [
          ctx.userId,
        ])
      ).rows[0];
      this.version(old, ctx.expected);
      await this.validateRefs(ctx, body);
      const row = await this.update(ctx.sql, ctx.userId, table, old.id, body);
      await this.change(ctx, table, row);
      return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, table, row) };
    }
    if (path === 'review/events') return this.rate(ctx, body);
    if (path === 'daily-plans/generate') return { status: 200, body: await this.generate(ctx, body) };
    if (parts[0] === 'daily-plans' && parts.length >= 3) {
      const plan = await this.row(ctx.sql, ctx.userId, 'daily_plans', parts[1]);
      if (parts[2] === 'reorder') {
        this.version(plan, ctx.expected);
        const all = await ctx.sql.query(
          'SELECT * FROM daily_plan_items WHERE user_id=$1 AND daily_plan_id=$2 AND deleted_at IS NULL ORDER BY position,id',
          [ctx.userId, plan.id],
        );
        if (
          body.item_ids.length !== all.rows.length ||
          new Set(body.item_ids).size !== all.rows.length ||
          body.item_ids.some((id: string) => !all.rows.some((x) => x.id === id))
        )
          throw validation('Reorder must contain every plan item exactly once');
        await ctx.sql.query(
          'UPDATE daily_plan_items SET position=position+100000 WHERE user_id=$1 AND daily_plan_id=$2 AND deleted_at IS NULL',
          [ctx.userId, plan.id],
        );
        for (const [position, id] of body.item_ids.entries()) {
          const row = await this.update(ctx.sql, ctx.userId, 'daily_plan_items', id, {
            position,
            manually_placed: true,
          });
          await this.change(ctx, 'daily_plan_items', row);
        }
        const updated = await this.update(ctx.sql, ctx.userId, 'daily_plans', plan.id, {});
        await this.change(ctx, 'daily_plans', updated);
        return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'daily_plans', updated) };
      }
      if (parts[2] === 'items') {
        const item = await this.row(ctx.sql, ctx.userId, 'daily_plan_items', parts[3]);
        if (item.daily_plan_id !== plan.id) throw notFound();
        this.version(item, ctx.expected);
        if (body.status === 'deferred' && !body.deferred_reason)
          throw validation('Deferral requires a reason');
        const row = await this.update(ctx.sql, ctx.userId, 'daily_plan_items', item.id, {
          ...body,
          manually_placed: true,
        });
        await this.change(ctx, 'daily_plan_items', row);
        await this.change(
          ctx,
          'daily_plans',
          await this.update(ctx.sql, ctx.userId, 'daily_plans', plan.id, {}),
        );
        return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'daily_plan_items', row) };
      }
      if (parts[2] === 'shutdown') {
        const summary = await this.shutdown(ctx.sql, ctx.userId, dateOnly(plan.plan_date), body.note ?? '');
        const prior = await ctx.sql.query(
          'SELECT * FROM daily_shutdowns WHERE user_id=$1 AND daily_plan_id=$2',
          [ctx.userId, plan.id],
        );
        const row = prior.rows[0]
          ? await this.update(ctx.sql, ctx.userId, 'daily_shutdowns', prior.rows[0].id, {
              summary,
              note: body.note ?? '',
            })
          : await this.insert(
              ctx.sql,
              'daily_shutdowns',
              { daily_plan_id: plan.id, summary, note: body.note ?? '' },
              ctx.userId,
            );
        await this.change(ctx, 'daily_shutdowns', row);
        return { status: 200, body: summary };
      }
    }
    if (parts[0] === 'tasks' && parts.length === 3) {
      const task = await this.row(ctx.sql, ctx.userId, 'tasks', parts[1]);
      if (parts[2] === 'complete' && task.status === 'completed')
        return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'tasks', task) };
      this.version(task, ctx.expected);
      const patch =
        parts[2] === 'complete'
          ? {
              status: 'completed',
              completed_at: body.completed_at,
              actual_minutes: body.actual_minutes ?? null,
            }
          : body;
      const row = await this.update(ctx.sql, ctx.userId, 'tasks', task.id, patch);
      await this.change(ctx, 'tasks', row);
      if (parts[2] === 'complete') {
        if (task.project_id)
          await this.audit(ctx, task.project_id, task.research_object_id, 'task_completed', {
            task_id: task.id,
            title: task.title,
          });
        await this.completePlanTask(ctx, task.id);
      }
      if (parts[2] === 'reschedule' && body.planned_date) {
        const items = (
          await ctx.sql.query(
            "SELECT i.* FROM daily_plan_items i JOIN daily_plans p ON p.id=i.daily_plan_id AND p.user_id=i.user_id WHERE i.user_id=$1 AND i.task_id=$2 AND p.plan_date<$3 AND i.deleted_at IS NULL AND i.status IN('planned','deferred')",
            [ctx.userId, task.id, body.planned_date],
          )
        ).rows;
        for (const item of items) {
          await this.change(
            ctx,
            'daily_plan_items',
            await this.update(ctx.sql, ctx.userId, 'daily_plan_items', item.id, {
              status: 'deferred',
              manually_placed: true,
              deferred_reason: `You scheduled this task for ${body.planned_date}. The deadline is preserved unless explicitly updated.`,
            }),
          );
          await this.change(
            ctx,
            'daily_plans',
            await this.update(ctx.sql, ctx.userId, 'daily_plans', item.daily_plan_id, {}),
          );
        }
      }
      return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'tasks', row) };
    }
    if (parts[0] === 'inbox' && parts[2] === 'classify') {
      const entry = await this.row(ctx.sql, ctx.userId, 'inbox_entries', parts[1]);
      this.version(entry, ctx.expected);
      if (entry.classified_task_id || entry.classified_knowledge_id)
        throw validation('Inbox entry is already classified');
      const table = body.destination === 'knowledge' ? 'knowledge_items' : 'tasks';
      const target = await this.createEntity(ctx, table, body.item);
      const row = await this.update(ctx.sql, ctx.userId, 'inbox_entries', entry.id, {
        [body.destination === 'knowledge' ? 'classified_knowledge_id' : 'classified_task_id']: target.id,
      });
      await this.change(ctx, 'inbox_entries', row);
      return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'inbox_entries', row) };
    }
    if (parts[0] === 'knowledge-items' && parts[2] === 'cards') {
      await this.row(ctx.sql, ctx.userId, 'knowledge_items', parts[1]);
      return {
        status: 201,
        body: await this.createEntity(ctx, 'review_cards', { ...body, knowledge_item_id: parts[1] }),
      };
    }
    if (parts[0] === 'research' && parts[1] === 'projects' && parts[3] === 'objects') {
      await this.row(ctx.sql, ctx.userId, 'research_projects', parts[2]);
      return {
        status: 201,
        body: await this.createEntity(ctx, 'research_objects', { ...body, project_id: parts[2] }),
      };
    }
    if (parts[0] === 'fitness' && parts[1] === 'sessions' && parts.length === 4) {
      const session = await this.row(ctx.sql, ctx.userId, 'workout_sessions', parts[2]);
      if (session.status === 'cancelled') throw validation('Cancelled session cannot be changed');
      if (parts[3] === 'complete') {
        if (session.status === 'completed')
          return {
            status: 200,
            body: await this.serialize(ctx.sql, ctx.userId, 'workout_sessions', session),
          };
        this.version(session, ctx.expected);
        const row = await this.update(ctx.sql, ctx.userId, 'workout_sessions', session.id, {
          status: 'completed',
          ended_at: body.ended_at,
        });
        await this.change(ctx, 'workout_sessions', row);
        if (body.complete_planned_task && session.planned_task_id) {
          const t = await this.row(ctx.sql, ctx.userId, 'tasks', session.planned_task_id);
          if (t.status !== 'completed') {
            const done = await this.update(ctx.sql, ctx.userId, 'tasks', t.id, {
              status: 'completed',
              completed_at: body.ended_at,
            });
            await this.change(ctx, 'tasks', done);
            await this.completePlanTask(ctx, t.id);
          }
        }
        return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'workout_sessions', row) };
      }
      const table = (
        { exercises: 'workout_session_exercises', sets: 'workout_sets', cardio: 'cardio_entries' } as Record<
          string,
          string
        >
      )[parts[3]];
      if (table)
        return {
          status: 201,
          body: await this.createEntity(ctx, table, { ...body, session_id: session.id }),
        };
    }
    if (parts[0] === 'arxiv' && parts[1] === 'papers') return this.paperAction(ctx, parts[2], parts[3], body);
    if (parts[0] === 'sync' && parts[1] === 'conflicts' && parts[3] === 'resolve')
      return this.resolveConflict(ctx, parts[2], body);
    if (path === 'sync/snapshots') return this.snapshot(ctx, body);
    if (path === 'exports') {
      const record = await this.insert(
        ctx.sql,
        'exports',
        { formats: body.formats, status: 'pending' },
        ctx.userId,
      );
      await this.buildExport(ctx, record);
      return {
        status: 202,
        body: await this.serialize(
          ctx.sql,
          ctx.userId,
          'exports',
          await this.row(ctx.sql, ctx.userId, 'exports', record.id),
        ),
      };
    }
    for (const [prefix, model] of Object.entries(models))
      if (path === prefix || path.startsWith(prefix + '/')) {
        const rest = path.slice(prefix.length).replace(/^\//, '');
        if (rest.includes('/')) continue;
        if (c.method === 'POST' && !rest)
          return { status: 201, body: await this.createEntity(ctx, model.table, body) };
        if (c.method === 'PATCH' && rest) {
          if (model.table === 'daily_plans') {
            const old = await this.row(ctx.sql, ctx.userId, 'daily_plans', rest);
            this.version(old, ctx.expected);
            return {
              status: 200,
              body: await this.generate(ctx, {
                plan_date: dateOnly(old.plan_date),
                timezone: old.timezone,
                capacity_minutes: body.capacity_minutes,
                override_manual: false,
              }),
            };
          }
          return { status: 200, body: await this.updateEntity(ctx, model.table, rest, body) };
        }
        if (c.method === 'DELETE' && rest) {
          await this.removeEntity(ctx, model.table, rest);
          return { status: 204, body: null };
        }
      }
    throw notFound();
  }
  private async completePlanTask(ctx: Context, taskId: string) {
    const items = await ctx.sql.query(
      "SELECT * FROM daily_plan_items WHERE user_id=$1 AND task_id=$2 AND deleted_at IS NULL AND status<>'completed'",
      [ctx.userId, taskId],
    );
    for (const item of items.rows) {
      await this.change(
        ctx,
        'daily_plan_items',
        await this.update(ctx.sql, ctx.userId, 'daily_plan_items', item.id, { status: 'completed' }),
      );
      await this.change(
        ctx,
        'daily_plans',
        await this.update(ctx.sql, ctx.userId, 'daily_plans', item.daily_plan_id, {}),
      );
    }
  }
  private async dependency(sql: Sql, userId: string, key: string): Promise<Row | undefined> {
    const operation = (
      await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
        userId,
        key,
      ])
    ).rows[0];
    if (operation) return operation;
    const api = (
      await sql.query('SELECT * FROM api_idempotency WHERE user_id=$1 AND idempotency_key=$2', [userId, key])
    ).rows[0];
    if (!api) return undefined;
    const batch = (
      await sql.query(
        'SELECT revision,changes FROM sync_change_batches WHERE user_id=$1 AND $2=ANY(operation_ids) ORDER BY revision LIMIT 1',
        [userId, key],
      )
    ).rows[0];
    const identifiers = String(api.path)
      .split('/')
      .filter((x) => uuid.test(x));
    return {
      status:
        api.response_status >= 200 && api.response_status < 300
          ? 'applied'
          : api.response_status === 409 || api.response_status === 412
            ? 'conflict'
            : 'rejected',
      entity_id: api.response_body?.card?.id ?? api.response_body?.id ?? identifiers.at(-1),
      result: {
        body: api.response_body,
        records: batch?.changes ?? [],
        sync_revision: batch ? String(batch.revision) : null,
      },
    };
  }
  private causalVersion(baseline: string | undefined, parent: any): string | undefined {
    if (!parent) return baseline;
    return !baseline || BigInt(parent) > BigInt(baseline) ? String(parent) : baseline;
  }
  private async rate(ctx: Context, body: Row): Promise<Result> {
    if (body.idempotency_key !== ctx.operationId)
      throw validation('Review idempotency key must match request header');
    const card = await this.row(ctx.sql, ctx.userId, 'review_cards', body.card_id, true);
    await this.row(ctx.sql, ctx.userId, 'devices', body.device_id);
    let baseline = body.base_version;
    if (body.depends_on_operation_id) {
      const dep = await this.dependency(ctx.sql, ctx.userId, body.depends_on_operation_id);
      if (!dep || dep.status !== 'applied')
        throw new ApiError(409, 'DEPENDENCY_BLOCKED', 'Previous review is not applied');
      if (dep.entity_id === card.id) baseline = this.causalVersion(baseline, dep.result.body?.card?.version);
    }
    const submission = await this.insert(
      ctx.sql,
      'review_submissions',
      {
        card_id: card.id,
        device_id: body.device_id,
        client_operation_id: ctx.operationId,
        rating: body.rating,
        reviewed_at: body.reviewed_at,
        duration_ms: body.duration_ms,
        base_version: body.base_version,
        depends_on_operation_id: body.depends_on_operation_id ?? null,
        payload: body,
        payload_hash: hash(body),
      },
      ctx.userId,
    );
    let reason: string | null = null;
    let type = 'version';
    const t = new Date(body.reviewed_at).getTime();
    const knowledge = await this.row(ctx.sql, ctx.userId, 'knowledge_items', card.knowledge_item_id, true);
    if (card.deleted_at || knowledge.deleted_at || card.suspended) {
      reason = 'Card is archived or suspended';
      type = 'deleted';
    } else if (String(card.version) !== String(baseline))
      reason = 'Another device changed this card; your rating has been preserved';
    else if (
      t > Date.now() + 300000 ||
      t < new Date(card.created_at).getTime() ||
      (card.last_reviewed_at && t < new Date(card.last_reviewed_at).getTime())
    ) {
      reason = 'Device review time needs correction';
      type = 'clock';
    }
    if (reason) {
      const conflict = await this.insert(
        ctx.sql,
        'sync_conflicts',
        {
          entity_type: 'review_card',
          entity_id: card.id,
          client_operation_id: ctx.operationId,
          conflict_type: type,
          base_payload: { version: body.base_version },
          client_payload: body,
          server_payload: await this.serialize(ctx.sql, ctx.userId, 'review_cards', card),
        },
        ctx.userId,
      );
      await this.change(ctx, 'sync_conflicts', conflict);
      return {
        status: 409,
        body: {
          error: {
            code: 'REVIEW_CONFLICT',
            message: reason,
            details: {
              conflict_id: conflict.id,
              operation_id: ctx.operationId,
              submission_id: submission.id,
              current_version: String(card.version),
            },
          },
        },
      };
    }
    let cfg = await this.row(ctx.sql, ctx.userId, 'scheduler_configs', card.scheduler_config_id);
    const prefs = (
      await ctx.sql.query('SELECT desired_retention FROM user_preferences WHERE user_id=$1', [ctx.userId])
    ).rows[0];
    if (Number(cfg.desired_retention) !== Number(prefs.desired_retention)) {
      cfg = await this.insert(
        ctx.sql,
        'scheduler_configs',
        {
          library_version: cfg.library_version,
          model_version: cfg.model_version,
          adapter_version: cfg.adapter_version,
          parameters: cfg.parameters,
          desired_retention: Number(prefs.desired_retention),
          fuzz_enabled: false,
        },
        ctx.userId,
      );
    }
    const result = await reviewCard({
      cardId: card.id,
      state: card.fsrs_state,
      rating: body.rating,
      reviewedAt: body.reviewed_at,
      config: { ...cfg, desired_retention: Number(cfg.desired_retention) },
    });
    const updated = await this.update(ctx.sql, ctx.userId, 'review_cards', card.id, {
      scheduler_config_id: cfg.id,
      fsrs_state: result.state,
      due_at: result.dueAt,
      last_reviewed_at: body.reviewed_at,
      review_count: result.reviewCount,
      lapse_count: result.lapseCount,
    });
    const event = await this.insert(
      ctx.sql,
      'review_events',
      {
        card_id: card.id,
        submission_id: submission.id,
        rating: body.rating,
        reviewed_at: body.reviewed_at,
        effective_at: body.reviewed_at,
        duration_ms: body.duration_ms,
        previous_state: card.fsrs_state,
        resulting_state: result.state,
        scheduler_config_id: cfg.id,
        idempotency_key: ctx.operationId,
        card_version_before: card.version,
        card_version_after: updated.version,
      },
      ctx.userId,
    );
    await this.change(ctx, 'review_cards', updated);
    await this.change(ctx, 'review_events', event);
    const planItems = await ctx.sql.query(
      "SELECT DISTINCT i.* FROM daily_plan_items i JOIN daily_plan_review_cards p ON p.plan_item_id=i.id AND p.user_id=i.user_id WHERE i.user_id=$1 AND p.card_id=$2 AND i.deleted_at IS NULL AND p.deleted_at IS NULL AND i.status='planned'",
      [ctx.userId, card.id],
    );
    for (const item of planItems.rows) {
      const remaining = await ctx.sql.query(
        'SELECT count(*)::int n FROM daily_plan_review_cards p JOIN review_cards c ON c.user_id=p.user_id AND c.id=p.card_id WHERE p.user_id=$1 AND p.plan_item_id=$2 AND p.deleted_at IS NULL AND (c.last_reviewed_at IS NULL OR c.last_reviewed_at<$3)',
        [ctx.userId, item.id, item.created_at],
      );
      if (remaining.rows[0].n === 0) {
        await this.change(
          ctx,
          'daily_plan_items',
          await this.update(ctx.sql, ctx.userId, 'daily_plan_items', item.id, { status: 'completed' }),
        );
        await this.change(
          ctx,
          'daily_plans',
          await this.update(ctx.sql, ctx.userId, 'daily_plans', item.daily_plan_id, {}),
        );
      }
    }
    return {
      status: 201,
      body: {
        event: await this.serialize(ctx.sql, ctx.userId, 'review_events', event),
        card: await this.serialize(ctx.sql, ctx.userId, 'review_cards', updated),
        operation_id: ctx.operationId,
        sync_revision: null,
      },
    };
  }
  private async generate(ctx: Context, body: Row): Promise<Row> {
    if (!validTimezone(body.timezone)) throw validation('Invalid IANA timezone');
    const date = body.plan_date;
    const prefs = (await ctx.sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [ctx.userId]))
      .rows[0];
    const tasks = (
      await ctx.sql.query(
        'SELECT t.*,coalesce(p.importance,3) project_importance FROM tasks t LEFT JOIN research_projects p ON p.user_id=t.user_id AND p.id=t.project_id WHERE t.user_id=$1 AND t.deleted_at IS NULL',
        [ctx.userId],
      )
    ).rows.map((x) => ({
      ...x,
      due_at: x.due_at ? new Date(x.due_at).toISOString() : null,
      planned_date: x.planned_date ? dateOnly(x.planned_date) : null,
    }));
    const cards = (
      await ctx.sql.query(
        'SELECT c.id,c.due_at FROM review_cards c JOIN knowledge_items k ON k.user_id=c.user_id AND k.id=c.knowledge_item_id WHERE c.user_id=$1 AND NOT c.suspended AND c.deleted_at IS NULL AND k.deleted_at IS NULL',
        [ctx.userId],
      )
    ).rows.map((x) => ({ id: x.id, due_at: new Date(x.due_at).toISOString() }));
    const prior = (
      await ctx.sql.query(
        'SELECT * FROM daily_plans WHERE user_id=$1 AND plan_date=$2 AND deleted_at IS NULL',
        [ctx.userId, date],
      )
    ).rows[0];
    const existing = prior
      ? await this.childRows(ctx.sql, ctx.userId, 'daily_plan_items', 'daily_plan_id', prior.id, 'position')
      : [];
    const input = {
      planDate: date,
      timezone: body.timezone,
      asOf: body.as_of ?? new Date().toISOString(),
      capacityMinutes: body.capacity_minutes,
      reviewLimit: prefs.daily_review_limit,
      tasks: tasks as PlannerTask[],
      cards,
      existingItems: existing as PlannerItem[],
      overrideManual: !!body.override_manual,
    };
    const output = generatePlan(input);
    const values = {
      plan_date: date,
      timezone: body.timezone,
      capacity_minutes: body.capacity_minutes,
      generation_version: output.version,
      input_hash: hash(input),
      overload_minutes: output.overloadMinutes,
    };
    const plan = prior
      ? await this.update(ctx.sql, ctx.userId, 'daily_plans', prior.id, values)
      : await this.insert(ctx.sql, 'daily_plans', values, ctx.userId);
    const oldItems = prior
      ? (
          await ctx.sql.query(
            'SELECT * FROM daily_plan_items WHERE user_id=$1 AND daily_plan_id=$2 AND deleted_at IS NULL',
            [ctx.userId, plan.id],
          )
        ).rows
      : [];
    await ctx.sql.query(
      'UPDATE daily_plan_items SET position=position+100000 WHERE user_id=$1 AND daily_plan_id=$2 AND deleted_at IS NULL',
      [ctx.userId, plan.id],
    );
    const keep = new Set<string>();
    for (const item of output.items) {
      const id = item.id ?? randomUUID();
      keep.add(id);
      const data = { ...item, id, daily_plan_id: plan.id };
      delete (data as Row).review_card_ids;
      delete (data as Row).next_available_at;
      const old = oldItems.find((x) => x.id === id);
      const row = old
        ? await this.update(ctx.sql, ctx.userId, 'daily_plan_items', id, data)
        : await this.insert(ctx.sql, 'daily_plan_items', data, ctx.userId);
      const links = (
        await ctx.sql.query(
          'SELECT * FROM daily_plan_review_cards WHERE user_id=$1 AND plan_item_id=$2 AND deleted_at IS NULL',
          [ctx.userId, id],
        )
      ).rows;
      for (const link of links) {
        await this.change(
          ctx,
          'daily_plan_review_cards',
          await this.update(ctx.sql, ctx.userId, 'daily_plan_review_cards', link.id, {
            deleted_at: new Date(),
          }),
        );
      }
      for (const [position, cardId] of item.review_card_ids.entries()) {
        const previous = links.find((x) => x.card_id === cardId);
        const link = previous
          ? await this.update(ctx.sql, ctx.userId, 'daily_plan_review_cards', previous.id, {
              position,
              deleted_at: null,
            })
          : await this.insert(
              ctx.sql,
              'daily_plan_review_cards',
              { plan_item_id: id, card_id: cardId, position },
              ctx.userId,
            );
        await this.change(ctx, 'daily_plan_review_cards', link);
      }
      await this.change(ctx, 'daily_plan_items', row);
    }
    for (const old of oldItems)
      if (!keep.has(old.id)) {
        await this.change(
          ctx,
          'daily_plan_items',
          await this.update(ctx.sql, ctx.userId, 'daily_plan_items', old.id, { deleted_at: new Date() }),
        );
        const links = (
          await ctx.sql.query(
            'SELECT * FROM daily_plan_review_cards WHERE user_id=$1 AND plan_item_id=$2 AND deleted_at IS NULL',
            [ctx.userId, old.id],
          )
        ).rows;
        for (const link of links)
          await this.change(
            ctx,
            'daily_plan_review_cards',
            await this.update(ctx.sql, ctx.userId, 'daily_plan_review_cards', link.id, {
              deleted_at: new Date(),
            }),
          );
      }
    await this.change(ctx, 'daily_plans', plan);
    return this.serialize(ctx.sql, ctx.userId, 'daily_plans', plan);
  }
  private async paperAction(ctx: Context, id: string, action: string, body: Row): Promise<Result> {
    await this.paper(ctx.sql, id);
    let userPaper = (
      await ctx.sql.query('SELECT * FROM user_papers WHERE user_id=$1 AND paper_id=$2', [ctx.userId, id])
    ).rows[0];
    if (!userPaper) userPaper = await this.insert(ctx.sql, 'user_papers', { paper_id: id }, ctx.userId);
    if (action === 'create-task') {
      const old = (
        await ctx.sql.query(
          "SELECT * FROM tasks WHERE user_id=$1 AND user_paper_id=$2 AND source_type='reading' AND status NOT IN('completed','archived') AND deleted_at IS NULL",
          [ctx.userId, userPaper.id],
        )
      ).rows[0];
      await this.change(ctx, 'user_papers', userPaper);
      if (old) return { status: 201, body: await this.serialize(ctx.sql, ctx.userId, 'tasks', old) };
      return {
        status: 201,
        body: await this.createEntity(ctx, 'tasks', {
          ...body,
          source_type: 'reading',
          user_paper_id: userPaper.id,
        }),
      };
    }
    const patch: Row =
      action === 'save'
        ? { is_saved: true, saved_at: userPaper.saved_at ?? new Date() }
        : action === 'mark-read'
          ? { status: 'read', read_at: userPaper.read_at ?? new Date() }
          : body;
    if (action === 'state') this.version(userPaper, ctx.expected);
    if (patch.is_saved === true) patch.saved_at = userPaper.saved_at ?? new Date();
    if (patch.is_saved === false) patch.saved_at = null;
    if (patch.status === 'read') patch.read_at = userPaper.read_at ?? new Date();
    const row = await this.update(ctx.sql, ctx.userId, 'user_papers', userPaper.id, patch);
    await this.change(ctx, 'user_papers', row);
    return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'user_papers', row) };
  }
  async list(sql: Sql, userId: string, table: string, query: Row = {}, fixed: Row = {}): Promise<Row> {
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
    const clauses = [`${table === 'users' ? 'id' : 'user_id'}=$1`];
    const params: any[] = [userId];
    if (this.columns.get(table)?.has('deleted_at')) clauses.push('deleted_at IS NULL');
    if (table === 'inbox_entries')
      clauses.push('classified_task_id IS NULL AND classified_knowledge_id IS NULL');
    const filters = { ...fixed };
    for (const key of [
      'project_id',
      'knowledge_item_id',
      'research_object_id',
      'source_item_id',
      'target_item_id',
      'session_id',
      'template_id',
      'exercise_id',
      'status',
      'subject',
      'planned_date',
      'subscription_type',
    ])
      if (query[key] !== undefined && this.columns.get(table)?.has(key)) filters[key] = query[key];
    for (const [key, value] of Object.entries(filters)) {
      params.push(value);
      clauses.push(`${key}=$${params.length}`);
    }
    if (query.q) {
      const cols = ['title', 'name', 'content'].filter((k) => this.columns.get(table)?.has(k));
      if (cols.length) {
        params.push('%' + query.q + '%');
        clauses.push('(' + cols.map((k) => `${k} ILIKE $${params.length}`).join(' OR ') + ')');
      }
    }
    if (query.tag && this.columns.get(table)?.has('tags')) {
      params.push(query.tag);
      clauses.push(`$${params.length}=ANY(tags)`);
    }
    const time =
      table === 'review_events' ? 'reviewed_at' : table === 'workout_sessions' ? 'started_at' : 'created_at';
    if (query.from) {
      params.push(query.from);
      clauses.push(`${time}>=$${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      clauses.push(`${time}<$${params.length}`);
    }
    const binding = hash({ ...query, cursor: undefined, limit: undefined, fixed });
    if (query.cursor) {
      const cursor = this.decode(query.cursor, userId, 'list:' + table);
      if (cursor.binding !== binding) throw validation('Cursor filters changed');
      params.push(cursor.time, cursor.id);
      clauses.push(`(${time},id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const result = await sql.query(
      `SELECT *,${time}::text __cursor_time FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY ${time} DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    const more = result.rows.length > limit,
      rows = result.rows.slice(0, limit),
      last = rows.at(-1);
    return {
      items: await Promise.all(rows.map((r) => this.serialize(sql, userId, table, r))),
      next_cursor:
        more && last
          ? this.cursor(userId, 'list:' + table, { time: last.__cursor_time, id: last.id, binding })
          : null,
    };
  }
  async query(userId: string, path: string, query: Row = {}): Promise<any> {
    return this.read(userId, async (sql) => {
      const p = path.replace(/^\/api\/v1/, '').replace(/^\//, ''),
        parts = p.split('/');
      if (p === 'me' || p === 'me/preferences') {
        const table = p === 'me' ? 'users' : 'user_preferences';
        const row = (
          await sql.query(`SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'}=$1`, [userId])
        ).rows[0];
        if (!row) throw notFound();
        return this.serialize(sql, userId, table, row);
      }
      if (p === 'today') return this.today(sql, userId, query.date);
      if (p === 'today/shutdown') return this.shutdown(sql, userId, query.date);
      if (p === 'review/queue') {
        const asOf = query.as_of ?? new Date().toISOString();
        const limit = Math.min(500, Number(query.limit) || 50);
        const params: any[] = [userId, asOf];
        let after = '';
        if (query.cursor) {
          const c = this.decode(query.cursor, userId, 'review-queue');
          if (c.asOf !== asOf && query.as_of) throw validation('Review cursor time changed');
          params[1] = c.asOf;
          params.push(c.due, c.id);
          after = ' AND (c.due_at,c.id)>($3::timestamptz,$4::uuid)';
        }
        params.push(limit + 1);
        const rows = (
          await sql.query(
            `SELECT c.*,c.due_at::text __cursor_time FROM review_cards c JOIN knowledge_items k ON k.id=c.knowledge_item_id AND k.user_id=c.user_id WHERE c.user_id=$1 AND c.due_at<=$2 AND NOT c.suspended AND c.deleted_at IS NULL AND k.deleted_at IS NULL${after} ORDER BY c.due_at,c.id LIMIT $${params.length}`,
            params,
          )
        ).rows;
        const slice = rows.slice(0, limit),
          last = slice.at(-1);
        return {
          items: await Promise.all(slice.map((r) => this.serialize(sql, userId, 'review_cards', r))),
          next_cursor:
            rows.length > limit && last
              ? this.cursor(userId, 'review-queue', { asOf: params[1], due: last.__cursor_time, id: last.id })
              : null,
        };
      }
      if (p === 'review/history')
        return this.list(
          sql,
          userId,
          'review_events',
          query,
          query.card_id ? { card_id: query.card_id } : {},
        );
      if (parts[0] === 'knowledge-items' && parts[2] === 'cards') {
        await this.row(sql, userId, 'knowledge_items', parts[1]);
        return this.list(sql, userId, 'review_cards', query, { knowledge_item_id: parts[1] });
      }
      if (parts[0] === 'research' && parts[1] === 'projects' && parts.length === 4) {
        await this.row(sql, userId, 'research_projects', parts[2]);
        if (parts[3] === 'objects')
          return this.list(sql, userId, 'research_objects', query, { project_id: parts[2] });
        if (parts[3] === 'timeline')
          return this.list(sql, userId, 'research_events', query, { project_id: parts[2] });
      }
      if (p === 'fitness/progression') return this.progression(sql, userId, query);
      if (p === 'arxiv/feed') return this.feed(sql, userId, query);
      if (parts[0] === 'arxiv' && parts[1] === 'papers' && parts.length === 3)
        return this.paper(sql, parts[2]);
      if (p === 'sync/pull') return this.pull(sql, userId, query);
      if (parts[0] === 'sync' && parts[1] === 'snapshots')
        return this.readSnapshot(sql, userId, parts[2], parts[3] === 'records', query);
      for (const [prefix, model] of Object.entries(models))
        if (p === prefix || p.startsWith(prefix + '/')) {
          const rest = p.slice(prefix.length).replace(/^\//, '');
          if (rest.includes('/')) continue;
          if (!rest) return this.list(sql, userId, model.table, query);
          return this.serialize(sql, userId, model.table, await this.row(sql, userId, model.table, rest));
        }
      throw notFound();
    });
  }
  private async feed(sql: Sql, userId: string, q: Row): Promise<Row> {
    const params: any[] = [userId];
    let where = 'u.user_id=$1 AND u.deleted_at IS NULL';
    if (q.status) {
      params.push(q.status);
      where += ` AND u.status=$${params.length}`;
    }
    if (q.saved !== undefined) {
      params.push(q.saved === true || q.saved === 'true');
      where += ` AND u.is_saved=$${params.length}`;
    }
    const bind = hash({ status: q.status, saved: q.saved });
    if (q.cursor) {
      const c = this.decode(q.cursor, userId, 'feed');
      if (c.binding !== bind) throw validation('Cursor filters changed');
      params.push(c.score, c.updated, c.arxivId);
      const n = params.length;
      where += ` AND (u.relevance_score<$${n - 2} OR (u.relevance_score=$${n - 2} AND p.updated_at<$${n - 1}) OR (u.relevance_score=$${n - 2} AND p.updated_at=$${n - 1} AND p.arxiv_id>$${n}))`;
    }
    const limit = Math.min(500, Number(q.limit) || 50);
    params.push(limit + 1);
    const rows = (
      await sql.query(
        `SELECT u.*,p.updated_at paper_updated,p.updated_at::text __cursor_time,p.arxiv_id FROM user_papers u JOIN arxiv_papers p ON p.id=u.paper_id WHERE ${where} ORDER BY u.relevance_score DESC,p.updated_at DESC,p.arxiv_id LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const slice = rows.slice(0, limit),
      last = slice.at(-1);
    return {
      items: await Promise.all(
        slice.map(async (raw) => {
          const r = { ...raw };
          delete r.paper_updated;
          delete r.arxiv_id;
          return this.serialize(sql, userId, 'user_papers', r);
        }),
      ),
      next_cursor:
        rows.length > limit && last
          ? this.cursor(userId, 'feed', {
              score: Number(last.relevance_score),
              updated: last.__cursor_time,
              arxivId: last.arxiv_id,
              binding: bind,
            })
          : null,
    };
  }
  private async progression(sql: Sql, userId: string, q: Row): Promise<Row> {
    if (!q.from || !q.to || new Date(q.from) >= new Date(q.to))
      throw validation('A valid from/to range is required');
    const params: any[] = [userId, q.from, q.to];
    let exercise = '';
    if (q.exercise_id) {
      params.push(q.exercise_id);
      exercise = ` AND w.exercise_id=$${params.length}`;
    }
    const sets = (
      await sql.query(
        `SELECT w.*,s.started_at,s.started_at::text __cursor_time FROM workout_sets w JOIN workout_sessions s ON s.user_id=w.user_id AND s.id=w.session_id WHERE w.user_id=$1 AND s.started_at>=$2 AND s.started_at<$3 AND s.status='completed' AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND w.completed_at IS NOT NULL${exercise} ORDER BY s.started_at,w.session_id,w.exercise_id`,
        params,
      )
    ).rows;
    const groups = new Map<string, Row>();
    for (const set of sets) {
      const key = set.session_id + ':' + set.exercise_id;
      const g = groups.get(key) ?? {
        exercise_id: set.exercise_id,
        session_id: set.session_id,
        started_at: new Date(set.started_at).toISOString(),
        __cursor_time: set.__cursor_time,
        max_weight_kg: null,
        max_reps: 0,
        volume_kg_reps: 0,
      };
      if (set.weight_kg !== null) g.max_weight_kg = Math.max(g.max_weight_kg ?? 0, Number(set.weight_kg));
      g.max_reps = Math.max(g.max_reps, set.reps);
      g.volume_kg_reps += (Number(set.weight_kg) || 0) * set.reps;
      groups.set(key, g);
    }
    const cardio = await sql.query(
      "SELECT coalesce(sum(c.duration_seconds),0) seconds,coalesce(sum(c.distance_meters),0) meters FROM cardio_entries c JOIN workout_sessions s ON s.user_id=c.user_id AND s.id=c.session_id WHERE c.user_id=$1 AND s.started_at>=$2 AND s.started_at<$3 AND c.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status='completed'",
      [userId, q.from, q.to],
    );
    const weekly = await sql.query(
      "SELECT count(*)::int n FROM workout_sessions WHERE user_id=$1 AND status='completed' AND deleted_at IS NULL AND started_at>=($2::timestamptz-interval '7 days') AND started_at<$2",
      [userId, q.to],
    );
    const binding = hash({ from: q.from, to: q.to, exercise_id: q.exercise_id });
    let points = [...groups.values()];
    if (q.cursor) {
      const c = this.decode(q.cursor, userId, 'progression');
      if (c.binding !== binding) throw validation('Cursor filters changed');
      points = points.filter(
        (x) =>
          x.__cursor_time > c.time ||
          (x.__cursor_time === c.time && x.session_id + ':' + x.exercise_id > c.key),
      );
    }
    const limit = Math.min(500, Number(q.limit) || 50),
      slice = points.slice(0, limit),
      last = slice.at(-1);
    return {
      weekly_sessions: weekly.rows[0].n,
      total_completed_sets: sets.length,
      volume_kg_reps: sets.reduce((sum, r) => sum + (Number(r.weight_kg) || 0) * r.reps, 0),
      cardio_duration_seconds: Number(cardio.rows[0].seconds),
      cardio_distance_meters: Number(cardio.rows[0].meters),
      points: slice.map((x) => {
        const row = { ...x };
        delete row.__cursor_time;
        return row;
      }),
      next_cursor:
        points.length > limit && last
          ? this.cursor(userId, 'progression', {
              time: last.__cursor_time,
              key: last.session_id + ':' + last.exercise_id,
              binding,
            })
          : null,
    };
  }
  private async today(sql: Sql, userId: string, date: string): Promise<Row> {
    const user = await this.row(sql, userId, 'users', userId);
    const prefs = (await sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [userId])).rows[0];
    const range = localDayRange(date, user.timezone),
      now = new Date().toISOString();
    const reviews = await sql.query(
      'SELECT count(*) FILTER(WHERE c.due_at<=$2)::int now_count,count(*) FILTER(WHERE c.due_at<$3)::int day_count FROM review_cards c JOIN knowledge_items k ON k.id=c.knowledge_item_id AND k.user_id=c.user_id WHERE c.user_id=$1 AND c.deleted_at IS NULL AND NOT c.suspended AND k.deleted_at IS NULL',
      [userId, now, range.end],
    );
    const research = await sql.query(
      "SELECT count(*)::int n FROM tasks WHERE user_id=$1 AND source_type='research' AND due_at<$2 AND status IN('ready','in_progress') AND deleted_at IS NULL",
      [userId, range.end],
    );
    const workout = (
      await sql.query(
        "SELECT * FROM tasks WHERE user_id=$1 AND source_type='workout' AND planned_date=$2 AND status IN('ready','in_progress') AND deleted_at IS NULL ORDER BY pinned DESC,priority DESC,id LIMIT 1",
        [userId, date],
      )
    ).rows[0];
    const papers = await sql.query(
      "SELECT count(*) FILTER(WHERE status='unread')::int unread,count(*) FILTER(WHERE is_saved)::int saved FROM user_papers WHERE user_id=$1 AND deleted_at IS NULL",
      [userId],
    );
    const plan = (
      await sql.query('SELECT * FROM daily_plans WHERE user_id=$1 AND plan_date=$2 AND deleted_at IS NULL', [
        userId,
        date,
      ])
    ).rows[0];
    const serialized = plan ? await this.serialize(sql, userId, 'daily_plans', plan) : null;
    const items = serialized?.items ?? [];
    return {
      date,
      timezone: user.timezone,
      as_of: now,
      reviews_due_now: reviews.rows[0].now_count,
      reviews_due_by_end_of_day: reviews.rows[0].day_count,
      research_tasks_due: research.rows[0].n,
      planned_workout: workout ? await this.serialize(sql, userId, 'tasks', workout) : null,
      unread_papers: papers.rows[0].unread,
      saved_papers: papers.rows[0].saved,
      capacity_minutes: plan?.capacity_minutes ?? prefs.default_study_capacity_minutes,
      estimated_remaining_minutes: items
        .filter((x: Row) => x.status === 'planned')
        .reduce((s: number, x: Row) => s + x.scheduled_minutes, 0),
      completed_count: items.filter((x: Row) => x.status === 'completed').length,
      planned_count: items.filter((x: Row) => !['skipped', 'deferred'].includes(x.status)).length,
      plan: serialized,
    };
  }
  private async shutdown(sql: Sql, userId: string, date: string, note = ''): Promise<Row> {
    const user = await this.row(sql, userId, 'users', userId),
      range = localDayRange(date, user.timezone);
    const plan = (
      await sql.query('SELECT * FROM daily_plans WHERE user_id=$1 AND plan_date=$2 AND deleted_at IS NULL', [
        userId,
        date,
      ])
    ).rows[0];
    if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Generate a daily plan before shutdown');
    const items = await this.childRows(sql, userId, 'daily_plan_items', 'daily_plan_id', plan.id, 'position');
    const ratings = await sql.query(
      'SELECT rating,count(*)::int n FROM review_events WHERE user_id=$1 AND reviewed_at>=$2 AND reviewed_at<$3 GROUP BY rating',
      [userId, range.start, range.end],
    );
    const counts: Row = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const r of ratings.rows) counts[r.rating] = r.n;
    const workouts = await sql.query(
      "SELECT count(*)::int n FROM workout_sessions WHERE user_id=$1 AND status='completed' AND ended_at>=$2 AND ended_at<$3 AND deleted_at IS NULL",
      [userId, range.start, range.end],
    );
    const research = await sql.query(
      'SELECT count(*)::int n FROM research_events WHERE user_id=$1 AND created_at>=$2 AND created_at<$3',
      [userId, range.start, range.end],
    );
    const next = await sql.query(
      "SELECT id FROM tasks WHERE user_id=$1 AND deleted_at IS NULL AND status IN('ready','in_progress') ORDER BY hard_deadline DESC,pinned DESC,due_at NULLS LAST,priority DESC,id LIMIT 5",
      [userId],
    );
    return {
      date,
      plan_id: plan.id,
      completed_task_ids: items.filter((x) => x.status === 'completed' && x.task_id).map((x) => x.task_id),
      deferred_item_ids: items.filter((x) => x.status === 'deferred').map((x) => x.id),
      review_count: Object.values(counts).reduce((s: number, x) => s + Number(x), 0),
      rating_counts: counts,
      workout_count: workouts.rows[0].n,
      research_event_count: research.rows[0].n,
      next_day_task_ids: next.rows.map((x) => x.id),
      note,
    };
  }
  private async snapshot(ctx: Context, body: Row): Promise<Result> {
    await this.row(ctx.sql, ctx.userId, 'devices', body.device_id);
    const state = (
      await ctx.sql.query('SELECT id,revision FROM user_sync_state WHERE user_id=$1', [ctx.userId])
    ).rows[0];
    const records = await this.snapshotRecords(ctx.sql, ctx.userId);
    const row = await this.insert(
      ctx.sql,
      'sync_snapshots',
      {
        base_revision: state.revision,
        records,
        schema_version: '1:' + state.id,
        expires_at: new Date(Date.now() + 86400000),
      },
      ctx.userId,
    );
    return {
      status: 201,
      body: {
        id: row.id,
        schema_version: '1',
        base_revision: String(state.revision),
        total_records: records.length,
        expires_at: new Date(row.expires_at).toISOString(),
      },
    };
  }
  private async snapshotRecords(sql: Sql, userId: string, includeHistory = false): Promise<Row[]> {
    const records: Row[] = [];
    for (const [table, kind] of Object.entries(tableKinds)) {
      if (protectedTables.has(table)) continue;
      const owner = table === 'users' ? 'id' : 'user_id';
      const rows = (
        await sql.query(
          `SELECT * FROM ${table} WHERE ${owner}=$1${!includeHistory && this.columns.get(table)?.has('deleted_at') ? ' AND deleted_at IS NULL' : ''} ORDER BY id`,
          [userId],
        )
      ).rows;
      for (const row of rows)
        records.push({
          entity_type: kind,
          entity_id: row.id,
          entity_version: String(row.version ?? 1),
          deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
          data: row.deleted_at && !includeHistory ? null : await this.serialize(sql, userId, table, row),
        });
    }
    return records;
  }
  private async readSnapshot(sql: Sql, userId: string, id: string, records: boolean, q: Row): Promise<Row> {
    const row = await this.row(sql, userId, 'sync_snapshots', id);
    if (new Date(row.expires_at).getTime() < Date.now())
      throw new ApiError(410, 'SNAPSHOT_EXPIRED', 'Snapshot expired');
    const generation = String(row.schema_version).startsWith('1:')
      ? String(row.schema_version).slice(2)
      : undefined;
    const head = (await sql.query('SELECT id FROM user_sync_state WHERE user_id=$1', [userId])).rows[0];
    if (!generation || generation !== head?.id)
      throw new ApiError(
        410,
        'SYNC_CURSOR_EXPIRED',
        'Snapshot belongs to a reset synchronization stream; bootstrap again',
        { reason: 'STREAM_RESET' },
      );
    if (!records)
      return {
        id: row.id,
        schema_version: '1',
        base_revision: String(row.base_revision),
        total_records: row.records.length,
        expires_at: new Date(row.expires_at).toISOString(),
      };
    let offset = 0;
    if (q.cursor) {
      const c = this.decode(q.cursor, userId, 'snapshot');
      if (c.snapshot !== id) throw validation('Cursor snapshot mismatch');
      offset = c.offset;
    }
    const limit = Math.min(500, Number(q.limit) || 100),
      next = offset + limit;
    return {
      snapshot_id: id,
      records: row.records.slice(offset, next),
      next_page_cursor:
        next < row.records.length ? this.cursor(userId, 'snapshot', { snapshot: id, offset: next }) : null,
      resume_sync_cursor: this.cursor(userId, 'sync', {
        revision: String(row.base_revision),
        stream: generation,
      }),
      base_revision: String(row.base_revision),
    };
  }
  private async pull(sql: Sql, userId: string, q: Row): Promise<Row> {
    if (!q.cursor) throw validation('Sync cursor is required; bootstrap with a snapshot');
    const c = this.decode(q.cursor, userId, 'sync');
    const state = (
      await sql.query('SELECT id,revision,min_available_revision FROM user_sync_state WHERE user_id=$1', [
        userId,
      ])
    ).rows[0];
    if (typeof c.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(c.revision))
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor revision');
    if (!c.stream || c.stream !== state.id)
      throw new ApiError(410, 'SYNC_CURSOR_EXPIRED', 'Synchronization stream was reset; bootstrap again', {
        reason: 'STREAM_RESET',
      });
    if (BigInt(c.revision) < BigInt(state.min_available_revision))
      throw new ApiError(410, 'SYNC_CURSOR_EXPIRED', 'Sync history expired; bootstrap again', {
        reason: 'HISTORY_EXPIRED',
      });
    if (BigInt(c.revision) > BigInt(state.revision))
      throw new ApiError(
        410,
        'SYNC_CURSOR_EXPIRED',
        'Server was restored behind this cursor; bootstrap again',
        { reason: 'CURSOR_AHEAD' },
      );
    const limit = Math.min(100, Number(q.limit) || 50);
    const rows = (
      await sql.query(
        'SELECT * FROM sync_change_batches WHERE user_id=$1 AND revision>$2 ORDER BY revision LIMIT $3',
        [userId, c.revision, limit + 1],
      )
    ).rows;
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      batches: selected.map((r) => ({
        revision: String(r.revision),
        operation_ids: r.operation_ids,
        changes: r.changes,
        committed_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: this.cursor(userId, 'sync', {
        revision: String(last?.revision ?? c.revision),
        stream: state.id,
      }),
      has_more: rows.length > limit,
      server_time: new Date().toISOString(),
    };
  }
  /** Operator-only recovery hook. Call after restore, before accepting new writes; never exposed as an HTTP command. */
  async rotateSyncStream(
    userId: string = this.config.userId,
    reason = 'operator_restore',
  ): Promise<{ previous_generation: string; generation: string; revision: string; reason: string }> {
    if (!uuid.test(userId)) throw validation('Invalid user ID');
    return this.db.transaction(userId, async (sql) => {
      const head = (
        await sql.query('SELECT id,revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId])
      ).rows[0];
      if (!head) throw notFound();
      const generation = randomUUID();
      await sql.query(
        'UPDATE user_sync_state SET id=$2,updated_at=now(),version=version+1 WHERE user_id=$1',
        [userId, generation],
      );
      return { previous_generation: head.id, generation, revision: String(head.revision), reason };
    });
  }
  private mapOperation(userId: string, deviceId: string, op: Row): Command {
    const p = { ...op.payload };
    let method = 'POST',
      path = '';
    const id = op.entity_id;
    const direct: Record<string, string> = {
      knowledge: 'knowledge-items',
      task: 'tasks',
      inbox: 'inbox',
      'workout.session': 'fitness/sessions',
      'workout.set': 'fitness/sets',
      'workout.cardio': 'fitness/cardio',
    };
    if (op.operation === 'review.rate') {
      if (
        p.card_id !== id ||
        p.idempotency_key !== op.client_operation_id ||
        p.device_id !== deviceId ||
        (op.base_version && String(p.base_version) !== String(op.base_version)) ||
        (op.depends_on_operation_id &&
          p.depends_on_operation_id &&
          op.depends_on_operation_id !== p.depends_on_operation_id)
      )
        throw validation('Review operation identifiers and baseline must agree');
      p.device_id = deviceId;
      path = 'review/events';
    } else if (op.operation === 'workout.exercise.create') {
      if (p.id !== id) throw validation('Creation ID must equal payload.id');
      path = 'fitness/sessions/' + p.session_id + '/exercises';
      delete p.session_id;
    } else {
      const action = op.operation.split('.').at(-1)!;
      const prefix = direct[op.operation.slice(0, -action.length - 1)];
      if (!prefix) throw validation('Unsupported offline operation');
      if (action === 'create') {
        if (p.id !== id) throw validation('Creation ID must equal payload.id');
        if (op.operation === 'workout.set.create' || op.operation === 'workout.cardio.create') {
          path =
            'fitness/sessions/' +
            p.session_id +
            '/' +
            (op.operation === 'workout.set.create' ? 'sets' : 'cardio');
          delete p.session_id;
        } else path = prefix;
      } else if (action === 'update') {
        method = 'PATCH';
        path = prefix + '/' + id;
      } else if (action === 'delete') {
        method = 'DELETE';
        path = prefix + '/' + id;
      } else if (action === 'complete') path = prefix + '/' + id + '/complete';
      else throw validation('Unsupported offline operation');
    }
    if (op.depends_on_operation_id && op.operation === 'review.rate')
      p.depends_on_operation_id = op.depends_on_operation_id;
    return {
      userId,
      key: op.client_operation_id,
      method,
      path,
      body: p,
      expected: op.base_version ?? undefined,
      sync: true,
      deviceId,
      dependsOn: op.depends_on_operation_id ?? undefined,
      entityId: op.entity_id,
      entityType: tableKinds[this.operationTable(op.operation) ?? ''] ?? 'command',
    };
  }
  async pushBatch(userId: string, key: string, body: Row): Promise<Row> {
    if (!uuid.test(key)) throw validation('Idempotency-Key must be a UUID');
    if (body.operations.some((op: Row) => op.client_operation_id === key))
      throw validation('Batch key must differ from operation IDs');
    const fingerprint = hash({ batch: body });
    const previous = await this.db.transaction(userId, async (sql) => {
      await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
      await this.row(sql, userId, 'devices', body.device_id);
      const api = (
        await sql.query('SELECT id FROM api_idempotency WHERE user_id=$1 AND idempotency_key=$2', [
          userId,
          key,
        ])
      ).rows[0];
      if (api) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Key already used for a different command');
      const old = (
        await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
          userId,
          key,
        ])
      ).rows[0];
      if (old) {
        if (old.payload_hash !== fingerprint || old.entity_type !== 'sync_batch')
          throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Batch key reused with different content');
        return old;
      }
      await this.insert(
        sql,
        'sync_operations',
        {
          device_id: body.device_id,
          client_operation_id: key,
          entity_type: 'sync_batch',
          entity_id: userId,
          operation_type: 'POST sync/push',
          payload: body,
          payload_hash: fingerprint,
          status: 'blocked',
          result: {},
        },
        userId,
      );
      return undefined;
    });
    if (previous?.status === 'applied') return previous.result;
    const result = await this.push(userId, body);
    await this.db.transaction(userId, async (sql) => {
      await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
      const row = (
        await sql.query(
          'SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2 FOR UPDATE',
          [userId, key],
        )
      ).rows[0];
      if (row.status === 'blocked')
        await this.update(sql, userId, 'sync_operations', row.id, { status: 'applied', result });
    });
    return result;
  }
  async push(userId: string, body: Row): Promise<Row> {
    await this.read(userId, (sql) => this.row(sql, userId, 'devices', body.device_id));
    const results: Row[] = [];
    const remaining = [...body.operations],
      ordered: Row[] = [];
    if (new Set(remaining.map((x) => x.client_operation_id)).size !== remaining.length)
      throw validation('Duplicate operation IDs in one batch');
    while (remaining.length) {
      let index = remaining.findIndex(
        (x) =>
          !x.depends_on_operation_id ||
          !remaining.some((y) => y.client_operation_id === x.depends_on_operation_id),
      );
      if (index < 0) index = 0;
      ordered.push(remaining.splice(index, 1)[0]);
    }
    for (const op of ordered) {
      let command: Command;
      try {
        command = this.mapOperation(userId, body.device_id, op);
      } catch (e) {
        const result = this.syncError(op, e);
        const rejected: Command = {
          userId,
          key: op.client_operation_id,
          method: 'SYNC',
          path: op.operation,
          body: op.payload,
          expected: op.base_version ?? undefined,
        };
        const fingerprint = hash({
          method: rejected.method,
          path: rejected.path,
          body: rejected.body,
          expected: rejected.expected ?? null,
          dependsOn: null,
        });
        await this.saveRejected(userId, body.device_id, op, rejected, fingerprint, result);
        results.push(result);
        continue;
      }
      const fingerprint = commandHash(command);
      const prior = await this.read(
        userId,
        async (sql) =>
          (
            await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
              userId,
              op.client_operation_id,
            ])
          ).rows[0],
      );
      if (prior && prior.payload_hash !== fingerprint) {
        results.push(
          this.syncError(
            op,
            new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Operation ID reused with different payload'),
          ),
        );
        continue;
      }
      if (prior && prior.status !== 'blocked') {
        const r = prior.result;
        results.push({
          client_operation_id: op.client_operation_id,
          status: prior.status === 'applied' ? 'duplicate' : prior.status,
          retryable: false,
          resulting_version: r.body?.version ?? r.body?.card?.version ?? null,
          sync_revision: r.sync_revision ?? null,
          records: r.records ?? [],
          conflict_id: r.body?.error?.details?.conflict_id ?? null,
          error: r.body?.error ? r.body : null,
        });
        continue;
      }
      let dependency: Row | undefined;
      if (op.depends_on_operation_id)
        dependency = await this.read(userId, (sql) =>
          this.dependency(sql, userId, op.depends_on_operation_id),
        );
      if (op.depends_on_operation_id && (!dependency || dependency.status !== 'applied')) {
        const result = this.syncError(
          op,
          new ApiError(
            409,
            dependency ? 'DEPENDENCY_BLOCKED' : 'DEPENDENCY_MISSING',
            'Dependency is not applied',
          ),
          true,
        );
        await this.saveBlocked(userId, body.device_id, op, command, fingerprint, result);
        results.push(result);
        continue;
      }
      try {
        const response = await this.execute(command, async (ctx) => {
          if (dependency && dependency.entity_id === op.entity_id)
            ctx.expected = this.causalVersion(
              ctx.expected,
              dependency.result.body?.version ?? dependency.result.body?.card?.version,
            );
          try {
            return await this.dispatchMutation(ctx, command);
          } catch (e) {
            if (e instanceof ApiError && [404, 412].includes(e.status) && !op.operation.endsWith('.create')) {
              const table = this.operationTable(op.operation);
              let server: Row = { deleted: true };
              if (table) {
                const r = (
                  await ctx.sql.query(`SELECT * FROM ${table} WHERE user_id=$1 AND id=$2`, [
                    userId,
                    op.entity_id,
                  ])
                ).rows[0];
                if (r) server = await this.serialize(ctx.sql, userId, table, r);
              }
              const conflict = await this.insert(
                ctx.sql,
                'sync_conflicts',
                {
                  entity_type: tableKinds[table ?? ''] ?? 'unknown',
                  entity_id: op.entity_id,
                  client_operation_id: op.client_operation_id,
                  conflict_type: e.status === 404 ? 'deleted' : 'version',
                  base_payload: op.payload.base_snapshot ?? { version: op.base_version },
                  client_payload: op.payload,
                  server_payload: server,
                },
                userId,
              );
              await this.change(ctx, 'sync_conflicts', conflict);
              return {
                status: 409,
                body: {
                  error: {
                    code: 'VERSION_CONFLICT',
                    message: 'Offline edit preserved for conflict resolution',
                    details: { conflict_id: conflict.id, current_version: server.version ?? null },
                  },
                },
              };
            }
            throw e;
          }
        });
        const receipt = await this.read(
          userId,
          async (sql) =>
            (
              await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
                userId,
                op.client_operation_id,
              ])
            ).rows[0],
        );
        results.push({
          client_operation_id: op.client_operation_id,
          status: response.status === 409 ? 'conflict' : response.replayed ? 'duplicate' : 'applied',
          retryable: false,
          resulting_version: response.body?.version ?? response.body?.card?.version ?? null,
          sync_revision: receipt?.result?.sync_revision ?? response.body?.sync_revision ?? null,
          records: receipt?.result?.records ?? [],
          conflict_id: response.body?.error?.details?.conflict_id ?? null,
          error: response.body?.error ? response.body : null,
        });
      } catch (error) {
        const result = this.syncError(op, error);
        await this.saveRejected(userId, body.device_id, op, command, fingerprint, result);
        results.push(result);
      }
    }
    return {
      results: body.operations.map((op: Row) =>
        results.find((x) => x.client_operation_id === op.client_operation_id),
      ),
      server_time: new Date().toISOString(),
    };
  }
  private operationTable(operation: string): string | undefined {
    return (
      {
        review: 'review_cards',
        knowledge: 'knowledge_items',
        task: 'tasks',
        inbox: 'inbox_entries',
        'workout.exercise': 'workout_session_exercises',
        'workout.session': 'workout_sessions',
        'workout.set': 'workout_sets',
        'workout.cardio': 'cardio_entries',
      } as Record<string, string>
    )[operation.split('.').slice(0, -1).join('.')];
  }
  private syncError(op: Row, error: any, retryable = false): Row {
    const e =
      error instanceof ApiError
        ? error
        : new ApiError(
            422,
            'VALIDATION_ERROR',
            error?.code?.startsWith('23')
              ? 'Operation violates data constraints'
              : 'Operation could not be applied',
          );
    return {
      client_operation_id: op.client_operation_id,
      status: retryable ? 'blocked' : 'rejected',
      retryable,
      resulting_version: null,
      sync_revision: null,
      records: [],
      conflict_id: null,
      error: { error: { code: e.code, message: e.message, details: e.details, request_id: randomUUID() } },
    };
  }
  private async saveBlocked(
    userId: string,
    deviceId: string,
    op: Row,
    c: Command,
    fingerprint: string,
    result: Row,
  ) {
    await this.db.transaction(userId, async (sql) => {
      await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
      const old = (
        await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
          userId,
          op.client_operation_id,
        ])
      ).rows[0];
      if (!old)
        await this.insert(
          sql,
          'sync_operations',
          {
            device_id: deviceId,
            client_operation_id: op.client_operation_id,
            entity_type: tableKinds[this.operationTable(op.operation) ?? ''] ?? 'command',
            entity_id: op.entity_id,
            operation_type: c.method + ' ' + c.path,
            payload: c.body,
            payload_hash: fingerprint,
            status: 'blocked',
            result,
          },
          userId,
        );
    });
  }
  private async saveRejected(
    userId: string,
    deviceId: string,
    op: Row,
    c: Command,
    fingerprint: string,
    result: Row,
  ) {
    await this.db.transaction(userId, async (sql) => {
      await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
      const old = (
        await sql.query('SELECT * FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2', [
          userId,
          op.client_operation_id,
        ])
      ).rows[0];
      const row = {
        device_id: deviceId,
        client_operation_id: op.client_operation_id,
        entity_type: tableKinds[this.operationTable(op.operation) ?? ''] ?? 'command',
        entity_id: op.entity_id,
        operation_type: c.method + ' ' + c.path,
        payload: c.body,
        payload_hash: fingerprint,
        status: 'rejected',
        result: { body: result.error, records: [] },
      };
      if (!old) await this.insert(sql, 'sync_operations', row, userId);
      else if (old.status === 'blocked') await this.update(sql, userId, 'sync_operations', old.id, row);
    });
  }
  private async resolveConflict(ctx: Context, id: string, body: Row): Promise<Result> {
    const conflict = await this.row(ctx.sql, ctx.userId, 'sync_conflicts', id);
    this.version(conflict, ctx.expected);
    if (conflict.resolved_at)
      return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'sync_conflicts', conflict) };
    const table = Object.keys(tableKinds).find((t) => tableKinds[t] === conflict.entity_type);
    if (!table) throw validation('Unsupported conflict entity');
    const target = await this.row(ctx.sql, ctx.userId, table, conflict.entity_id, true);
    if (String(target.version) !== body.current_entity_version)
      throw new ApiError(412, 'VERSION_CONFLICT', 'Target changed again', {
        current_version: String(target.version),
      });
    if (conflict.entity_type === 'review_card' && !['keep_server', 'review_again'].includes(body.resolution))
      throw validation('Review conflicts require keeping server state or reviewing again');
    if (['apply_client', 'merged'].includes(body.resolution)) {
      const original = (
        await ctx.sql.query(
          'SELECT operation_type FROM sync_operations WHERE user_id=$1 AND client_operation_id=$2',
          [ctx.userId, conflict.client_operation_id],
        )
      ).rows[0];
      const prefix = Object.entries(models).find(([, model]) => model.table === table)?.[0];
      const action = original?.operation_type ?? `PATCH ${prefix}/${target.id}`;
      const separator = action.indexOf(' ');
      const method = action.slice(0, separator),
        path = action.slice(separator + 1);
      if (target.deleted_at && method !== 'DELETE')
        throw validation('Archived content cannot be silently restored');
      const payload = body.resolution === 'merged' ? body.merged_payload : conflict.client_payload;
      if (!payload) throw validation('Merged content is required');
      if (!target.deleted_at) {
        const oldExpected = ctx.expected;
        ctx.expected = body.current_entity_version;
        await this.dispatchMutation(ctx, {
          userId: ctx.userId,
          key: ctx.operationId,
          method,
          path,
          body: payload,
          expected: ctx.expected,
        });
        ctx.expected = oldExpected;
      }
    }
    const resolved = await this.update(ctx.sql, ctx.userId, 'sync_conflicts', id, {
      resolution: body.resolution,
      resolved_at: new Date(),
      resolved_payload: body.merged_payload ?? null,
    });
    await this.insert(
      ctx.sql,
      'conflict_resolution_events',
      {
        conflict_id: id,
        client_operation_id: ctx.operationId,
        resolution: body.resolution,
        payload: {
          current_entity_version: body.current_entity_version,
          merged_payload: body.merged_payload ?? null,
        },
      },
      ctx.userId,
    );
    await this.change(ctx, 'sync_conflicts', resolved);
    return { status: 200, body: await this.serialize(ctx.sql, ctx.userId, 'sync_conflicts', resolved) };
  }
  private async exportManifest(objectKey: string): Promise<Row | null> {
    try {
      return JSON.parse(
        await readFile(join(this.config.dataDir, 'exports', objectKey, 'manifest.json'), 'utf8'),
      );
    } catch {
      return null;
    }
  }
  private async buildExport(ctx: Context, record: Row): Promise<void> {
    await this.insert(
      ctx.sql,
      'automation_jobs',
      {
        job_type: 'export',
        scheduled_at: new Date(),
        idempotency_key: 'export:' + record.id,
        payload: { export_id: record.id },
      },
      ctx.userId,
    );
  }
  async processExports(): Promise<void> {
    const userId = this.config.userId;
    const pending = await this.read(
      userId,
      async (sql) =>
        (
          await sql.query(
            "SELECT e.* FROM exports e JOIN automation_jobs j ON j.user_id=e.user_id AND j.idempotency_key=('export:'||e.id::text) WHERE e.user_id=$1 AND e.status IN('pending','running') AND e.deleted_at IS NULL AND ((j.status IN('pending','failed') AND j.scheduled_at<=now()) OR(j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now()))) ORDER BY e.created_at LIMIT 2",
            [userId],
          )
        ).rows,
    );
    for (const item of pending) {
      const runId = randomUUID();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const claimed = await this.execute(
          { userId, key: randomUUID(), method: 'SYSTEM', path: 'exports/claim', body: { id: item.id } },
          async (ctx) => {
            const job = (
              await ctx.sql.query(
                'SELECT * FROM automation_jobs WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE',
                [userId, 'export:' + item.id],
              )
            ).rows[0];
            const record = await this.row(ctx.sql, userId, 'exports', item.id);
            if (
              !['pending', 'running'].includes(record.status) ||
              job.status === 'succeeded' ||
              (job.status === 'running' &&
                job.lease_expires_at &&
                new Date(job.lease_expires_at).getTime() > Date.now())
            )
              return { status: 200, body: { claimed: false } };
            if (job.attempts >= 5) {
              await this.update(ctx.sql, userId, 'exports', item.id, {
                status: 'failed',
                error_message: 'Export exhausted five attempts',
              });
              await ctx.sql.query(
                "UPDATE automation_jobs SET status='dead',finished_at=now(),lease_expires_at=NULL WHERE id=$1",
                [job.id],
              );
              return { status: 200, body: { claimed: false } };
            }
            await this.update(ctx.sql, userId, 'exports', item.id, {
              status: 'running',
              error_message: null,
            });
            await ctx.sql.query(
              "UPDATE automation_jobs SET status='running',attempts=attempts+1,started_at=now(),lease_expires_at=now()+interval '5 minutes',payload=$3::jsonb,version=version+1 WHERE user_id=$1 AND idempotency_key=$2",
              [userId, 'export:' + item.id, JSON.stringify({ ...job.payload, run_id: runId })],
            );
            return { status: 200, body: { claimed: true } };
          },
        );
        if (!claimed.body.claimed) continue;
        heartbeat = setInterval(() => {
          void this.db
            .transaction(userId, (sql) =>
              sql.query(
                "UPDATE automation_jobs SET lease_expires_at=now()+interval '5 minutes' WHERE user_id=$1 AND idempotency_key=$2 AND payload->>'run_id'=$3 AND status='running'",
                [userId, 'export:' + item.id, runId],
              ),
            )
            .catch(() => undefined);
        }, 30000);
        heartbeat.unref();
        const snapshot = await this.db.transaction(
          userId,
          async (sql) => {
            const state = (await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1', [userId]))
              .rows[0];
            const user = await this.row(sql, userId, 'users', userId);
            const records = await this.snapshotRecords(sql, userId, true);
            const history: Row = {};
            for (const table of ['review_submissions', 'scheduler_configs', 'conflict_resolution_events'])
              history[table] = (
                await sql.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY created_at,id`, [userId])
              ).rows.map((r) => {
                const x = { ...r };
                delete x.user_id;
                return x;
              });
            return { revision: String(state.revision), timezone: user.timezone, records, history };
          },
          'repeatable read',
        );
        const files: Record<string, Uint8Array> = {};
        const manifestFiles: Row[] = [];
        const add = (path: string, content: string, count: number) => {
          const bytes = strToU8(content);
          files[path] = bytes;
          manifestFiles.push({
            path,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
            record_count: count,
          });
        };
        if (item.formats.includes('json'))
          add(
            'prism.json',
            JSON.stringify(
              {
                schema_version: '1',
                generated_at: new Date().toISOString(),
                snapshot_revision: snapshot.revision,
                records: snapshot.records,
                history: snapshot.history,
              },
              null,
              2,
            ),
            snapshot.records.length,
          );
        if (item.formats.includes('markdown'))
          for (const r of snapshot.records)
            if (['knowledge_item', 'research_object', 'research_project'].includes(r.entity_type)) {
              const x = r.data;
              if (!x) continue;
              add(
                `${r.entity_type}/${r.entity_id}.md`,
                `# ${x.title}\n\nID: ${r.entity_id}\nStatus: ${x.claim_status ?? x.verification_status ?? x.status ?? ''}\nDeleted: ${r.deleted_at ?? 'no'}\n\n${x.content ?? x.description ?? ''}\n\n${x.proof_content ? '## Proof\n\n' + x.proof_content : ''}\n\n${x.notes ?? ''}\n\nSource: ${x.source_reference ?? x.evidence_reference ?? ''}\n`,
                1,
              );
            }
        const counts: Row = {};
        for (const record of snapshot.records)
          counts[record.entity_type] = (counts[record.entity_type] ?? 0) + 1;
        const manifest = {
          schema_version: '1',
          generated_at: new Date().toISOString(),
          snapshot_revision: snapshot.revision,
          timezone: snapshot.timezone,
          files: manifestFiles,
          counts,
        };
        files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
        const zip = zipSync(files);
        const key = item.id + '-' + runId;
        const dir = join(this.config.dataDir, 'exports', key);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'data.zip'), zip);
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
        await this.execute(
          { userId, key: randomUUID(), method: 'SYSTEM', path: 'exports/ready', body: { id: item.id } },
          async (ctx) => {
            const lease = (
              await ctx.sql.query(
                'SELECT payload FROM automation_jobs WHERE user_id=$1 AND idempotency_key=$2',
                [userId, 'export:' + item.id],
              )
            ).rows[0];
            if (lease?.payload?.run_id !== runId) return { status: 200, body: { stale: true } };
            await this.update(ctx.sql, userId, 'exports', item.id, {
              status: 'ready',
              object_key: key,
              sha256: createHash('sha256').update(zip).digest('hex'),
              bytes: zip.length,
              expires_at: new Date(Date.now() + 86400000),
            });
            await ctx.sql.query(
              "UPDATE automation_jobs SET status='succeeded',finished_at=now(),lease_expires_at=NULL,version=version+1 WHERE user_id=$1 AND idempotency_key=$2",
              [userId, 'export:' + item.id],
            );
            return { status: 200, body: { ready: true } };
          },
        );
      } catch (error) {
        await this.execute(
          { userId, key: randomUUID(), method: 'SYSTEM', path: 'exports/failed', body: { id: item.id } },
          async (ctx) => {
            const job = (
              await ctx.sql.query('SELECT * FROM automation_jobs WHERE user_id=$1 AND idempotency_key=$2', [
                userId,
                'export:' + item.id,
              ])
            ).rows[0];
            if (job?.payload?.run_id !== runId) return { status: 200, body: { stale: true } };
            const exhausted = job.attempts >= 5;
            await this.update(ctx.sql, userId, 'exports', item.id, {
              status: exhausted ? 'failed' : 'pending',
              error_message: exhausted
                ? 'Export exhausted five attempts'
                : 'Export will retry after a temporary failure',
            });
            await ctx.sql.query(
              'UPDATE automation_jobs SET status=$3,error_message=$4,finished_at=now(),lease_expires_at=NULL,scheduled_at=$5,version=version+1 WHERE user_id=$1 AND idempotency_key=$2',
              [
                userId,
                'export:' + item.id,
                exhausted ? 'dead' : 'failed',
                String((error as Error).message).slice(0, 500),
                new Date(Date.now() + Math.min(3600000, 5000 * 2 ** job.attempts)),
              ],
            );
            return { status: 200, body: { failed: true } };
          },
        );
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    }
  }
  async downloadExport(userId: string, id: string): Promise<Uint8Array> {
    const row = await this.read(userId, (sql) => this.row(sql, userId, 'exports', id));
    if (row.status === 'expired' || (row.expires_at && new Date(row.expires_at).getTime() < Date.now()))
      throw new ApiError(410, 'SNAPSHOT_EXPIRED', 'Export expired');
    if (row.status !== 'ready' || !row.object_key)
      throw new ApiError(409, 'VALIDATION_ERROR', 'Export is not ready');
    return readFile(join(this.config.dataDir, 'exports', row.object_key, 'data.zip'));
  }
  async ingestPapers(userId: string, papers: Row[], idempotencyKey: string): Promise<any> {
    const key = uuid.test(idempotencyKey) ? idempotencyKey : this.uuidFor(idempotencyKey);
    return this.execute(
      { userId, key, method: 'SYSTEM', path: 'arxiv/ingest', body: { papers } },
      async (ctx) => {
        for (const input of papers) {
          let paper = (await ctx.sql.query('SELECT * FROM arxiv_papers WHERE arxiv_id=$1', [input.arxiv_id]))
            .rows[0];
          const metadata = {
            arxiv_id: input.arxiv_id,
            latest_version: input.latest_version,
            title: input.title,
            abstract: input.abstract ?? '',
            authors: input.authors,
            categories: input.categories,
            published_at: input.published_at,
            updated_at: input.updated_at,
            source_url: input.source_url,
            pdf_url: input.pdf_url,
          };
          if (!paper) paper = await this.insert(ctx.sql, 'arxiv_papers', metadata);
          else if (
            input.latest_version > paper.latest_version ||
            (input.latest_version === paper.latest_version &&
              new Date(input.updated_at).getTime() >= new Date(paper.updated_at).getTime())
          ) {
            const keys = Object.keys(metadata).filter((k) => k !== 'arxiv_id');
            paper = (
              await ctx.sql.query(
                `UPDATE arxiv_papers SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')}${input.latest_version > paper.latest_version ? ',ingested_at=now()' : ''} WHERE id=$1 RETURNING *`,
                [paper.id, ...keys.map((k) => this.value((metadata as Row)[k], k))],
              )
            ).rows[0];
          }
          const version = (
            await ctx.sql.query('SELECT id FROM arxiv_paper_versions WHERE paper_id=$1 AND version=$2', [
              paper.id,
              input.latest_version,
            ])
          ).rows[0];
          if (!version)
            await this.insert(ctx.sql, 'arxiv_paper_versions', {
              paper_id: paper.id,
              version: input.latest_version,
              updated_at: input.updated_at,
              metadata_snapshot: metadata,
            });
          const old = (
            await ctx.sql.query('SELECT * FROM user_papers WHERE user_id=$1 AND paper_id=$2', [
              userId,
              paper.id,
            ])
          ).rows[0];
          const data = {
            relevance_score: Number(input.relevance_score ?? 0),
            match_reasons: input.match_reasons ?? [],
          };
          const state = old
            ? await this.update(ctx.sql, userId, 'user_papers', old.id, data)
            : await this.insert(ctx.sql, 'user_papers', { paper_id: paper.id, ...data }, userId);
          await this.change(ctx, 'user_papers', state);
        }
        return { status: 200, body: { ingested: papers.length } };
      },
    );
  }
  private uuidFor(value: string): string {
    const h = createHash('sha256').update(value).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  async dailyAutomation(
    userId: string,
    kind: 'digest' | 'plan' | 'shutdown',
    date: string,
    paperIds: string[] = [],
  ): Promise<any> {
    const key = this.uuidFor(`daily:${userId}:${kind}:${date}`);
    return this.execute(
      { userId, key, method: 'SYSTEM', path: 'automation/' + kind, body: { date } },
      async (ctx) => {
        const user = await this.row(ctx.sql, userId, 'users', userId);
        const prefs = (await ctx.sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [userId]))
          .rows[0];
        if (kind === 'plan') {
          const existing = (
            await ctx.sql.query('SELECT id FROM daily_plans WHERE user_id=$1 AND plan_date=$2', [
              userId,
              date,
            ])
          ).rows[0];
          if (existing) return { status: 200, body: { existing: true } };
          return {
            status: 200,
            body: await this.generate(ctx, {
              plan_date: date,
              timezone: user.timezone,
              capacity_minutes: prefs.default_study_capacity_minutes,
              override_manual: false,
            }),
          };
        }
        if (kind === 'digest') {
          if (prefs.digest_preferences?.enabled === false) return { status: 200, body: { disabled: true } };
          const range = localDayRange(date, user.timezone);
          const rows = await ctx.sql.query(
            'SELECT p.* FROM user_papers u JOIN arxiv_papers p ON p.id=u.paper_id WHERE u.user_id=$1 AND u.deleted_at IS NULL AND u.status<>$4 AND EXISTS(SELECT 1 FROM arxiv_paper_versions v WHERE v.paper_id=p.id AND v.created_at>=$2 AND v.created_at<$3)',
            [userId, range.start, range.end, 'not_relevant'],
          );
          const subscriptions = (
            await ctx.sql.query(
              'SELECT subscription_type,subscription_value,enabled,weight FROM arxiv_subscriptions WHERE user_id=$1 AND enabled AND deleted_at IS NULL',
              [userId],
            )
          ).rows as SubscriptionMatchRule[];
          paperIds = rows.rows
            .map((paper) => ({
              paper,
              match: rankSubscriptionMatches(
                {
                  title: paper.title,
                  abstract: paper.abstract,
                  authors: paper.authors,
                  categories: paper.categories,
                },
                subscriptions,
              ),
            }))
            .filter((result) => result.match.relevance_score > 0)
            .sort(
              (a, b) =>
                b.match.relevance_score - a.match.relevance_score ||
                new Date(b.paper.updated_at).getTime() - new Date(a.paper.updated_at).getTime() ||
                (a.paper.arxiv_id < b.paper.arxiv_id ? -1 : a.paper.arxiv_id > b.paper.arxiv_id ? 1 : 0),
            )
            .slice(0, 100)
            .map((result) => result.paper.id);
        }
        const dedupe = `${kind}:${date}`;
        const exists = (
          await ctx.sql.query('SELECT id FROM notification_events WHERE user_id=$1 AND dedupe_key=$2', [
            userId,
            dedupe,
          ])
        ).rows[0];
        if (!exists)
          await this.insert(
            ctx.sql,
            'notification_events',
            {
              notification_type: kind,
              payload: {
                date,
                paper_ids: paperIds,
                title: kind === 'digest' ? "Today's arXiv digest" : 'End-of-day review',
                body:
                  kind === 'digest'
                    ? `${paperIds.length} relevant papers. Open PRISM to read your digest.`
                    : "Review completed and deferred work, then choose tomorrow's priorities.",
              },
              scheduled_at: new Date(),
              dedupe_key: dedupe,
            },
            userId,
          );
        return { status: 200, body: { created: !exists } };
      },
    );
  }
  async pendingNotifications(): Promise<Row[]> {
    return this.read(this.config.userId, async (sql) => {
      const prefs = (await sql.query('SELECT * FROM user_preferences WHERE user_id=$1', [this.config.userId]))
        .rows[0];
      const user = await this.row(sql, this.config.userId, 'users', this.config.userId);
      const notifications = (
        await sql.query(
          "SELECT * FROM notification_events WHERE user_id=$1 AND status='pending' AND scheduled_at<=now() AND deleted_at IS NULL ORDER BY scheduled_at LIMIT 20",
          [this.config.userId],
        )
      ).rows;
      const devices = (
        await sql.query(
          'SELECT push_token_ciphertext FROM devices WHERE user_id=$1 AND deleted_at IS NULL AND push_token_ciphertext IS NOT NULL',
          [this.config.userId],
        )
      ).rows;
      const pushTokens = [
        ...new Set(devices.map((d) => this.decryptToken(d.push_token_ciphertext)).filter(Boolean)),
      ];
      return notifications.map((n) => ({
        ...n,
        timezone: user.timezone,
        preferences: prefs.notification_preferences,
        push_tokens: pushTokens,
      }));
    });
  }
  async ackNotification(id: string, userId: string, status: string): Promise<void> {
    await this.execute(
      { userId, key: randomUUID(), method: 'SYSTEM', path: 'notifications/ack', body: { id, status } },
      async (ctx) => {
        const old = await this.row(ctx.sql, userId, 'notification_events', id);
        const attempts = Number(old.payload?.delivery_attempts ?? 0) + 1;
        const retry = status === 'failed' && attempts < 5;
        await this.update(ctx.sql, userId, 'notification_events', id, {
          status: retry ? 'pending' : status,
          scheduled_at: retry
            ? new Date(Date.now() + Math.min(3600000, 5000 * 2 ** attempts))
            : old.scheduled_at,
          payload: { ...old.payload, delivery_attempts: attempts },
          delivered_at: status === 'delivered' ? new Date() : null,
        });
        return { status: 200, body: { ok: true } };
      },
    );
  }
}
