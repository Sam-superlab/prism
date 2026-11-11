import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
// Calendar dates are not instants. Keep PostgreSQL DATE values identical to PGlite/JSON.
pg.types.setTypeParser(1082, (value) => value);

export type Row = Record<string, any>;
export interface Sql {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
function serialSql(run: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>): Sql {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
      const result = tail.then(() => run(sql, params)) as Promise<{ rows: T[] }>;
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
export interface DatabaseOptions {
  url?: string;
  dataDir?: string;
  memory?: boolean;
  production?: boolean;
  schemaPath?: string;
}
export class Database implements Sql {
  readonly kind: 'postgres' | 'pglite';
  private pool?: pg.Pool;
  private lite?: PGlite;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly options: DatabaseOptions = {}) {
    this.kind = options.url ? 'postgres' : 'pglite';
    if (options.url) this.pool = new pg.Pool({ connectionString: options.url, max: 10 });
    else {
      const dir = options.memory ? undefined : resolve(options.dataDir ?? '.data/prism');
      if (dir) mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      this.lite = new PGlite(dir);
    }
  }
  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (this.pool) return { rows: (await this.pool.query(sql, params)).rows as T[] };
    return this.exclusive(async () => ({ rows: (await this.lite!.query<T>(sql, params)).rows }));
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async initialize(): Promise<void> {
    const exists = await this.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='prism' AND table_name='users') present",
    );
    if (!exists.rows[0]?.present) {
      if (this.options.production)
        throw new Error(
          'Database schema is missing. Run the controlled migration command before production startup.',
        );
      const ddl = await readFile(
        this.options.schemaPath ?? new URL('../../../database/schema.sql', import.meta.url),
        'utf8',
      );
      if (this.pool) await this.pool.query(ddl);
      else await this.lite!.exec(ddl);
    }
    if (this.options.production) {
      const result = await this.query<{ unsafe: boolean }>(
        "SELECT r.rolsuper OR r.rolbypassrls OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='prism' AND tableowner=current_user) unsafe FROM pg_roles r WHERE r.rolname=current_user",
      );
      if (result.rows[0]?.unsafe)
        throw new Error('Production runtime database role must be a non-owner without superuser/BYPASSRLS.');
    }
  }
  async transaction<T>(
    userId: string | undefined,
    fn: (sql: Sql) => Promise<T>,
    isolation: 'read committed' | 'repeatable read' = 'read committed',
  ): Promise<T> {
    const execute = async (sql: Sql) => {
      await sql.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      try {
        await sql.query('SET LOCAL search_path=prism,public');
        if (userId) await sql.query("SELECT set_config('app.user_id',$1,true)", [userId]);
        const result = await fn(sql);
        await sql.query('COMMIT');
        return result;
      } catch (error) {
        await sql.query('ROLLBACK');
        throw error;
      }
    };
    if (this.pool) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const client = await this.pool.connect();
        try {
          return await execute(serialSql(async (q, p) => ({ rows: (await client.query(q, p)).rows })));
        } catch (error) {
          if (!['40001', '40P01'].includes((error as any).code) || attempt === 2) throw error;
        } finally {
          client.release();
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
      throw new Error('Transaction retries exhausted');
    }
    return this.exclusive(() =>
      execute(serialSql(async (q, p) => ({ rows: (await this.lite!.query(q, p)).rows }))),
    );
  }
  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
    else await this.lite!.close();
  }
}
export async function createDatabase(options: DatabaseOptions = {}): Promise<Database> {
  const db = new Database(options);
  await db.initialize();
  return db;
}
