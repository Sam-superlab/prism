'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, uuid } from './api';
import type { Page, UserPaper } from './types';

export const paperShelves = { saved: 'Saved', interested: 'Interested', liked: 'Liked' } as const;
export type PaperShelf = keyof typeof paperShelves;
export type PaperFolder = { id: string; shelf: PaperShelf; name: string; paperIds: string[] };

const storageEvent = 'prism:paper-folders';
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const empty: PaperFolder[] = [];
const snapshots = new Map<string, { value: string | null; folders: PaperFolder[] }>();
const folderPageSize = 100;

export function isPaperShelf(value: string): value is PaperShelf {
  return Object.hasOwn(paperShelves, value);
}

export function shelvesForPaper(paper: UserPaper): PaperShelf[] {
  const shelves: PaperShelf[] = [];
  if (paper.is_saved) shelves.push('saved');
  if (paper.for_you_reaction === 'interested' || paper.for_you_reaction === 'liked')
    shelves.push(paper.for_you_reaction);
  return shelves;
}

export function paperShelfQuery(shelf: PaperShelf) {
  return shelf === 'saved' ? '&saved=true' : `&reaction=${shelf}`;
}

function parseFolders(value: string | null): PaperFolder[] {
  try {
    const records: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(records)) return empty;
    return records.flatMap((record) => {
      const { id, shelf, name, paperIds } = (record ?? {}) as Partial<PaperFolder>;
      if (
        typeof id !== 'string' ||
        !idPattern.test(id) ||
        typeof shelf !== 'string' ||
        !isPaperShelf(shelf) ||
        typeof name !== 'string' ||
        !name.trim() ||
        !Array.isArray(paperIds)
      )
        return [];
      return [
        {
          id,
          shelf,
          name: name.trim(),
          paperIds: [
            ...new Set(paperIds.filter((paperId) => typeof paperId === 'string' && idPattern.test(paperId))),
          ],
        },
      ];
    });
  } catch {
    return empty;
  }
}

function snapshot(key: string) {
  const cached = snapshots.get(key);
  try {
    const value = localStorage.getItem(key);
    if (cached?.value === value) return cached.folders;
    const folders = parseFolders(value);
    snapshots.set(key, { value, folders });
    return folders;
  } catch {
    return cached?.folders ?? empty;
  }
}

function serverSnapshot() {
  return empty;
}

export function usePaperFolders(userId?: string) {
  const key = userId && `prism.paper-folders.v1.${userId}`;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => {};
      const local = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) notify();
      };
      const external = (event: StorageEvent) => {
        if (event.key === key || event.key === null) notify();
      };
      window.addEventListener(storageEvent, local);
      window.addEventListener('storage', external);
      return () => {
        window.removeEventListener(storageEvent, local);
        window.removeEventListener('storage', external);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => (key ? snapshot(key) : empty), [key]);
  const folders = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);

  function change(edit: (current: PaperFolder[]) => PaperFolder[]) {
    if (!key) throw new Error('Open a workspace to organize papers.');
    const next = edit(snapshot(key));
    const value = JSON.stringify(next);
    try {
      localStorage.setItem(key, value);
    } catch {
      throw new Error('Could not save paper folders on this device.');
    }
    snapshots.set(key, { value, folders: next });
    window.dispatchEvent(new CustomEvent(storageEvent, { detail: key }));
  }

  function folderName(current: PaperFolder[], shelf: PaperShelf, value: string, except?: string) {
    const name = value.trim();
    if (!name || name.length > 100) throw new Error('Enter a folder name up to 100 characters.');
    if (
      current.some(
        (folder) =>
          folder.id !== except && folder.shelf === shelf && folder.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error('A folder with that name already exists here.');
    return name;
  }

  function createFolder(shelf: PaperShelf, value: string, paperId?: string) {
    const id = uuid();
    change((current) => [
      ...current,
      {
        id,
        shelf,
        name: folderName(current, shelf, value),
        paperIds: paperId && idPattern.test(paperId) ? [paperId] : [],
      },
    ]);
    return id;
  }

  function renameFolder(id: string, value: string) {
    change((current) =>
      current.map((folder) =>
        folder.id === id ? { ...folder, name: folderName(current, folder.shelf, value, id) } : folder,
      ),
    );
  }

  function removeFolder(id: string) {
    change((current) => current.filter((folder) => folder.id !== id));
  }

  function togglePaper(folderId: string, paperId: string) {
    if (!idPattern.test(paperId)) return;
    change((current) =>
      current.map((folder) => {
        if (folder.id !== folderId) return folder;
        return {
          ...folder,
          paperIds: folder.paperIds.includes(paperId)
            ? folder.paperIds.filter((id) => id !== paperId)
            : [...folder.paperIds, paperId],
        };
      }),
    );
  }

  return { folders, createFolder, renameFolder, removeFolder, togglePaper };
}

export async function fetchPaperFolder(
  folder: PaperFolder,
  query = '',
  signal?: AbortSignal,
): Promise<Page<UserPaper>> {
  const items: UserPaper[] = [];
  const search = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : '';
  for (let start = 0; start < folder.paperIds.length; start += folderPageSize) {
    const ids = folder.paperIds.slice(start, start + folderPageSize).join(',');
    const page = await api<Page<UserPaper>>(
      `/arxiv/feed?limit=${folderPageSize}${paperShelfQuery(folder.shelf)}&ids=${encodeURIComponent(ids)}${search}`,
      { signal },
    );
    items.push(...page.items);
  }
  return { items, next_cursor: null };
}

export function usePaperFolderFeed(folder: PaperFolder | null, query = '') {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    folder: PaperFolder;
    query: string;
    revision: number;
    data: Page<UserPaper> | null;
    error: Error | null;
  }>();
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!folder) return;
    const controller = new AbortController();
    void fetchPaperFolder(folder, query, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ folder, query, revision, data, error: null });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setResult({ folder, query, revision, data: null, error });
      });
    return () => controller.abort();
  }, [folder, query, revision]);

  const current =
    result?.folder === folder && result.query === query && result.revision === revision ? result : undefined;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: !!folder && !current,
    reload,
  };
}
