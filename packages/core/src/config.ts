import { resolve } from 'node:path';
export const LOCAL_USER_ID = '11111111-1111-4111-8111-111111111111';
export interface ApiConfig {
  host: string;
  port: number;
  production: boolean;
  authMode: 'development' | 'oidc';
  userId: string;
  allowedSubject: string;
  issuer?: string;
  audience?: string;
  mobileClientId?: string;
  mobileRedirectUri?: string;
  webOrigin: string;
  secret: string;
  dataDir: string;
  databaseUrl?: string;
  pushEncryptionKey?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.NODE_ENV === 'production';
  const authMode = env.PRISM_AUTH_MODE === 'development' ? 'development' : 'oidc';
  const host = env.PRISM_HOST ?? '127.0.0.1';
  if (authMode === 'development' && (production || !['127.0.0.1', '::1', 'localhost'].includes(host)))
    throw new Error('Development auth is allowed only on a loopback listener outside production.');
  if (
    authMode === 'oidc' &&
    (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.PRISM_ALLOWED_SUBJECT || !env.PRISM_USER_ID)
  )
    throw new Error(
      'OIDC_ISSUER, OIDC_AUDIENCE, PRISM_ALLOWED_SUBJECT and PRISM_USER_ID are required. For explicit local development set PRISM_AUTH_MODE=development.',
    );
  if (production && (!env.PRISM_SIGNING_SECRET || env.PRISM_SIGNING_SECRET.length < 32 || !env.DATABASE_URL))
    throw new Error('Production requires DATABASE_URL and a strong PRISM_SIGNING_SECRET.');
  return {
    host,
    port: Number(env.PRISM_PORT ?? 4000),
    production,
    authMode,
    userId: env.PRISM_USER_ID ?? LOCAL_USER_ID,
    allowedSubject: env.PRISM_ALLOWED_SUBJECT ?? 'local-development',
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
    mobileClientId: env.OIDC_MOBILE_CLIENT_ID,
    mobileRedirectUri: env.OIDC_MOBILE_REDIRECT_URI ?? 'prism://auth/callback',
    webOrigin: env.PRISM_WEB_ORIGIN ?? 'http://localhost:3000',
    secret: env.PRISM_SIGNING_SECRET ?? 'local-development-cursor-key-not-for-production',
    dataDir: resolve(env.PRISM_DATA_DIR ?? '.data'),
    databaseUrl: env.DATABASE_URL,
    pushEncryptionKey: env.PRISM_PUSH_ENCRYPTION_KEY,
  };
}
