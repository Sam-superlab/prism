'use client';

import { useEffect } from 'react';
import { ApiError } from '../lib/api';
import { bindLiteratureAutoIndexUser, finishLiteratureAutoIndex, getLiteratureAutoIndex, subscribeLiteratureAutoIndex } from '../lib/literature-auto-index';

export function LiteratureAutoIndexer({ userId }: { userId: string }) {
  useEffect(() => {
    const unbind = bindLiteratureAutoIndexUser(userId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    let mounted = true;
    let stopped = false;

    function schedule() {
      clearTimeout(timer);
      const state = getLiteratureAutoIndex(userId);
      if (!mounted || stopped || !state.enabled || document.visibilityState !== 'visible' || !navigator.onLine) {
        active?.abort();
        return;
      }
      if (active || !state.queue.length) return;
      const available = Math.min(...state.queue.map((item) => item.retryAt));
      timer = setTimeout(() => void run(), Math.max(1200, available - Date.now()));
    }

    async function run() {
      const state = getLiteratureAutoIndex(userId);
      const item = state.queue.find((entry) => entry.retryAt <= Date.now());
      if (!mounted || stopped || active || !state.enabled || !item || document.visibilityState !== 'visible' || !navigator.onLine) return;
      const controller = new AbortController();
      active = controller;
      try {
        const { buildLiteratureAttachmentIndex, withLiteratureIndexLock } = await import('../lib/literature-attachment-index');
        await withLiteratureIndexLock(async () => {
          // A different tab can finish or clear the item while the module loads.
          if (controller.signal.aborted || !getLiteratureAutoIndex(userId).queue.some((entry) => entry.id === item.id)) return;
          try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
            const result = await buildLiteratureAttachmentIndex(item, signal, () => {}, { maxSections: 300 });
            signal.throwIfAborted();
            finishLiteratureAutoIndex(userId, item.id, result === 'manual' ? 'manual' : 'done');
          } catch (cause) {
            if (controller.signal.aborted) return;
            const code = cause instanceof ApiError ? cause.status : undefined;
            if (code === 401 || code === 403) {
              // Account sign-out or read-only session. Leave the queue for a later writable launch.
              stopped = true;
              return;
            }
            const temporary = code === 0 || code === 409 || code === 429 || (code !== undefined && code >= 500) ||
              cause instanceof TypeError || (cause instanceof Error && cause.name === 'TimeoutError');
            finishLiteratureAutoIndex(userId, item.id, code === 404 ? 'done' : temporary ? 'retry' : 'failed');
          }
        });
      } catch {
        if (!controller.signal.aborted) finishLiteratureAutoIndex(userId, item.id, 'retry');
      } finally {
        active = undefined;
        schedule();
      }
    }

    const unsubscribe = subscribeLiteratureAutoIndex(userId, schedule);
    const hide = () => active?.abort();
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', schedule);
    window.addEventListener('online', schedule);
    window.addEventListener('offline', schedule);
    schedule();
    return () => {
      mounted = false;
      clearTimeout(timer);
      active?.abort();
      unsubscribe();
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', schedule);
      window.removeEventListener('online', schedule);
      window.removeEventListener('offline', schedule);
      unbind();
    };
  }, [userId]);
  return null;
}
