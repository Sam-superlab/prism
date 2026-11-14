import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const validityMs = 10 * 60_000;
const safeOrigin = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

type SaveResult = 'saved' | 'duplicate' | 'rejected';
type Connection = {
  launch: Buffer;
  token: Buffer;
  expiresAt: number;
  commandId: string;
  origin?: string;
  payload?: Buffer;
  attempts: number;
  promise?: Promise<SaveResult>;
  saved?: SaveResult;
};

export function isCaptureExtensionOrigin(origin: string | null): origin is string {
  return origin !== null && safeOrigin.test(origin);
}

export function createBrowserCaptureConnection(now: () => number = Date.now) {
  let connection: Connection | undefined;
  function active(launch: string) {
    if (connection && connection.expiresAt <= now()) connection = undefined;
    if (!connection || !timingSafeEqual(connection.launch, digest(launch))) return;
    return connection;
  }
  function allows(launch: string, origin: string, token: string) {
    const entry = active(launch);
    return !!entry && isCaptureExtensionOrigin(origin) && (!entry.origin || entry.origin === origin) &&
      /^[A-Za-z0-9_-]{43}$/.test(token) && timingSafeEqual(entry.token, digest(token));
  }
  return {
    issue(launch: string, port: string) {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = now() + validityMs;
      connection = { launch: digest(launch), token: digest(token), expiresAt, commandId: randomUUID(), attempts: 0 };
      return { code: `prism1.${port}.${token}`, expires_at: new Date(expiresAt).toISOString() };
    },
    revoke(launch: string) {
      if (active(launch)) connection = undefined;
    },
    allows,
    async submit(launch: string, origin: string, token: string, transfer: string, save: (id: string) => Promise<SaveResult>) {
      const entry = active(launch);
      if (!entry || !allows(launch, origin, token)) return 'unavailable';
      const content = digest(transfer);
      if (entry.payload && !timingSafeEqual(entry.payload, content)) return 'unavailable';
      entry.origin = origin;
      entry.payload = content;
      if (entry.saved) return entry.saved;
      if (!entry.promise) {
        if (entry.attempts >= 5) return 'unavailable';
        entry.attempts++;
        entry.promise = Promise.resolve().then(() => save(entry.commandId));
      }
      const work = entry.promise;
      try {
        const result = await work;
        entry.saved = result;
        return result;
      } finally {
        if (entry.promise === work) entry.promise = undefined;
      }
    },
  };
}

export const browserCaptureConnection = createBrowserCaptureConnection();
