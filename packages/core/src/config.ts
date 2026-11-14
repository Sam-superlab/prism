import { isAbsolute, resolve } from 'node:path';
export const LOCAL_USER_ID = '11111111-1111-4111-8111-111111111111';
export type HostedAccount = { subject: string; userId: string };
const accountIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface ApiConfig {
  host: string;
  port: number;
  production: boolean;
  authMode: 'development' | 'desktop' | 'oidc';
  desktopToken?: string;
  userId: string;
  allowedSubject: string;
  hostedAccounts?: HostedAccount[];
  developerLiteratureApi?: boolean;
  issuer?: string;
  audience?: string;
  mobileClientId?: string;
  mobileRedirectUri?: string;
  webOrigin: string;
  secret: string;
  dataDir: string;
  databaseUrl?: string;
  pushEncryptionKey?: string;
  reviewDraftApiKey?: string;
}
function hostedAccounts(raw: string, primary: HostedAccount): HostedAccount[] {
  if (!accountIdPattern.test(primary.userId)) throw new Error('PRISM_USER_ID must be a UUID.');
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error('PRISM_HOSTED_ACCOUNTS must be a JSON array of provisioned subject and user_id mappings.');
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 100)
    throw new Error('PRISM_HOSTED_ACCOUNTS must contain 1 to 100 provisioned accounts.');
  const accounts = [{ ...primary, userId: primary.userId.toLowerCase() }];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 2 ||
        typeof entry.subject !== 'string' || !entry.subject || entry.subject.length > 255 ||
        entry.subject !== entry.subject.trim() || typeof entry.user_id !== 'string' ||
        !accountIdPattern.test(entry.user_id))
      throw new Error('PRISM_HOSTED_ACCOUNTS contains an invalid subject or user_id.');
    const userId = entry.user_id.toLowerCase();
    if (accounts.some((account) => account.subject === entry.subject || account.userId === userId))
      throw new Error('PRISM_HOSTED_ACCOUNTS cannot reuse a subject or user_id.');
    accounts.push({ subject: entry.subject, userId });
  }
  return accounts;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.NODE_ENV === 'production';
  const mode = env.PRISM_AUTH_MODE;
  const authMode = mode === 'development' || mode === 'desktop' ? mode : 'oidc';
  const host = env.PRISM_HOST ?? '127.0.0.1';
  const port = Number(env.PRISM_PORT ?? 4000);
  if (authMode === 'development' && (production || !['127.0.0.1', '::1', 'localhost'].includes(host)))
    throw new Error('Development auth is allowed only on a loopback listener outside production.');
  if (
    authMode === 'desktop' &&
    (production ||
      host !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(env.PRISM_WEB_ORIGIN ?? '') ||
      !/^[a-f0-9]{64}$/.test(env.PRISM_DESKTOP_TOKEN ?? '') ||
      !isAbsolute(env.PRISM_DATA_DIR ?? '') ||
      env.DATABASE_URL)
  )
    throw new Error(
      'Desktop auth requires loopback services, a launch token, and an absolute local data directory.',
    );
  if (
    authMode === 'oidc' &&
    (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.PRISM_ALLOWED_SUBJECT || !env.PRISM_USER_ID)
  )
    throw new Error(
      'OIDC_ISSUER, OIDC_AUDIENCE, PRISM_ALLOWED_SUBJECT and PRISM_USER_ID are required. For explicit local development set PRISM_AUTH_MODE=development.',
    );
  if (production && (!env.PRISM_SIGNING_SECRET || env.PRISM_SIGNING_SECRET.length < 32 || !env.DATABASE_URL))
    throw new Error('Production requires DATABASE_URL and a strong PRISM_SIGNING_SECRET.');
  if (env.PRISM_HOSTED_ACCOUNTS !== undefined && (authMode !== 'oidc' || !env.DATABASE_URL))
    throw new Error('PRISM_HOSTED_ACCOUNTS requires hosted OIDC with PostgreSQL.');
  const developerLiteratureApi = env.PRISM_DEVELOPER_LITERATURE_API === 'true';
  if (developerLiteratureApi && (authMode !== 'oidc' || !env.DATABASE_URL))
    throw new Error('PRISM_DEVELOPER_LITERATURE_API requires hosted OIDC with PostgreSQL.');
  const roster = env.PRISM_HOSTED_ACCOUNTS === undefined ? undefined : hostedAccounts(env.PRISM_HOSTED_ACCOUNTS, {
    userId: env.PRISM_USER_ID!, subject: env.PRISM_ALLOWED_SUBJECT!,
  });
  return {
    host,
    port,
    production,
    authMode,
    desktopToken: authMode === 'desktop' ? env.PRISM_DESKTOP_TOKEN : undefined,
    userId: env.PRISM_USER_ID ?? LOCAL_USER_ID,
    allowedSubject: env.PRISM_ALLOWED_SUBJECT ?? 'local-development',
    hostedAccounts: roster,
    developerLiteratureApi,
    issuer: env.OIDC_ISSUER,
    audience: env.OIDC_AUDIENCE,
    mobileClientId: env.OIDC_MOBILE_CLIENT_ID,
    mobileRedirectUri: env.OIDC_MOBILE_REDIRECT_URI ?? 'prism://auth/callback',
    webOrigin: env.PRISM_WEB_ORIGIN ?? 'http://localhost:3000',
    secret: env.PRISM_SIGNING_SECRET ?? 'local-development-cursor-key-not-for-production',
    dataDir: resolve(env.PRISM_DATA_DIR ?? '.data'),
    databaseUrl: env.DATABASE_URL,
    pushEncryptionKey: env.PRISM_PUSH_ENCRYPTION_KEY,
    reviewDraftApiKey:
      env.NEXT_PUBLIC_PRISM_AI_REVIEW_DRAFTS === 'true' && env.PRISM_AI_PROMO_ONLY === 'true'
        ? env.OPENAI_API_KEY?.trim() || undefined
        : undefined,
  };
}
