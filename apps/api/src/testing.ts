/** Disposable PostgreSQL integration-test fixture. Never points cleanup at the source database. */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase } from '@prism/database';
export async function createTestPostgres() {
  const raw = await readFile(new URL('../../../.data/test-postgres.env', import.meta.url), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  if (!env.PRISM_TEST_ADMIN_DATABASE_URL || !env.PRISM_TEST_DATABASE_URL)
    throw new Error('PostgreSQL test fixtures are not configured');
  const admin = new pg.Pool({ connectionString: env.PRISM_TEST_ADMIN_DATABASE_URL });
  const name = 'prism_test_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`);
  const adminUrl = new URL(env.PRISM_TEST_ADMIN_DATABASE_URL);
  adminUrl.pathname = '/' + name;
  const runtimeUrl = new URL(env.PRISM_TEST_DATABASE_URL);
  runtimeUrl.pathname = '/' + name;
  const owner = new pg.Pool({ connectionString: adminUrl.toString() });
  await owner.query(await readFile(new URL('../../../database/schema.sql', import.meta.url), 'utf8'));
  for (const migration of [
    '002_arxiv_for_you',
    '003_arxiv_for_you_rounds',
    '004_ai_review_drafts',
    '005_proof_recall',
    '006_research_project_knowledge',
  ]) {
    await owner.query(
      await readFile(new URL(`../../../database/migrations/${migration}.sql`, import.meta.url), 'utf8'),
    );
  }
  const role = decodeURIComponent(runtimeUrl.username);
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('Invalid test role');
  await owner.query(
    `GRANT USAGE ON SCHEMA prism TO "${role}";GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA prism TO "${role}";GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA prism TO "${role}"`,
  );
  const db = await createDatabase({ url: runtimeUrl.toString(), production: true });
  return {
    db,
    url: runtimeUrl.toString(),
    admin: owner,
    userId: env.PRISM_TEST_USER_ID,
    subject: env.PRISM_TEST_SUBJECT,
    async cleanup() {
      await db.close();
      await owner.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}

export async function createOidcFixture(subject: string) {
  const { createServer } = await import('node:http');
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const pair = await generateKeyPair('RS256');
  const key = { ...(await exportJWK(pair.publicKey)), kid: 'prism-test-key', alg: 'RS256', use: 'sig' };
  let issuer = '';
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/.well-known/openid-configuration')
      response.end(
        JSON.stringify({
          issuer,
          jwks_uri: issuer + '/jwks',
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
        }),
      );
    else if (request.url === '/jwks') response.end(JSON.stringify({ keys: [key] }));
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OIDC test server did not start');
  issuer = 'http://127.0.0.1:' + address.port;
  return {
    issuer,
    async token(
      overrides: {
        subject?: string;
        expired?: boolean;
        wrongKey?: boolean;
        issuer?: string;
        audience?: string;
        missingExpiry?: boolean;
      } = {},
    ) {
      const privateKey = overrides.wrongKey ? (await generateKeyPair('RS256')).privateKey : pair.privateKey;
      const token = new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'prism-test-key' })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? 'prism-test-api')
        .setSubject(overrides.subject ?? subject)
        .setIssuedAt();
      if (!overrides.missingExpiry)
        token.setExpirationTime(overrides.expired ? Math.floor(Date.now() / 1000) - 60 : '1h');
      return token.sign(privateKey);
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
