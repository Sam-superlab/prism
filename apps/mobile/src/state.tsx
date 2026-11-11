import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { LocalStore, type Json } from './offline/store';
import { openStoreDriver } from './offline/sqlite';
import { Api, SyncEngine, entityEnvelope } from './services/api';
import {
  accessToken,
  clearSession,
  hasSession,
  normalizeConnection,
  readConnection,
  saveConnection,
  type ConnectionConfig,
} from './services/session';
import { configureTimezone } from './services/locale';

export type Item = { id: string; version?: string; [key: string]: any };
const uuid = () => Crypto.randomUUID();
type Runtime = {
  store: LocalStore;
  api: Api;
  sync: SyncEngine;
  deviceId: string;
  connection: ConnectionConfig;
};
type State = {
  ready: boolean;
  authenticated: boolean;
  connection: ConnectionConfig | null;
  runtime: Runtime | null;
  revision: number;
  pending: number;
  conflicts: number;
  recoveries: number;
  syncText: string;
  error: string | null;
  refresh: () => void;
  synchronize: () => Promise<void>;
  report: (error: unknown) => void;
  connect: (config: ConnectionConfig) => Promise<void>;
  sessionChanged: () => Promise<void>;
  logout: () => Promise<void>;
  list: (path: string, type: string) => Promise<Item[]>;
  get: (path: string) => Promise<any>;
  mutate: (path: string, method: string, body?: Json, current?: Item, type?: string) => Promise<Item>;
  queue: (
    operation: string,
    type: string,
    id: string,
    payload: Json,
    projected: Item,
    dependsOn?: string,
  ) => Promise<string>;
  acknowledgeRecovery: (id: string) => Promise<void>;
};
async function currentCounts(store: LocalStore) {
  const status = await store.status();
  return {
    pending: status.pending,
    conflicts: status.conflicts,
    recoveries: await store.recoveryNoticeCount(),
  };
}
const Context = createContext<State | null>(null);
export const usePrism = () => {
  const state = useContext(Context);
  if (!state) throw new Error('Missing PRISM provider');
  return state;
};
export const newId = uuid;
export function MobileProvider({ children }: { children: React.ReactNode }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [revision, setRevision] = useState(0);
  const [counts, setCounts] = useState({ pending: 0, conflicts: 0, recoveries: 0 });
  const [syncText, setSyncText] = useState('Opening local storage');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const active = useRef<Runtime | null>(null);
  const refresh = useCallback(() => {
    setRevision((x) => x + 1);
  }, []);
  const report = useCallback((err: unknown) => {
    setError(err == null ? null : err instanceof Error ? err.message : String(err));
  }, []);

  const initialize = useCallback(
    async (connection: ConnectionConfig) => {
      connection = normalizeConnection(connection);
      const account = (
        await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, connection.apiUrl)
      ).slice(0, 16);
      const store = new LocalStore(await openStoreDriver(account));
      await store.initialize();
      const cachedProfile = await store.meta('cache:/me');
      if (cachedProfile) {
        const profile = JSON.parse(cachedProfile) as { timezone?: string };
        if (profile.timezone) configureTimezone(profile.timezone);
      }
      const deviceId = (await store.meta('device_id')) ?? uuid();
      await store.setMeta('device_id', deviceId);
      const api = new Api(
        connection.apiUrl,
        connection.development
          ? async () => null
          : async () => accessToken(connection.apiUrl, await store.accountId()),
        uuid,
      );
      const next = { store, api, sync: new SyncEngine(store, api, deviceId, uuid), deviceId, connection };
      const bound = await store.accountId();
      active.current = next;
      setRuntime(next);
      setAuthenticated(
        connection.development ||
          ((!(await store.hasUserData()) || Boolean(bound)) && (await hasSession(connection.apiUrl, bound))),
      );
      setCounts(await currentCounts(store));
      setSyncText('Local workspace ready');
      setReady(true);
      refresh();
      if (connection.setupRequired)
        setError(
          'Set an HTTPS API address in Connection settings and sign in. Pending operations in the previous development database remain on this device.',
        );
    },
    [refresh],
  );
  useEffect(() => {
    const extra = Constants.expoConfig?.extra ?? {};
    void readConnection({
      apiUrl: String(extra.apiUrl ?? 'http://127.0.0.1:4000/api/v1'),
      development: __DEV__ && extra.developmentAuth === true,
    })
      .then(initialize)
      .catch(report);
  }, [initialize, report]);

  const synchronize = useCallback(async () => {
    const r = active.current;
    if (!r) return;
    if (!r.connection.development) {
      const bound = await r.store.accountId();
      if ((!bound && (await r.store.hasUserData())) || !(await hasSession(r.connection.apiUrl, bound)))
        return;
    }
    setSyncText('Syncing…');
    try {
      await r.sync.sync();
      setSyncText('Up to date');
      setError(null);
    } catch (err) {
      setSyncText('Offline · Changes kept on device');
      throw err;
    } finally {
      setCounts(await currentCounts(r.store));
      refresh();
    }
  }, [refresh]);
  useEffect(() => {
    if (!runtime || !authenticated) return;
    void synchronize().catch(() => undefined);
    const timer = setInterval(() => {
      void synchronize().catch(() => undefined);
    }, 45000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void synchronize().catch(() => undefined);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [runtime, authenticated, synchronize]);

  const hydrate = useCallback(async (r: Runtime, type: string, item: Item) => {
    await r.store.applyRecord(entityEnvelope(type, item));
    if (type === 'workout_session') {
      for (const ex of item.exercises ?? [])
        await r.store.applyRecord(entityEnvelope('session_exercise', ex));
      for (const set of item.sets ?? []) await r.store.applyRecord(entityEnvelope('workout_set', set));
      for (const cardio of item.cardio ?? [])
        await r.store.applyRecord(entityEnvelope('cardio_entry', cardio));
    }
  }, []);
  const list = useCallback(
    async (path: string, type: string): Promise<Item[]> => {
      const r = active.current;
      if (!r) return [];
      try {
        const items = (await r.api.list(path)) as Item[];
        for (const item of items) await hydrate(r, type, item);
        await r.store.setMeta(`loaded:${path}`, new Date().toISOString());
      } catch (err) {
        const cached = await r.store.list(type);
        if (!cached.length && !(await r.store.meta(`loaded:${path}`))) throw err;
        setSyncText('Offline · Showing local records');
      }
      return (await r.store.list(type)) as Item[];
    },
    [hydrate],
  );
  const get = useCallback(async (path: string) => {
    const r = active.current;
    if (!r) return null;
    try {
      const item = await r.api.request(path);
      if (path === '/me' && typeof item.timezone === 'string') configureTimezone(item.timezone);
      await r.store.setMeta(`cache:${path}`, JSON.stringify(item));
      return item;
    } catch (err) {
      const cached = await r.store.meta(`cache:${path}`);
      if (cached) {
        setSyncText('Offline · Showing the last sync');
        return JSON.parse(cached);
      }
      throw err;
    }
  }, []);
  const mutate = useCallback(
    async (path: string, method: string, body?: Json, current?: Item, type?: string): Promise<Item> => {
      const r = active.current;
      if (!r) throw new Error('Local storage is not ready');
      const result = await r.api.request<Item>(path, method, body, current?.version);
      if (path === '/me' && typeof result?.timezone === 'string') configureTimezone(result.timezone);
      if (type && result?.id) await hydrate(r, type, result);
      if (method === 'DELETE' && type && current)
        await r.store.applyRecord(
          entityEnvelope(type, {
            ...current,
            deleted_at: new Date().toISOString(),
            version: (BigInt(current.version ?? '1') + 1n).toString(),
          }),
        );
      refresh();
      void synchronize().catch(() => undefined);
      return result;
    },
    [hydrate, refresh, synchronize],
  );
  const queue = useCallback(
    async (
      operation: string,
      type: string,
      id: string,
      payload: Json,
      projected: Item,
      dependsOn?: string,
    ): Promise<string> => {
      const r = active.current;
      if (!r) throw new Error('Local storage is not ready');
      const op = operation === 'review.rate' ? String(payload.idempotency_key) : uuid();
      await r.store.enqueue({
        id: op,
        operation,
        entityType: type,
        entityId: id,
        payload,
        projected,
        dependsOn,
        now: new Date().toISOString(),
      });
      setCounts(await currentCounts(r.store));
      setSyncText('Saved on this device');
      refresh();
      void synchronize().catch(() => undefined);
      return op;
    },
    [refresh, synchronize],
  );
  const value = useMemo<State>(
    () => ({
      ready,
      authenticated,
      runtime,
      connection: runtime?.connection ?? null,
      revision,
      ...counts,
      syncText,
      error,
      refresh,
      synchronize,
      report,
      list,
      get,
      mutate,
      queue,
      connect: async (config) => {
        await saveConnection(config);
        if (active.current?.connection.apiUrl !== config.apiUrl) await clearSession();
        await initialize(config);
        setError(null);
      },
      sessionChanged: async () => {
        const store = active.current?.store;
        const bound = await store?.accountId();
        setAuthenticated(
          Boolean(
            store &&
            (!(await store.hasUserData()) || bound) &&
            (await hasSession(active.current?.connection.apiUrl, bound)),
          ),
        );
        refresh();
      },
      logout: async () => {
        await clearSession();
        setAuthenticated(false);
        setError(null);
        setSyncText('Signed out · Offline operations retained');
      },
      acknowledgeRecovery: async (id) => {
        const r = active.current;
        if (
          !r ||
          (!r.connection.development && !(await hasSession(r.connection.apiUrl, await r.store.accountId())))
        )
          throw new Error('Sign in to the original workspace first.');
        await r.store.acknowledgeRecovery(id, new Date().toISOString());
        setCounts(await currentCounts(r.store));
        refresh();
      },
    }),
    [
      ready,
      authenticated,
      runtime,
      revision,
      counts,
      syncText,
      error,
      refresh,
      synchronize,
      report,
      list,
      get,
      mutate,
      queue,
      initialize,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useItems(path: string | null, type: string) {
  const p = usePrism();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    void p
      .list(path, type)
      .then((value) => {
        if (mounted) {
          setItems(value);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) setError(err.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [path, type, p.list, p.revision]);
  return { items, loading, error };
}
export function useValue(path: string | null) {
  const p = usePrism();
  const [value, setValue] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!path) {
      setValue(null);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    void p
      .get(path)
      .then((v) => {
        if (mounted) {
          setValue(v);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) setError(err.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [path, p.get, p.revision]);
  return { value, loading, error };
}
