'use client';
import { useCallback, useEffect, useState } from 'react';
import { nextLocalTime } from '@prism/shared-utils';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function uuid() {
  return crypto.randomUUID();
}
let selectedTimezone: string | undefined;
export function profileTimezone() {
  return selectedTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function todayDate(timezone?: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || selectedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function datetime(value: string | null | undefined, short = false) {
  if (!value) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: selectedTimezone,
    ...(short
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  }).format(new Date(value));
}
export function localInputToInstant(value: string) {
  const [date, time] = value.split('T');
  return nextLocalTime(date, time, profileTimezone());
}
export function instantToLocalInput(value: string | null | undefined) {
  if (!value) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: selectedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replace(' ', 'T');
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; version?: string; key?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const bodyId =
    options.body &&
    typeof options.body === 'object' &&
    'id' in options.body &&
    typeof options.body.id === 'string'
      ? options.body.id
      : undefined;
  if (method !== 'GET')
    headers['Idempotency-Key'] = options.key || (method === 'POST' ? bodyId : undefined) || uuid();
  if (options.version) headers['If-Match'] = `"${options.version}"`;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('NETWORK_ERROR', 'Unable to connect. Check your connection and try again.', 0);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.message || `Request failed (${response.status})`,
      response.status,
      payload?.error?.details || {},
    );
  }
  if (response.status === 204) return undefined as T;
  const payload = await response.json();
  if (path === '/me' && payload?.timezone) selectedTimezone = payload.timezone;
  return payload as T;
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((x) => x + 1), []);
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e?.name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, setData, loading, error, reload };
}
export function useAction(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      onDone?.();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action could not be completed.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
