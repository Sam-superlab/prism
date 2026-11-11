import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  refresh: vi.fn(),
  writeBlock: null as null | { entered: () => void; wait: Promise<void> },
}));
vi.mock('expo-auth-session', () => ({ refreshAsync: native.refresh }));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-device-only',
  getItemAsync: async (key: string) => native.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    const block = key === 'prism.credentials.v1' ? native.writeBlock : null;
    if (block) {
      native.writeBlock = null;
      block.entered();
      await block.wait;
    }
    native.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.values.delete(key);
  },
}));
import {
  accessToken,
  clearSession,
  hasSession,
  normalizeConnection,
  readConnection,
  saveConnection,
  saveTokens,
  verifyLoginAccount,
} from '../src/services/session';
const oldUrl = 'https://old.prism.invalid/api/v1';
const newUrl = 'https://new.prism.invalid/api/v1';
const auth = (apiUrl = oldUrl) => ({
  apiUrl,
  clientId: 'mobile',
  issuer: 'https://issuer.invalid',
  tokenEndpoint: 'https://issuer.invalid/token',
  accountId: apiUrl === oldUrl ? 'account-old' : 'account-new',
});
const expired = { accessToken: 'expired', refreshToken: 'refresh-old', expiresIn: -1 } as any;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.stubGlobal('__DEV__', true);
  native.writeBlock = null;
  await clearSession();
  native.values.clear();
  native.refresh.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
describe('serialized mobile credentials', () => {
  it('refreshes ten concurrent expired-token callers once', async () => {
    await saveTokens(expired, auth());
    const pending = deferred<any>();
    native.refresh.mockReturnValue(pending.promise);
    const callers = Array.from({ length: 10 }, () => accessToken(oldUrl));
    await vi.waitFor(() => expect(native.refresh).toHaveBeenCalledTimes(1));
    pending.resolve({ accessToken: 'rotated', refreshToken: 'refresh-new', expiresIn: 3600 });
    expect(await Promise.all(callers)).toEqual(Array(10).fill('rotated'));
    expect(native.refresh).toHaveBeenCalledTimes(1);
  });
  it('cannot resurrect credentials after logout during the token request', async () => {
    await saveTokens(expired, auth());
    const pending = deferred<any>();
    native.refresh.mockReturnValue(pending.promise);
    const refreshing = accessToken(oldUrl);
    await vi.waitFor(() => expect(native.refresh).toHaveBeenCalledTimes(1));
    await clearSession();
    pending.resolve({ accessToken: 'must-not-save', expiresIn: 3600 });
    expect(await refreshing).toBeNull();
    expect(await hasSession()).toBe(false);
    expect(await accessToken(oldUrl)).toBeNull();
  });
  it('serializes logout after an already-started native credential write', async () => {
    await saveTokens(expired, auth());
    const entered = deferred<void>(),
      release = deferred<void>();
    native.writeBlock = { entered: () => entered.resolve(), wait: release.promise };
    native.refresh.mockResolvedValue({ accessToken: 'late-native-write', expiresIn: 3600 });
    const refreshing = accessToken(oldUrl);
    await entered.promise;
    const logout = clearSession();
    release.resolve();
    await logout;
    expect(await refreshing).toBeNull();
    expect(await hasSession()).toBe(false);
  });
  it('does not overwrite a new login with an old pending refresh', async () => {
    await saveTokens(expired, auth());
    const pending = deferred<any>();
    native.refresh.mockReturnValue(pending.promise);
    const refreshing = accessToken(oldUrl);
    await vi.waitFor(() => expect(native.refresh).toHaveBeenCalledTimes(1));
    await saveTokens(
      { accessToken: 'new-login', refreshToken: 'login-refresh', expiresIn: 3600 } as any,
      auth(),
    );
    pending.resolve({ accessToken: 'old-refresh', expiresIn: 3600 });
    expect(await refreshing).toBeNull();
    expect(await accessToken(oldUrl)).toBe('new-login');
  });
  it('keeps a new server login when the previous server refresh completes', async () => {
    await saveConnection({ apiUrl: oldUrl, development: false });
    await saveTokens(expired, auth());
    const pending = deferred<any>();
    native.refresh.mockReturnValue(pending.promise);
    const refreshing = accessToken(oldUrl);
    await vi.waitFor(() => expect(native.refresh).toHaveBeenCalledTimes(1));
    await saveConnection({ apiUrl: newUrl, development: false });
    await saveTokens({ accessToken: 'new-server', expiresIn: 3600 } as any, auth(newUrl));
    pending.resolve({ accessToken: 'old-server', expiresIn: 3600 });
    expect(await refreshing).toBeNull();
    expect(await accessToken(newUrl)).toBe('new-server');
    expect(await accessToken(oldUrl)).toBeNull();
    expect((await readConnection({ apiUrl: newUrl, development: false })).apiUrl).toBe(newUrl);
  });
});
describe('signed release connection guard', () => {
  it('does not inherit a persisted development-auth profile after upgrading the build', async () => {
    await saveConnection({ apiUrl: 'http://127.0.0.1:4000/api/v1', development: true });
    vi.stubGlobal('__DEV__', false);
    const config = await readConnection({ apiUrl: newUrl, development: false });
    expect(config).toEqual({ apiUrl: newUrl, development: false, setupRequired: true });
    expect(normalizeConnection({ apiUrl: newUrl, development: true }).development).toBe(false);
    await expect(
      saveConnection({ apiUrl: 'http://127.0.0.1:4000/api/v1', development: true }),
    ).rejects.toThrow('HTTPS');
  });
  it('keeps connection setup usable when a release has no HTTPS deployment URL yet', async () => {
    vi.stubGlobal('__DEV__', false);
    expect(await readConnection({ apiUrl: 'http://127.0.0.1:4000/api/v1', development: true })).toEqual({
      apiUrl: 'https://prism.invalid/api/v1',
      development: false,
      setupRequired: true,
    });
  });
});
describe('verified account binding before unlocking local data', () => {
  it('rejects a nonallowlisted issuer account without accepting credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    await expect(verifyLoginAccount(oldUrl, 'wrong-account')).rejects.toThrow('not allowed');
    expect(await hasSession()).toBe(false);
  });
  it('rejects another canonical account at the same API address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'account-other' }), { status: 200 })),
    );
    await expect(verifyLoginAccount(oldUrl, 'other-token', 'account-old')).rejects.toThrow('does not match');
    expect(await hasSession()).toBe(false);
  });
  it('accepts a verified account while withholding its token from a different local binding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'account-old' }), { status: 200 })),
    );
    const account = await verifyLoginAccount(oldUrl, 'valid-token', 'account-old');
    await saveTokens({ accessToken: 'valid-token', expiresIn: 3600 } as any, {
      ...auth(),
      accountId: account.id,
    });
    expect(await hasSession(oldUrl, 'account-old')).toBe(true);
    expect(await hasSession(oldUrl, 'account-other')).toBe(false);
    expect(await accessToken(oldUrl, 'account-other')).toBeNull();
  });
  it('does not unlock offline data using a legacy bundle with no verified identity', async () => {
    native.values.set(
      'prism.credentials.v1',
      JSON.stringify({
        apiUrl: oldUrl,
        accessToken: 'legacy',
        refreshToken: 'legacy-refresh',
        expiresAt: Date.now() + 3600000,
      }),
    );
    expect(await hasSession(oldUrl)).toBe(false);
    expect(await accessToken(oldUrl)).toBeNull();
  });
});
