import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/index';
import { createTestPostgres } from '../../apps/api/src/testing';
import { PrismService } from '../../apps/api/src/service';
import { loadConfig } from '../../apps/api/src/config';
const run = process.env.PRISM_API_TEST_POSTGRES === '1' ? describe : describe.skip;
run('real PostgreSQL commit order and isolation', () => {
  it('serializes revisions by commit and enforces runtime RLS across connections', async () => {
    const fixture = await createTestPostgres(),
      db = fixture.db;
    const config = loadConfig({
      PRISM_AUTH_MODE: 'development',
      PRISM_USER_ID: fixture.userId,
      PRISM_ALLOWED_SUBJECT: fixture.subject,
    });
    const service = new PrismService(db, config);
    await service.initialize();
    const second = await createDatabase({ url: fixture.url, production: true });
    try {
      const user = config.userId,
        other = randomUUID(),
        note = randomUUID();
      await fixture.admin.query(
        "INSERT INTO prism.users(id,oidc_subject,email,display_name) VALUES($1,'foreign-subject','foreign@test.invalid','Other')",
        [other],
      );
      await fixture.admin.query(
        "INSERT INTO prism.knowledge_items(id,user_id,title,type) VALUES($1,$2,'Hidden','note')",
        [note, other],
      );
      expect(
        (await db.transaction(user, (sql) => sql.query('SELECT * FROM knowledge_items WHERE id=$1', [note])))
          .rows,
      ).toHaveLength(0);
      let started!: () => void;
      const start = new Promise<void>((r) => {
        started = r;
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const order: string[] = [];
      const first = db.transaction(user, async (sql) => {
        await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [user]);
        await sql.query('UPDATE user_sync_state SET revision=revision+1 WHERE user_id=$1', [user]);
        started();
        await gate;
        await sql.query("INSERT INTO sync_change_batches(id,user_id,revision,changes) VALUES($1,$2,1,'[]')", [
          randomUUID(),
          user,
        ]);
        order.push('first');
      });
      await start;
      const later = second.transaction(user, async (sql) => {
        await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [user]);
        const r = await sql.query(
          'UPDATE user_sync_state SET revision=revision+1 WHERE user_id=$1 RETURNING revision',
          [user],
        );
        await sql.query(
          "INSERT INTO sync_change_batches(id,user_id,revision,changes) VALUES($1,$2,$3,'[]')",
          [randomUUID(), user, r.rows[0].revision],
        );
        order.push('second');
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(order).toEqual([]);
      release();
      await Promise.all([first, later]);
      expect(order).toEqual(['first', 'second']);
      const batches = await db.transaction(user, (sql) =>
        sql.query('SELECT revision::text r FROM sync_change_batches ORDER BY revision'),
      );
      expect(batches.rows.map((x) => x.r)).toEqual(['1', '2']);
      await expect(
        db.transaction(user, async (sql) => {
          await sql.query('UPDATE user_sync_state SET revision=3 WHERE user_id=$1', [user]);
          throw new Error('crash before commit');
        }),
      ).rejects.toThrow();
      expect(
        (await db.transaction(user, (sql) => sql.query('SELECT revision::text r FROM user_sync_state')))
          .rows[0].r,
      ).toBe('2');
    } finally {
      await second.close();
      await fixture.cleanup();
    }
  });
});
