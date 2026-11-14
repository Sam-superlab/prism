import type { LiteratureAttachmentFormat } from './literature-pdfs';

type QueuedAttachment = { id: string; format: LiteratureAttachmentFormat; failures: number; retryAt: number };
type State = { enabled: boolean; queue: QueuedAttachment[]; manual: number; failed: number };
const empty: State = { enabled: false, queue: [], manual: 0, failed: 0 };
const maximumQueue = 100;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const key = (user: string) => `prism.literature-auto-index.v1.${user}`;
const events = 'prism:literature-auto-index';
let currentUser: string | undefined;

export function bindLiteratureAutoIndexUser(user: string) {
  currentUser = user;
  return () => { if (currentUser === user) currentUser = undefined; };
}

function read(user: string): State {
  try {
    const value = JSON.parse(localStorage.getItem(key(user)) ?? 'null') as State | null;
    if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.queue)) return empty;
    return {
      enabled: value.enabled,
      queue: value.queue.slice(0, maximumQueue).filter((item) => item && typeof item.id === 'string' && uuid.test(item.id) &&
        ['pdf', 'epub', 'webpage'].includes(item.format) && Number.isInteger(item.failures) && item.failures >= 0 && item.failures <= 3 &&
        Number.isFinite(item.retryAt) && item.retryAt >= 0 && item.retryAt <= Date.now() + 15 * 60_000),
      manual: Number.isSafeInteger(value.manual) && value.manual >= 0 ? value.manual : 0,
      failed: Number.isSafeInteger(value.failed) && value.failed >= 0 ? value.failed : 0,
    };
  } catch { return empty; }
}

function write(user: string, state: State) {
  localStorage.setItem(key(user), JSON.stringify(state));
  window.dispatchEvent(new Event(events));
}

export function subscribeLiteratureAutoIndex(user: string, listener: () => void) {
  function storage(event: StorageEvent) { if (event.key === null || event.key === key(user)) listener(); }
  window.addEventListener(events, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(events, listener); window.removeEventListener('storage', storage); };
}

export const getLiteratureAutoIndex = read;

export function setLiteratureAutoIndex(user: string, enabled: boolean) {
  const prior = read(user);
  write(user, { ...prior, enabled });
}

export function captureLiteratureAutoIndexOwner() { return currentUser; }

export function enqueueLiteratureAutoIndex(user: string | undefined, id: string, format: LiteratureAttachmentFormat, size: number) {
  if (!user || currentUser !== user) return;
  try {
    const state = read(user);
    if (!state.enabled || state.queue.some((item) => item.id === id)) return;
    if (state.queue.length >= maximumQueue || size > 16 * 1024 * 1024) {
      write(user, { ...state, manual: state.manual + 1 });
      return;
    }
    write(user, { ...state, queue: [...state.queue, { id, format, failures: 0, retryAt: 0 }] });
  } catch { /* Attachment saves still succeed when local preferences are unavailable. */ }
}

export function finishLiteratureAutoIndex(user: string, id: string, outcome: 'done' | 'manual' | 'retry' | 'failed') {
  const state = read(user);
  const active = state.queue.find((item) => item.id === id);
  if (!active) return;
  const retry = outcome === 'retry' && active.failures < 3;
  const queue = state.queue.filter((item) => item.id !== id);
  if (retry) queue.push({ ...active, failures: active.failures + 1, retryAt: Date.now() + 15_000 * 2 ** active.failures });
  try {
    write(user, { ...state, queue, manual: state.manual + Number(outcome === 'manual'),
      failed: state.failed + Number(outcome === 'failed' || outcome === 'retry' && !retry) });
  } catch { /* A later attempt will reuse the server's committed progress. */ }
}
