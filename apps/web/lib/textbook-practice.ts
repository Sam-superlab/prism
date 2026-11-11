export type Outcome = 'solved' | 'hint' | 'stuck';
export const outcomes: Record<Outcome, string> = {
  solved: 'Solved',
  hint: 'Solved with a hint',
  stuck: 'Stuck',
};

export interface PracticeExercise {
  id: string;
  book: string;
  chapter: string;
  number: string;
  statement: string;
  original: string;
  sourceUrl?: string;
  pdfId?: string;
  pdfName?: string;
  fromPage?: number;
  toPage?: number;
  topics: string[];
  note?: { id: string; title: string };
}

export interface PracticeAttempt {
  id: string;
  exerciseId: string;
  outcome: Outcome;
  notes: string;
  at: string;
}

export interface PracticePdf {
  name: string;
  bytes: ArrayBuffer;
}

export interface PracticeLibrary {
  exercises: PracticeExercise[];
  attempts: PracticeAttempt[];
}

export function exerciseId(book: string, chapter: string, number: string) {
  return JSON.stringify(
    [book, chapter, number].map((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()),
  );
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Could not save practice data.'));
  });
}

async function withDatabase<T>(userId: string, work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  if (!globalThis.indexedDB) throw new Error('Local storage is unavailable in this browser.');
  const open = indexedDB.open(`prism.textbook-practice.${userId}`, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('exercises', { keyPath: 'id' });
    open.result.createObjectStore('attempts', { keyPath: 'id' });
    open.result.createObjectStore('pdfs');
  };
  const database = await result(open);
  try {
    return await work(database);
  } finally {
    database.close();
  }
}

export function loadPracticeLibrary(userId: string): Promise<PracticeLibrary> {
  return withDatabase(userId, async (database) => {
    const transaction = database.transaction(['exercises', 'attempts']);
    const [exercises, attempts] = await Promise.all([
      result<PracticeExercise[]>(transaction.objectStore('exercises').getAll()),
      result<PracticeAttempt[]>(transaction.objectStore('attempts').getAll()),
    ]);
    return { exercises, attempts };
  });
}

export async function savePracticeImport(
  userId: string,
  exercises: PracticeExercise[],
  pdf?: PracticePdf,
): Promise<{ saved: number; skipped: number }> {
  const pdfId = pdf
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pdf.bytes)))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    : undefined;
  return withDatabase(userId, async (database) => {
    const transaction = database.transaction(['exercises', 'pdfs'], 'readwrite');
    const done = committed(transaction);
    const store = transaction.objectStore('exercises');
    let saved = 0;
    const lookup = store.getAllKeys();
    lookup.onsuccess = () => {
      // Queue writes in the request callback so the transaction stays active in WebKit.
      const keys = new Set(lookup.result);
      for (const exercise of exercises) {
        if (keys.has(exercise.id)) continue;
        store.add(pdf ? { ...exercise, pdfId, pdfName: pdf.name } : exercise);
        keys.add(exercise.id);
        saved += 1;
      }
      if (pdf && pdfId && saved) {
        transaction.objectStore('pdfs').put(pdf.bytes, pdfId);
      }
    };
    await done;
    return { saved, skipped: exercises.length - saved };
  });
}

export function savePracticeExercise(userId: string, exercise: PracticeExercise) {
  return withDatabase(userId, async (database) => {
    const transaction = database.transaction('exercises', 'readwrite');
    transaction.objectStore('exercises').put(exercise);
    await committed(transaction);
  });
}

export function recordPracticeAttempt(userId: string, attempt: PracticeAttempt) {
  return withDatabase(userId, async (database) => {
    const transaction = database.transaction('attempts', 'readwrite');
    transaction.objectStore('attempts').add(attempt);
    await committed(transaction);
  });
}

export async function loadPracticePdf(userId: string, pdfId: string): Promise<Blob | undefined> {
  const data = await withDatabase(userId, (database) =>
    result<ArrayBuffer | Blob | undefined>(database.transaction('pdfs').objectStore('pdfs').get(pdfId)),
  );
  return data instanceof ArrayBuffer ? new Blob([data], { type: 'application/pdf' }) : data;
}

export function sourceAddress(value: string) {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // Show a single, actionable error for invalid addresses.
  }
  throw new Error('Enter a valid HTTPS textbook URL.');
}

export async function readTextbookWebPage(address: string) {
  const limit = 4_000_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(address, {
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.body ||
      !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')
    ) {
      throw new Error('The address did not return an HTML chapter.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('The page exceeds 4 MB.');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch {
    throw new Error(
      'PRISM could not read this web page directly. Paste the exercise text or import a saved HTML file or PDF.',
    );
  } finally {
    clearTimeout(timeout);
  }
}
