'use client';

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import styles from './ResearchReferences.module.css';

type Side = 'collections' | 'details';
export type LibrarySort = {
  sort: 'title' | 'author' | 'year';
  direction: 'asc' | 'desc';
};
type PanePreferences = { collections?: number; details?: number; collapsed: boolean; order: LibrarySort };
const storageKey = 'prism.literature.panes.v1';
const defaultOrder: LibrarySort = { sort: 'title', direction: 'asc' };
const defaults: PanePreferences = { collapsed: false, order: defaultOrder };
const minimums = { collections: 120, details: 224, results: 240 };
const limits = { collections: 360, details: 640 };
let preferences: PanePreferences | undefined;
const listeners = new Set<() => void>();

function parsePreferences(value: string | null): PanePreferences {
  try {
    const saved: unknown = JSON.parse(value ?? 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    const width = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    const order = 'order' in saved && saved.order;
    const sort = order && typeof order === 'object' && 'sort' in order ? order.sort : undefined;
    const direction = order && typeof order === 'object' && 'direction' in order ? order.direction : undefined;
    return {
      collections: width('collections' in saved ? saved.collections : undefined),
      details: width('details' in saved ? saved.details : undefined),
      collapsed: 'collapsed' in saved && saved.collapsed === true,
      order: (sort === 'title' || sort === 'author' || sort === 'year') && (direction === 'asc' || direction === 'desc')
        ? { sort, direction } : defaultOrder,
    };
  } catch {
    return defaults;
  }
}

function snapshot() {
  if (!preferences) {
    try { preferences = parsePreferences(localStorage.getItem(storageKey)); }
    catch { preferences = defaults; }
  }
  return preferences;
}

function notifyListeners() {
  for (const listener of listeners) listener();
}

function readExternalPreferences(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return;
  preferences = parsePreferences(event.newValue);
  notifyListeners();
}

function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', readExternalPreferences);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', readExternalPreferences);
  };
}

function updatePreferences(change: Partial<PanePreferences>) {
  preferences = { ...snapshot(), ...change };
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Keep it for this session. */ }
  notifyListeners();
}

export function useLibraryDetailsVisibility() {
  const { collapsed } = useSyncExternalStore(subscribe, snapshot, () => defaults);
  return { collapsed, setCollapsed: (value: boolean) => updatePreferences({ collapsed: value }) };
}

export function useLibrarySort() {
  const saved = useSyncExternalStore(subscribe, () => snapshot().order, () => defaultOrder);
  return { ...saved, setOrder: (order: LibrarySort) => updatePreferences({ order }) };
}

function clamp(width: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(width)));
}

function paneWidths(width: number, saved: PanePreferences) {
  const compact = width < 848;
  const desiredCollections = clamp(saved.collections ?? width * (compact ? 0.16 : 0.17),
    compact ? minimums.collections : 144, saved.collections ? limits.collections : 240);
  const desiredDetails = clamp(saved.details ?? width * (compact ? 0.35 : 0.32),
    compact ? minimums.details : 272, saved.details ? limits.details : 496);
  const maximumTotal = width - minimums.results - (saved.collapsed ? 1 : 2);
  const collections = clamp(desiredCollections, minimums.collections, maximumTotal - (saved.collapsed ? 0 : minimums.details));
  return { collections, details: saved.collapsed ? 0 : clamp(desiredDetails, minimums.details, maximumTotal - collections) };
}

export function LiteraturePanes({ collections, results, details, collectionId, detailsId, inspecting }: {
  collections: ReactNode; results: ReactNode; details: ReactNode;
  collectionId: string; detailsId: string; inspecting: boolean;
}) {
  const saved = useSyncExternalStore(subscribe, snapshot, () => defaults);
  const layout = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [draft, setDraft] = useState<{ side: Side; value: number }>();
  const drag = useRef<{ side: Side; pointer: number; startX: number; startWidth: number; value?: number }>(null);

  useLayoutEffect(() => {
    const element = layout.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const actual = paneWidths(width, saved);
  const rendered = draft ? { ...actual, [draft.side]: draft.value } : actual;
  const gridStyle = width ? {
    '--library-collections-width': `${rendered.collections}px`,
    '--library-details-width': `${rendered.details}px`,
  } as CSSProperties : undefined;

  function divider(side: Side, controls: string, label: string) {
    const direction = side === 'collections' ? 1 : -1;
    const adjacent = side === 'collections' ? actual.details : actual.collections;
    const maximum = clamp(width - adjacent - minimums.results - (saved.collapsed ? 1 : 2), minimums[side], limits[side]);
    function commit(value: number) {
      // Keep the other pane at its displayed width when restoring this split.
      const other = side === 'collections' ? 'details' : 'collections';
      updatePreferences({ ...(adjacent > 0 ? { [other]: adjacent } : {}), [side]: value });
    }
    return (
      <div className={styles.libraryDivider} role="separator" tabIndex={0} title={label} aria-label={label}
        aria-orientation="vertical" aria-controls={controls} aria-valuemin={minimums[side]} aria-valuemax={maximum}
        aria-valuenow={rendered[side]} aria-valuetext={`${rendered[side]} pixels`} data-dragging={draft?.side === side}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || drag.current) return;
          drag.current = { side, pointer: event.pointerId, startX: event.clientX, startWidth: actual[side] };
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointer !== event.pointerId || current.side !== side) return;
          const value = clamp(current.startWidth + (event.clientX - current.startX) * direction, minimums[side], maximum);
          current.value = value;
          setDraft({ side, value });
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (current?.pointer !== event.pointerId || current.side !== side) return;
          drag.current = null;
          setDraft(undefined);
          if (current.value !== undefined && current.value !== current.startWidth) commit(current.value);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointer !== event.pointerId) return;
          drag.current = null;
          setDraft(undefined);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 32 : 8;
          const changes: Record<string, number> = {
            ArrowLeft: actual[side] - step * direction,
            ArrowRight: actual[side] + step * direction,
            Home: minimums[side],
            End: maximum,
          };
          if (!Object.hasOwn(changes, event.key)) return;
          event.preventDefault();
          const value = clamp(changes[event.key], minimums[side], maximum);
          if (value !== actual[side]) commit(value);
        }} />
    );
  }

  return <div className={styles.libraryLayout} ref={layout} style={gridStyle}
    data-inspecting={inspecting} data-details-collapsed={saved.collapsed} data-dragging={!!draft}>
    {collections}
    {divider('collections', collectionId, 'Resize collections')}
    {results}
    {!saved.collapsed && divider('details', detailsId, 'Resize reference details')}
    {details}
  </div>;
}
