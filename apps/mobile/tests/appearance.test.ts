import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { LocalStore, type SqlDriver } from '../src/offline/store';
import { APPEARANCE_KEY, defaultAppearance, parseAppearance } from '../src/services/appearance';
class Driver implements SqlDriver {
  constructor(readonly db = new DatabaseSync(':memory:')) {}
  async exec(query: string) {
    this.db.exec(query);
  }
  async run(query: string, ...args: (string | number | null)[]) {
    this.db.prepare(query).run(...args);
  }
  async all<T>(query: string, ...args: (string | number | null)[]): Promise<T[]> {
    return this.db.prepare(query).all(...args) as T[];
  }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
describe('local appearance preferences', () => {
  it('bounds malformed preferences while retaining supported settings', () => {
    for (const raw of [null, '', 'null', '{']) expect(parseAppearance(raw)).toEqual(defaultAppearance);
    expect(parseAppearance('{"theme":"dark","textScale":9,"reduceMotion":true}')).toEqual({
      theme: 'dark',
      textScale: 1.3,
      reduceMotion: true,
    });
    expect(parseAppearance('{"theme":"invalid","textScale":0,"reduceMotion":"false"}')).toEqual({
      theme: 'system',
      textScale: 0.9,
      reduceMotion: false,
    });
  });
  it('persists through SQLite reopening without modifying user content or creating sync commands', async () => {
    const driver = new Driver();
    try {
      const store = new LocalStore(driver);
      await store.initialize();
      const content = {
        id: 'knowledge',
        version: '1',
        title: '原始内容',
        content: '$I^n$ remains unchanged',
      };
      await store.applyRecord({
        entity_type: 'knowledge_item',
        entity_id: content.id,
        entity_version: '1',
        deleted_at: null,
        data: content,
      });
      const preferences = { theme: 'dark', textScale: 1.15, reduceMotion: true };
      await store.setMeta(APPEARANCE_KEY, JSON.stringify(preferences));
      const reopened = new LocalStore(driver);
      await reopened.initialize();
      expect(parseAppearance(await reopened.meta(APPEARANCE_KEY))).toEqual(preferences);
      expect(await reopened.get('knowledge_item', content.id)).toEqual(content);
      expect(await reopened.pending()).toEqual([]);
    } finally {
      driver.db.close();
    }
  });
});
