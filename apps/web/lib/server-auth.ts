import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE = 'prism_session';
export const FLOW_COOKIE = 'prism_oidc_flow';
export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenEndpoint: string;
  idToken?: string;
}
interface StoredSession extends AuthSession {
  sessionExpiresAt: number;
}
export interface AuthFlow {
  state: string;
  verifier: string;
  nonce: string;
  issuer: string;
  redirectUri: string;
  tokenEndpoint: string;
  createdAt: number;
}
export function apiBase() {
  return process.env.PRISM_API_URL || 'http://127.0.0.1:4000';
}
export function desktopMode() {
  return process.env.PRISM_AUTH_MODE === 'desktop';
}
export function desktopTokenFor(request: NextRequest): string | null | undefined {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const webOrigin = process.env.PRISM_WEB_ORIGIN ?? '';
  const apiOrigin = process.env.PRISM_API_URL ?? '';
  const localOrigin = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;
  if (
    !localOrigin.test(webOrigin) ||
    !localOrigin.test(apiOrigin) ||
    apiOrigin === webOrigin ||
    request.headers.get('host') !== webOrigin.slice('http://'.length) ||
    (origin !== null && origin !== webOrigin) ||
    (site !== null && site !== 'same-origin' && site !== 'none')
  )
    return null;
  const token = process.env.PRISM_DESKTOP_TOKEN ?? '';
  const cookie = request.cookies.get('prism_desktop')?.value ?? '';
  if (
    /^[a-f0-9]{64}$/.test(token) &&
    /^[a-f0-9]{64}$/.test(cookie) &&
    timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
  )
    return token;
}
function key() {
  const secret = process.env.PRISM_SESSION_SECRET;
  if (process.env.NODE_ENV === 'production' && (!secret || secret.length < 32))
    throw new Error('PRISM_SESSION_SECRET must contain at least 32 characters.');
  return createHash('sha256')
    .update(secret || 'prism-local-development-cookie-key-not-for-production')
    .digest();
}
export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
export function unseal<T>(value?: string): T | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'),
    ) as T;
  } catch {
    return null;
  }
}
export function setCookie(response: NextResponse, name: string, value: unknown, maxAge: number) {
  response.cookies.set(name, seal(value), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}
export function clearCookie(response: NextResponse, name: string) {
  response.cookies.set(name, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
const runtime = globalThis as typeof globalThis & {
  prismSessionRedis?: Redis;
  prismDevSessions?: Map<string, string>;
};
function redis() {
  if (!process.env.REDIS_URL) {
    if (process.env.NODE_ENV === 'production')
      throw new Error('REDIS_URL is required for production Web sessions');
    return null;
  }
  return (runtime.prismSessionRedis ||= new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  }));
}
function sessionKey(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid session identifier');
  return `prism:web:session:${id}`;
}
async function saveServerSession(id: string, session: StoredSession) {
  const r = redis();
  const value = seal(session);
  if (r)
    await r.set(
      sessionKey(id),
      value,
      'EX',
      Math.max(1, Math.ceil((session.sessionExpiresAt - Date.now()) / 1000)),
    );
  else (runtime.prismDevSessions ||= new Map()).set(sessionKey(id), value);
}
async function readSessionRecord(id: string) {
  const r = redis();
  const raw = r ? await r.get(sessionKey(id)) : runtime.prismDevSessions?.get(sessionKey(id));
  const session = unseal<StoredSession>(raw || undefined);
  return raw && session ? { raw, session } : null;
}
async function readServerSession(id: string) {
  return (await readSessionRecord(id))?.session || null;
}
async function replaceServerSession(id: string, expected: string, session: StoredSession) {
  const r = redis();
  const key = sessionKey(id);
  const value = seal(session);
  const ttl = Math.max(1, Math.ceil((session.sessionExpiresAt - Date.now()) / 1000));
  if (r)
    return (
      Number(
        await r.eval(
          "if redis.call('get',KEYS[1])~=ARGV[1] then return 0 end redis.call('set',KEYS[1],ARGV[2],'EX',ARGV[3]) return 1",
          1,
          key,
          expected,
          value,
          String(ttl),
        ),
      ) === 1
    );
  const sessions = runtime.prismDevSessions;
  if (!sessions || sessions.get(key) !== expected) return false;
  sessions.set(key, value);
  return true;
}
async function removeServerSession(id: string) {
  const r = redis();
  if (r) await r.del(sessionKey(id));
  else runtime.prismDevSessions?.delete(sessionKey(id));
}
export async function createServerSession(session: AuthSession): Promise<{ id: string; maxAge: number }> {
  const id = randomBytes(32).toString('hex');
  const maxAge = session.refreshToken
    ? 30 * 86400
    : Math.max(1, Math.round((session.expiresAt - Date.now()) / 1000));
  await saveServerSession(id, { ...session, sessionExpiresAt: Date.now() + maxAge * 1000 });
  return { id, maxAge };
}
export async function deleteServerSession(request: NextRequest) {
  const cookie = unseal<{ id: string }>(request.cookies.get(SESSION_COOKIE)?.value);
  if (cookie?.id) await removeServerSession(cookie.id);
}
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site') return false;
  const expected = process.env.PRISM_WEB_ORIGIN || request.nextUrl.origin;
  return origin === expected || (!origin && (site === 'same-origin' || site === 'none'));
}
export function oauthClient() {
  const clientId = process.env.PRISM_OIDC_CLIENT_ID;
  if (!clientId) throw new Error('Web sign-in requires PRISM_OIDC_CLIENT_ID to be configured.');
  return { clientId, clientSecret: process.env.PRISM_OIDC_CLIENT_SECRET };
}
export async function tokenRequest(endpoint: string, parameters: Record<string, string>) {
  const { clientId, clientSecret } = oauthClient();
  const body = new URLSearchParams({ ...parameters, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!response.ok || !result.access_token)
    throw new Error('The identity provider could not complete sign-in. Please try again.');
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
    tokenEndpoint: endpoint,
    idToken: result.id_token,
  } satisfies AuthSession;
}
export async function validateLogin(session: AuthSession, flow: AuthFlow) {
  if (!session.idToken) throw new Error('The identity provider did not return an OIDC ID token.');
  const { clientId } = oauthClient();
  const discovery = await fetch(`${flow.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!discovery.ok) throw new Error('Unable to read the identity provider signing configuration.');
  const config = (await discovery.json()) as { jwks_uri: string; issuer: string };
  if (config.issuer !== flow.issuer) throw new Error('OIDC issuer does not match.');
  const { payload } = await jwtVerify(session.idToken, createRemoteJWKSet(new URL(config.jwks_uri)), {
    issuer: flow.issuer,
    audience: clientId,
    algorithms: ['RS256', 'ES256', 'EdDSA'],
    requiredClaims: ['exp', 'iat', 'sub'],
    clockTolerance: 5,
  });
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
    throw new Error('OIDC authorized party does not match.');
  if (payload.nonce !== flow.nonce) throw new Error('OIDC nonce does not match.');
  const allowed = await fetch(`${apiBase()}/api/v1/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!allowed.ok) throw new Error('This account is not allowed to access the PRISM workspace.');
}
const refreshInFlight = new Map<string, Promise<StoredSession | null>>();
export async function sessionFor(
  request: NextRequest,
): Promise<{ session: AuthSession | null; changed: boolean }> {
  const cookie = unseal<{ id: string }>(request.cookies.get(SESSION_COOKIE)?.value);
  if (!cookie?.id) return { session: null, changed: false };
  const record = await readSessionRecord(cookie.id);
  const session = record?.session || null;
  if (!session || session.sessionExpiresAt <= Date.now()) {
    await deleteServerSession(request);
    return { session: null, changed: true };
  }
  if (session.expiresAt > Date.now() + 30000) return { session, changed: false };
  if (!session.refreshToken) {
    await deleteServerSession(request);
    return { session: null, changed: true };
  }
  const id = cookie.id;
  const current = session;
  const expected = record!.raw;
  let refresh = refreshInFlight.get(id);
  if (!refresh) {
    refresh = (async () => {
      const r = redis();
      const lockId = randomBytes(16).toString('hex');
      const lockKey = `${sessionKey(id)}:refresh`;
      let locked = false;
      try {
        if (r) {
          locked = Boolean(await r.set(lockKey, lockId, 'EX', 20, 'NX'));
          if (!locked) {
            for (let i = 0; i < 150; i++) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const updated = await readServerSession(id);
              if (!updated) return null;
              if (updated.expiresAt > Date.now() + 30000) return updated;
            }
            throw new Error('Session refresh is busy; retry shortly');
          }
        }
        try {
          const next = await tokenRequest(current.tokenEndpoint, {
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken!,
          });
          const { idToken: _unused, ...tokens } = next;
          const stored = {
            ...tokens,
            refreshToken: next.refreshToken || current.refreshToken,
            sessionExpiresAt: current.sessionExpiresAt,
          };
          if (await replaceServerSession(id, expected, stored)) return stored;
          const latest = await readServerSession(id);
          return latest && latest.expiresAt > Date.now() + 30000 ? latest : null;
        } catch {
          await removeServerSession(id);
          return null;
        }
      } finally {
        if (r && locked)
          await r.eval(
            "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
            1,
            lockKey,
            lockId,
          );
        refreshInFlight.delete(id);
      }
    })();
    refreshInFlight.set(id, refresh);
  }
  const refreshed = await refresh;
  return { session: refreshed, changed: !refreshed };
}
