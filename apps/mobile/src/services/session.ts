import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

export type ConnectionConfig = { apiUrl: string; development: boolean; setupRequired?: boolean };
type TokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  apiUrl: string;
  accountId: string;
};
const configKey = 'prism.connection.v1';
const tokenKey = 'prism.credentials.v1';
let generation = 0;
let credentialTail: Promise<unknown> = Promise.resolve();
const refreshes = new Map<string, Promise<string | null>>();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = credentialTail.then(fn);
  credentialTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
const developmentBuild = () => typeof __DEV__ !== 'undefined' && __DEV__;
export function normalizeConnection(config: ConnectionConfig): ConnectionConfig {
  const development = developmentBuild() && config.development === true;
  const apiUrl = config.apiUrl.trim().replace(/\/$/, '');
  const url = new URL(apiUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Enter an API address without credentials, query parameters or a fragment.');
  if (!development && url.protocol !== 'https:')
    throw new Error('Release builds require HTTPS. Development mode cannot carry over to TestFlight.');
  if (development && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error(
      'Unauthenticated development access is limited to simulator loopback. Devices require HTTPS and OIDC.',
    );
  return { apiUrl, development, ...(config.setupRequired ? { setupRequired: true } : {}) };
}
export async function readConnection(fallback: ConnectionConfig): Promise<ConnectionConfig> {
  const stored = await SecureStore.getItemAsync(configKey);
  try {
    return normalizeConnection(stored ? (JSON.parse(stored) as ConnectionConfig) : fallback);
  } catch {
    // A Keychain development profile may survive an upgrade to a signed release.
    // Keep its database intact but never send unauthenticated HTTP requests from the release.
    try {
      return { ...normalizeConnection({ ...fallback, development: false }), setupRequired: true };
    } catch {
      return { apiUrl: 'https://prism.invalid/api/v1', development: false, setupRequired: true };
    }
  }
}
export async function saveConnection(config: ConnectionConfig): Promise<void> {
  const normalized = normalizeConnection(config);
  const previous = await SecureStore.getItemAsync(configKey);
  if (!previous || (JSON.parse(previous) as ConnectionConfig).apiUrl !== normalized.apiUrl)
    await clearSession();
  await SecureStore.setItemAsync(
    configKey,
    JSON.stringify({ apiUrl: normalized.apiUrl, development: normalized.development }),
  );
}
export async function verifyLoginAccount(
  apiUrl: string,
  token: string,
  expectedAccount?: string | null,
): Promise<{ id: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    const response = await fetch(`${apiUrl}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: abort.signal,
    });
    if (!response.ok)
      throw new Error(
        'This account is not allowed to access PRISM. Private device records remain locked and unsynced.',
      );
    const identity = (await response.json()) as { id?: unknown };
    if (typeof identity.id !== 'string' || !identity.id)
      throw new Error('The server did not return a valid account identity.');
    if (expectedAccount && identity.id !== expectedAccount)
      throw new Error(
        'This account does not match the device workspace. Existing records remain locked to prevent account mixing. Use a separate connection profile.',
      );
    return { id: identity.id };
  } finally {
    clearTimeout(timer);
  }
}
export async function saveTokens(
  tokens: AuthSession.TokenResponse,
  auth: { clientId: string; issuer: string; tokenEndpoint: string; apiUrl: string; accountId: string },
): Promise<void> {
  const bundle: TokenBundle = {
    ...auth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + (tokens.expiresIn ?? 3600) * 1000,
  };
  // External login intent invalidates any earlier refresh before waiting on native storage.
  generation++;
  await serialized(() =>
    SecureStore.setItemAsync(tokenKey, JSON.stringify(bundle), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  );
}
export async function hasSession(apiUrl?: string, accountId?: string | null): Promise<boolean> {
  return serialized(async () => {
    const before = generation;
    const raw = await SecureStore.getItemAsync(tokenKey);
    if (!raw || before !== generation) return false;
    try {
      const stored = JSON.parse(raw) as TokenBundle;
      return Boolean(
        stored.accountId &&
        (!apiUrl || stored.apiUrl === apiUrl) &&
        (!accountId || stored.accountId === accountId),
      );
    } catch {
      return false;
    }
  });
}
export async function clearSession(): Promise<void> {
  generation++;
  await serialized(() => SecureStore.deleteItemAsync(tokenKey));
}
export async function accessToken(apiUrl: string, expectedAccount?: string | null): Promise<string | null> {
  const snapshot = await serialized(async () => {
    const at = generation;
    const raw = await SecureStore.getItemAsync(tokenKey);
    return { at, raw };
  });
  if (!snapshot.raw || snapshot.at !== generation) return null;
  let stored: TokenBundle;
  try {
    stored = JSON.parse(snapshot.raw) as TokenBundle;
  } catch {
    return null;
  }
  if (
    stored.apiUrl !== apiUrl ||
    !stored.accountId ||
    (expectedAccount && stored.accountId !== expectedAccount)
  )
    return null;
  if (stored.expiresAt > Date.now() + 60000) return stored.accessToken;
  if (!stored.refreshToken) return stored.accessToken;
  const flightKey = `${apiUrl}:${snapshot.at}`;
  const existing = refreshes.get(flightKey);
  if (existing) return existing;
  const refresh = (async () => {
    const next = await AuthSession.refreshAsync(
      { clientId: stored.clientId, refreshToken: stored.refreshToken },
      { tokenEndpoint: stored.tokenEndpoint },
    );
    const bundle: TokenBundle = {
      ...stored,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? stored.refreshToken,
      expiresAt: Date.now() + (next.expiresIn ?? 3600) * 1000,
    };
    const committed = await serialized(async () => {
      if (snapshot.at !== generation) return false;
      const current = await SecureStore.getItemAsync(tokenKey);
      if (snapshot.at !== generation || current !== snapshot.raw) return false;
      // Do not call public saveTokens here: refresh retains the same session generation.
      await SecureStore.setItemAsync(tokenKey, JSON.stringify(bundle), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      return snapshot.at === generation;
    });
    return committed && snapshot.at === generation ? bundle.accessToken : null;
  })();
  refreshes.set(flightKey, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshes.get(flightKey) === refresh) refreshes.delete(flightKey);
  }
}
