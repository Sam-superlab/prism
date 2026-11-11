import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  createServerSession,
  deleteServerSession,
  seal,
  SESSION_COOKIE,
  sessionFor,
  validateLogin,
} from '../../apps/web/lib/server-auth';
import { API_BODY_LIMIT, BodyLimitError, readLimitedBody } from '../../apps/web/lib/request-body';

test('BFF rejects a forged mutation Origin before it reaches product storage', async ({ request }) => {
  const title = 'Rejected cross-origin task';
  const response = await request.post('/api/v1/tasks', {
    headers: { Origin: 'https://attacker.invalid', 'Idempotency-Key': crypto.randomUUID() },
    data: { id: crypto.randomUUID(), title, source_type: 'general', estimated_minutes: 10 },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe('FORBIDDEN');
  const tasks = await (await request.get('/api/v1/tasks?limit=500')).json();
  expect(tasks.items.some((task: { title: string }) => task.title === title)).toBe(false);
});

test('BFF rejects oversized JSON before forwarding it to the API', async ({ request }) => {
  const title = 'Oversized request must not be stored';
  const response = await request.post('/api/v1/tasks', {
    headers: { Origin: 'http://127.0.0.1:3100', 'Idempotency-Key': crypto.randomUUID() },
    data: {
      id: crypto.randomUUID(),
      title,
      source_type: 'general',
      estimated_minutes: 10,
      description: 'x'.repeat(API_BODY_LIMIT),
    },
  });
  expect(response.status()).toBe(413);
  expect((await response.json()).error.details.max_bytes).toBe(API_BODY_LIMIT);
  const tasks = await (await request.get('/api/v1/tasks?limit=500')).json();
  expect(tasks.items.some((task: { title: string }) => task.title === title)).toBe(false);
});

test('chunked bodies are bounded even when Content-Length is absent or understated', async () => {
  for (const declared of [null, '1']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700000));
        controller.enqueue(new Uint8Array(400000));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readLimitedBody({ headers: { get: () => declared }, body })).rejects.toBeInstanceOf(
      BodyLimitError,
    );
    expect(cancelled).toBe(true);
  }
  const bytes = new TextEncoder().encode('bounded payload');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  expect(new TextDecoder().decode(await readLimitedBody({ headers: { get: () => null }, body }))).toBe(
    'bounded payload',
  );
});

test('unrelated task and project edits preserve exact deadline instants across a DST overlap', async ({
  page,
  request,
}) => {
  const deadline = '2026-10-25T01:30:45.123Z';
  const taskId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const headers = { Origin: 'http://127.0.0.1:3100', 'Idempotency-Key': crypto.randomUUID() };
  const createdTask = await request.post('/api/v1/tasks', {
    headers,
    data: {
      id: taskId,
      title: 'Precise task deadline fixture',
      source_type: 'general',
      estimated_minutes: 10,
      due_at: deadline,
    },
  });
  expect(createdTask.status()).toBe(201);
  await page.goto('/today');
  await page.locator('.task-pool > summary').click();
  await page.getByRole('button', { name: 'Edit task Precise task deadline fixture', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title').fill('Precise task title edited');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await (await request.get(`/api/v1/tasks/${taskId}`)).json()).due_at).toBe(deadline);
  const createdProject = await request.post('/api/v1/research/projects', {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: { id: projectId, title: 'Precise project deadline fixture', deadline },
  });
  expect(createdProject.status()).toBe(201);
  await page.goto(`/research/${projectId}`);
  await page.getByRole('button', { name: 'Edit project', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project title').fill('Precise project title edited');
  await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await (await request.get(`/api/v1/research/projects/${projectId}`)).json()).deadline).toBe(
    deadline,
  );
});

test('logout during a deferred token refresh cannot resurrect the old opaque session', async () => {
  const names = [
    'REDIS_URL',
    'PRISM_OIDC_CLIENT_ID',
    'PRISM_OIDC_CLIENT_SECRET',
    'PRISM_SESSION_SECRET',
  ] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.REDIS_URL;
  process.env.PRISM_OIDC_CLIENT_ID = 'isolated-web-auth-regression';
  delete process.env.PRISM_OIDC_CLIENT_SECRET;
  process.env.PRISM_SESSION_SECRET = 'isolated-test-session-key-with-at-least-thirty-two-characters';
  let acceptToken!: () => void;
  let releaseToken!: () => void;
  const tokenRequested = new Promise<void>((resolve) => {
    acceptToken = resolve;
  });
  const tokenReleased = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/token') {
      res.writeHead(404).end();
      return;
    }
    acceptToken();
    await tokenReleased;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        access_token: 'test-rotated-access',
        refresh_token: 'test-rotated-refresh',
        expires_in: 3600,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Token fixture did not listen');
  const stored = await createServerSession({
    accessToken: 'test-expired-access',
    refreshToken: 'test-refresh',
    expiresAt: Date.now() - 1000,
    tokenEndpoint: `http://127.0.0.1:${address.port}/token`,
  });
  const cookie = seal({ id: stored.id });
  const request = {
    cookies: { get: (name: string) => (name === SESSION_COOKIE ? { value: cookie } : undefined) },
  } as Parameters<typeof sessionFor>[0];
  try {
    const refreshing = sessionFor(request);
    await tokenRequested;
    await deleteServerSession(request);
    releaseToken();
    expect((await refreshing).session).toBeNull();
    expect((await sessionFor(request)).session).toBeNull();
  } finally {
    releaseToken();
    await deleteServerSession(request);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

test('BFF requires OIDC exp/iat/sub claims and accepts a valid signed ID token', async () => {
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { SignJWT, generateKeyPair, exportJWK } = await import(pathToFileURL(require.resolve('jose')).href);
  const pair = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'oidc-required-claims-regression',
    alg: 'RS256',
    use: 'sig',
  };
  let issuer = '';
  let authorizedProfileRequests = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration')
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === '/api/v1/me' && req.headers.authorization === 'Bearer oidc-access-fixture') {
      authorizedProfileRequests++;
      res.end(JSON.stringify({ id: 'allowed-user' }));
    } else res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OIDC fixture did not listen');
  issuer = `http://127.0.0.1:${address.port}`;
  const names = ['PRISM_OIDC_CLIENT_ID', 'PRISM_API_URL'] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PRISM_OIDC_CLIENT_ID = 'web-required-claims-fixture';
  process.env.PRISM_API_URL = issuer;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, string | number> = {
    iss: issuer,
    aud: 'web-required-claims-fixture',
    sub: 'expected-subject',
    iat: now,
    exp: now + 300,
    nonce: 'expected-nonce',
  };
  const flow = {
    issuer,
    nonce: 'expected-nonce',
    state: 'test-state',
    verifier: 'test-verifier',
    redirectUri: `${issuer}/callback`,
    tokenEndpoint: `${issuer}/token`,
    createdAt: Date.now(),
  };
  const session = {
    accessToken: 'oidc-access-fixture',
    expiresAt: Date.now() + 300000,
    tokenEndpoint: `${issuer}/token`,
  };
  try {
    for (const claim of ['exp', 'iat', 'sub']) {
      const incomplete = { ...payload };
      delete incomplete[claim];
      const idToken = await new SignJWT(incomplete)
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .sign(pair.privateKey);
      await expect(validateLogin({ ...session, idToken }, flow)).rejects.toMatchObject({
        claim,
        reason: 'missing',
      });
    }
    expect(authorizedProfileRequests).toBe(0);
    const idToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .sign(pair.privateKey);
    await expect(validateLogin({ ...session, idToken }, flow)).resolves.toBeUndefined();
    expect(authorizedProfileRequests).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
