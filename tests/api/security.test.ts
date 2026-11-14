import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../../packages/database/src/index';
import { PrismService } from '../../apps/api/src/service';
import { loadConfig } from '../../apps/api/src/config';
import { buildApp } from '../../apps/api/src/app';
import { createOidcFixture } from '../../apps/api/src/testing';

describe('authentication and durable local persistence', () => {
  it('fails closed for unsafe or missing auth configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', PRISM_AUTH_MODE: 'development' })).toThrow();
    expect(() => loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_HOST: '0.0.0.0' })).toThrow();
    expect(() => loadConfig({})).toThrow();
  });
  it('requires the desktop launch token and loopback origin before accessing the workspace', async () => {
    const token = randomBytes(32).toString('hex');
    const env = {
      PRISM_AUTH_MODE: 'desktop',
      PRISM_PORT: '38742',
      PRISM_WEB_ORIGIN: 'http://127.0.0.1:38741',
      PRISM_DATA_DIR: tmpdir(),
      PRISM_DESKTOP_TOKEN: token,
    };
    expect(() => loadConfig({ ...env, PRISM_DESKTOP_TOKEN: '' })).toThrow();
    expect(() => loadConfig({ ...env, PRISM_DATA_DIR: '.data' })).toThrow();
    expect(() => loadConfig({ ...env, PRISM_HOST: '0.0.0.0' })).toThrow();
    const db = await createDatabase({ memory: true });
    const app = await buildApp({ db, config: loadConfig(env) });
    const local = { host: '127.0.0.1:38742' };
    const trusted = { ...local, authorization: `Bearer ${token}` };
    try {
      expect((await app.inject({ url: '/health', headers: local })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: '/api/v1/me', headers: { ...local, authorization: 'Bearer invalid' } }))
          .statusCode,
      ).toBe(401);
      expect(
        (await app.inject({ url: '/api/v1/me', headers: { ...trusted, host: 'foreign.invalid:38742' } }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: '/api/v1/me', headers: { ...trusted, origin: 'http://127.0.0.1:3000' } }))
          .statusCode,
      ).toBe(403);
      const notes = await app.inject({ url: '/api/v1/knowledge-items', headers: trusted });
      expect(notes.statusCode).toBe(200);
      expect(notes.json().items).toEqual([]);
    } finally {
      await app.close();
      await db.close();
    }
  });
  it('validates OIDC signature, issuer, audience, expiry and single-user subject', async () => {
    const db = await createDatabase({ memory: true }),
      config = loadConfig({ PRISM_AUTH_MODE: 'development' });
    await new PrismService(db, config).initialize();
    const fixture = await createOidcFixture(config.allowedSubject);
    const app = await buildApp({
      db,
      config: {
        ...config,
        authMode: 'oidc',
        issuer: fixture.issuer,
        audience: 'prism-test-api',
        mobileClientId: 'test-mobile',
      },
    });
    try {
      expect((await app.inject({ url: '/api/v1/me' })).statusCode).toBe(401);
      const request = async (token: string) =>
        app.inject({ url: '/api/v1/me', headers: { authorization: 'Bearer ' + token } });
      const valid = await request(await fixture.token());
      expect(valid.statusCode, valid.body).toBe(200);
      expect(valid.json().id).toBe(config.userId);
      expect((await request(await fixture.token({ subject: 'another-user' }))).statusCode).toBe(403);
      expect((await request(await fixture.token({ expired: true }))).statusCode).toBe(401);
      expect((await request(await fixture.token({ missingExpiry: true }))).statusCode).toBe(401);
      expect(
        (await request(await fixture.token({ issuer: 'https://wrong-issuer.invalid' }))).statusCode,
      ).toBe(401);
      expect((await request(await fixture.token({ audience: 'another-api' }))).statusCode).toBe(401);
      expect((await request(await fixture.token({ wrongKey: true }))).statusCode).toBe(401);
    } finally {
      await app.close();
      await fixture.close();
      await db.close();
    }
  });
  it('persists acknowledged data after closing and reopening nested file-backed PGlite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-persistence-test-')),
      path = join(dir, 'nested', 'database');
    let db = await createDatabase({ dataDir: path });
    const config = loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DATA_DIR: dir });
    const noteId = randomUUID();
    try {
      let service = new PrismService(db, config);
      await service.initialize();
      const created = await service.execute({
        userId: config.userId,
        key: randomUUID(),
        method: 'POST',
        path: 'knowledge-items',
        body: {
          id: noteId,
          title: 'Persisted theorem',
          type: 'theorem',
          content: 'Original mathematical content',
        },
      });
      expect(created.status).toBe(201);
      await db.close();
      db = await createDatabase({ dataDir: path });
      service = new PrismService(db, config);
      await service.initialize();
      const stored = await service.query(config.userId, 'knowledge-items/' + noteId);
      expect(stored.content).toBe('Original mathematical content');
      expect(stored.version).toBe('1');
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
