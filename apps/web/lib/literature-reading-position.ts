'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

type ReadingPosition = { position: { page: number; version: string } | null };
const pendingPositionWrites = new Map<string, Promise<void>>();

export function useLiteratureReadingPosition(path: string, key: string, startPage?: number, legacyKey?: string) {
  const unsyncedKey = `${key}.pending`;
  const [initialPage, setInitialPage] = useState<number>();
  const [saveError, setSaveError] = useState('');
  const [syncConflict, setSyncConflict] = useState(false);
  const lastPage = useRef<number>(undefined);
  const skipPage = useRef<number>(undefined);
  const version = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    let closed = false;
    void (async () => {
      let local = 1;
      let unsynced = 0;
      try {
        await pendingPositionWrites.get(path);
        try {
          const legacy = legacyKey && localStorage.getItem(legacyKey);
          const legacyPage = legacy ? Math.max(1, Math.floor(Number(legacy) || 0) + 1) : 1;
          local = Number(localStorage.getItem(key)) || legacyPage;
          unsynced = Number(localStorage.getItem(unsyncedKey));
        } catch {}
        const { position } = await api<ReadingPosition>(path, { signal: controller.signal });
        if (closed) return;
        version.current = position?.version ?? null;
        if (unsynced && unsynced !== position?.page) {
          // A previous session could not sync this page. Keep it until the user resolves it.
          setSaveError('This device has an unsynced reading position.');
          setSyncConflict(!!position);
        } else if (unsynced) {
          try { localStorage.removeItem(unsyncedKey); } catch {}
        }
        if (position && (!unsynced || unsynced === position.page)) {
          try { localStorage.setItem(key, String(position.page)); } catch {}
        }
        setInitialPage(startPage ?? (unsynced || position?.page || local));
      } catch {
        if (!closed) {
          if (unsynced) setSaveError('This device has an unsynced reading position.');
          setInitialPage(startPage ?? (unsynced || local));
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { closed = true; clearTimeout(timeout); controller.abort(); };
  }, [key, path, startPage, unsyncedKey, legacyKey]);

  function save(page: number, retry = false) {
    const pending = pendingPositionWrites.get(path) ?? Promise.resolve();
    const next = pending.then(async () => {
      if (lastPage.current !== page) return;
      setSaveError('');
      setSyncConflict(false);
      try {
        if (retry || version.current === undefined) {
          const { position } = await api<ReadingPosition>(path, { signal: AbortSignal.timeout(4_000) });
          version.current = position?.version ?? null;
        }
        const { position } = await api<ReadingPosition>(path, {
          method: 'PUT', body: { page, expected_version: version.current }, signal: AbortSignal.timeout(8_000),
        });
        version.current = position?.version ?? null;
        try {
          if (Number(localStorage.getItem(unsyncedKey)) === page) localStorage.removeItem(unsyncedKey);
        } catch {}
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 412;
        setSyncConflict(conflict);
        setSaveError(conflict ? 'Another device updated the reading position.' : 'This reading position is saved on this device. Sync is unavailable.');
      }
    });
    pendingPositionWrites.set(path, next);
    void next.finally(() => {
      if (pendingPositionWrites.get(path) === next) pendingPositionWrites.delete(path);
    });
  }

  async function useSyncedPage(jump: (page: number) => void) {
    try {
      const { position } = await api<ReadingPosition>(path, { signal: AbortSignal.timeout(4_000) });
      if (!position) throw new Error('No shared reading position is available.');
      version.current = position.version;
      try {
        localStorage.setItem(key, String(position.page));
        localStorage.removeItem(unsyncedKey);
      } catch {}
      if (lastPage.current !== position.page) {
        skipPage.current = position.page;
        jump(position.page);
      }
      setSyncConflict(false);
      setSaveError('');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not load the shared reading position.');
    }
  }

  return { initialPage, saveError, syncConflict, useSyncedPage, retry: () => {
    if (lastPage.current !== undefined) save(lastPage.current, true);
  }, onPageChange: (page: number) => {
    const previous = lastPage.current;
    lastPage.current = page;
    const skipped = skipPage.current;
    skipPage.current = undefined;
    if (skipped === page) return;
    if (previous === undefined || previous === page) return;
    try {
      localStorage.setItem(key, String(page));
      localStorage.setItem(unsyncedKey, String(page));
    } catch {}
    save(page);
  } };
}
