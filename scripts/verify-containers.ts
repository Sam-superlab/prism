/** Disposable packaging smoke test. Requires the isolated PostgreSQL/Redis test services. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestPostgres } from '../apps/api/src/testing';
import { loadConfig, PrismService } from '../packages/core/src/index';

const exec = promisify(execFile);
const id = randomUUID().slice(0, 8);
const names = {
  api: `prism-smoke-api-${id}`,
  worker: `prism-smoke-worker-${id}`,
  web: `prism-smoke-web-${id}`,
};
const folder = resolve('.data', `container-smoke-${id}`);
await mkdir(folder, { recursive: true, mode: 0o700 });
const fixture = await createTestPostgres();
const checks: string[] = [];
async function docker(...args: string[]) {
  return (await exec('docker', args, { maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function envFile(name: string, values: Record<string, string>) {
  const file = resolve(folder, `${name}.env`);
  await writeFile(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  return file;
}
async function evaluate(name: string, source: string) {
  return docker('exec', name, 'node', '-e', source);
}
async function ready(name: string, url: string) {
  for (let i = 0; i < 45; i++) {
    try {
      const result = await evaluate(
        name,
        `fetch(${JSON.stringify(url)}).then(r=>{if(!r.ok)process.exit(1);console.log(r.status)})`,
      );
      if (result === '200') return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container did not become ready: ${name}`);
}
try {
  const apiEnv = await envFile('api', {
    NODE_ENV: 'development',
    PRISM_AUTH_MODE: 'development',
    PRISM_HOST: '127.0.0.1',
    PRISM_WORKER_ENABLED: 'false',
  });
  await docker('run', '-d', '--name', names.api, '--env-file', apiEnv, 'prism-api:local');
  await ready(names.api, 'http://127.0.0.1:4000/health');
  if ((await evaluate(names.api, 'console.log(process.getuid())')) !== '1000')
    throw new Error('API must run as node');
  checks.push('Production-pruned API image starts as UID 1000 with writable PGlite data directory');
  const noteId = randomUUID(),
    key = randomUUID();
  const created = JSON.parse(
    await evaluate(
      names.api,
      `fetch('http://127.0.0.1:4000/api/v1/knowledge-items',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'${key}'},body:JSON.stringify({id:'${noteId}',title:'Disposable container smoke',type:'note',content:'Packaging verification'})}).then(async r=>{if(r.status!==201)throw Error(await r.text());console.log(await r.text())})`,
    ),
  );
  if (created.id !== noteId) throw new Error('API creation failed');
  await docker('restart', names.api);
  await ready(names.api, 'http://127.0.0.1:4000/health');
  const persisted = await evaluate(
    names.api,
    `fetch('http://127.0.0.1:4000/api/v1/knowledge-items/${noteId}').then(async r=>{if(!r.ok)throw Error(await r.text());console.log((await r.json()).id)})`,
  );
  if (persisted !== noteId) throw new Error('API data did not survive restart');
  checks.push('Actual note write/read survives API container restart');
  const fail = await docker(
    'run',
    '--rm',
    '--entrypoint',
    'node',
    'prism-api:local',
    '-e',
    "import('tsx/esm/api').then(async ({tsImport})=>{try{await tsImport('./src/config.ts',import.meta.url).then(m=>m.loadConfig());process.exit(2)}catch(e){if(!String(e).includes('OIDC_ISSUER'))process.exit(3);console.log('fail-closed')}})",
  );
  if (fail !== 'fail-closed') throw new Error('Production API accepted missing identity configuration');
  checks.push('API production configuration fails closed without identity and database credentials');

  await new PrismService(
    fixture.db,
    loadConfig({
      PRISM_AUTH_MODE: 'development',
      PRISM_USER_ID: fixture.userId,
      PRISM_ALLOWED_SUBJECT: fixture.subject,
    }),
  ).initialize();
  const databaseUrl = new URL(fixture.url);
  databaseUrl.hostname = process.env.PRISM_TEST_DOCKER_HOST ?? 'host.docker.internal';
  const redisUrl = process.env.PRISM_TEST_CONTAINER_REDIS_URL ?? 'redis://host.docker.internal:56379';
  const workerEnv = await envFile('worker', {
    NODE_ENV: 'production',
    PRISM_AUTH_MODE: 'oidc',
    DATABASE_URL: databaseUrl.toString(),
    REDIS_URL: redisUrl,
    OIDC_ISSUER: 'https://identity.invalid',
    OIDC_AUDIENCE: 'container-smoke',
    PRISM_USER_ID: fixture.userId,
    PRISM_ALLOWED_SUBJECT: fixture.subject,
    PRISM_SIGNING_SECRET: randomBytes(32).toString('hex'),
    PRISM_QUEUE_NAME: `prism-smoke-${id}`,
  });
  await docker('run', '-d', '--name', names.worker, '--env-file', workerEnv, 'prism-worker:local');
  let started = false;
  for (let i = 0; i < 30; i++) {
    const logs = await docker('logs', names.worker);
    if (logs.includes('"event":"started"')) {
      started = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!started) throw new Error('Production Worker did not initialize against PostgreSQL/Redis');
  await new Promise((r) => setTimeout(r, 1500));
  if ((await docker('inspect', '--format', '{{.State.Running}}', names.worker)) !== 'true')
    throw new Error('Worker exited');
  checks.push(
    'Production Worker imports declared runtime graph and stays running against non-owner PostgreSQL plus Redis',
  );

  const webEnv = await envFile('web', {
    NODE_ENV: 'production',
    REDIS_URL: redisUrl,
    PRISM_SESSION_SECRET: randomBytes(32).toString('hex'),
    PRISM_API_URL: 'http://unused-api.invalid',
    PRISM_WEB_ORIGIN: 'https://prism.invalid',
  });
  await docker('run', '-d', '--name', names.web, '--env-file', webEnv, 'prism-web:local');
  await ready(names.web, 'http://127.0.0.1:3000/today');
  const unauth = await evaluate(
    names.web,
    "fetch('http://127.0.0.1:3000/api/v1/me').then(r=>console.log(r.status))",
  );
  if (unauth !== '401') throw new Error('Production BFF accepted an unauthenticated request');
  checks.push('Production Next image serves HTML and BFF returns 401 without a session');
  const images: Record<string, string> = {};
  for (const target of ['api', 'worker', 'web'])
    images[target] = await docker('image', 'inspect', '--format', '{{.Id}}', `prism-${target}:local`);
  const report = {
    executed_at: new Date().toISOString(),
    result: 'passed',
    images,
    checks,
    isolation:
      'Disposable containers and PostgreSQL fixture; no host ports published; no personal data modified',
    limitations: [
      'API write smoke uses explicit loopback development auth inside its container',
      'Worker uses an inert issuer; real provider and production TLS are not tested here',
      'Local Docker Desktop service reachability; not a managed deployment test',
    ],
  };
  await writeFile('docs/verification/container-smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  for (const name of Object.values(names)) await docker('rm', '-f', name).catch(() => {});
  await fixture.cleanup();
  await rm(folder, { recursive: true, force: true });
}
