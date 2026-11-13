'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './ui';

type Tab = { id: number; href: string; title?: string };
export const destinations = [
  { path: 'today', label: 'Dashboard', icon: 'today' },
  { path: 'knowledge', label: 'Knowledge', icon: 'knowledge' },
  { path: 'practice', label: 'Practice', icon: 'check' },
  { path: 'research', label: 'Research', icon: 'research' },
  { path: 'discover', label: 'Discover', icon: 'discover' },
  { path: 'graph', label: 'Workspace Graph', icon: 'graph' },
  { path: 'settings', label: 'Settings', icon: 'settings' },
];

export function tabPath(href: string) {
  return href.split(/[?#]/)[0].slice(1);
}

export function tabDestination(href: string) {
  const path = tabPath(href);
  return destinations.find((item) => item.path === (path === 'review/session' ? 'knowledge' : path.split('/')[0]));
}

function restoreTabs(key: string): { tabs: Tab[]; selected: number } | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!Array.isArray(stored?.tabs) || stored.tabs.length === 0) return;
    const ids = new Set<number>();
    for (const tab of stored.tabs) {
      if (!Number.isSafeInteger(tab?.id) || tab.id < 1 || ids.has(tab.id) ||
        typeof tab.href !== 'string' || !tab.href.startsWith('/') ||
        !tabDestination(tab.href) || /[\\\x00-\x1f]/.test(tab.href) ||
        (tab.title !== undefined && typeof tab.title !== 'string')) return;
      ids.add(tab.id);
    }
    if (ids.has(stored.selected)) return stored;
  } catch {
    // The current page remains available without stored tabs.
  }
}

export function useWorkspaceTabs(href: string, userId?: string) {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, href }]);
  const [selected, setSelected] = useState(1);
  const key = userId && `prism.tabs.v1.${userId}`;
  const [loadedKey, setLoadedKey] = useState<string>();
  const currentHref = useRef(href);
  currentHref.current = href;
  const nextId = useRef(2);
  const pendingHref = useRef<string>(null);
  const positions = useRef(new Map<number, number>());

  useLayoutEffect(() => {
    setTabs((items) => {
      const tab = items.find((item) => item.id === selected);
      if (!tab || tab.href.split('#')[0] === href) return items;
      return items.map((item) => item.id !== selected ? item : {
        ...item,
        href,
        title: tabPath(item.href) === tabPath(href) ? item.title : undefined,
      });
    });
  }, [href, selected]);

  useEffect(() => {
    if (!key) return;
    const current = currentHref.current;
    const startup = current === '/today?restoreTabs=1';
    const saved = restoreTabs(key);
    if (saved) {
      const restored = saved.tabs;
      nextId.current = Math.max(...restored.map((tab) => tab.id)) + 1;
      const matching = restored.find((tab) => tab.href.split('#')[0] === current);
      const selectedTab = restored.find((tab) => tab.id === saved.selected)!;
      // Desktop launchers always enter /today. Honor other explicit links.
      const target = startup
        ? selectedTab
        : matching ?? { id: nextId.current++, href: current + location.hash };
      setTabs(restored.some((tab) => tab.id === target.id) ? restored : [...restored, target]);
      setSelected(target.id);
      pendingHref.current = target.href;
      if (target.href !== current + location.hash) window.history.replaceState(null, '', target.href);
    } else if (startup) window.history.replaceState(null, '', '/today');
    setLoadedKey(key);
  }, [key]);

  useEffect(() => {
    if (!key || loadedKey !== key) return;
    try {
      localStorage.setItem(key, JSON.stringify({ tabs, selected }));
    } catch {
      // Tabs remain usable in this session.
    }
  }, [key, loadedKey, tabs, selected]);

  useLayoutEffect(() => {
    const top = positions.current.get(selected) ?? 0;
    const hash = pendingHref.current?.split('#')[1];
    pendingHref.current = null;
    const anchor = hash && document.getElementById(hash);
    if (anchor && !positions.current.has(selected)) anchor.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top, behavior: 'instant' });
  }, [selected]);

  function activate(tab: Tab) {
    if (tab.id === selected) return;
    positions.current.set(selected, window.scrollY);
    pendingHref.current = tab.href;
    window.history.replaceState(null, '', tab.href);
    setSelected(tab.id);
  }

  function open(path: string, title?: string) {
    const existing = tabs.find((tab) => tab.href === path);
    if (existing) {
      activate(existing);
      return;
    }
    const tab = { id: nextId.current++, href: path, title };
    setTabs((items) => [...items, tab]);
    activate(tab);
  }

  function close(id: number) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (tabs.length < 2 || index === -1) return;
    if (id === selected) activate(tabs[index + 1] ?? tabs[index - 1]);
    setTabs((items) => items.filter((tab) => tab.id !== id));
    positions.current.delete(id);
  }

  function name(id: number, path: string, title: string) {
    setTabs((items) => {
      const current = items.find((tab) => tab.id === id);
      if (!current || tabPath(current.href) !== path || current.title === title) return items;
      return items.map((tab) => tab.id === id ? { ...tab, title } : tab);
    });
  }

  return { tabs, selected, activate, open, close, name };
}

export function WorkspaceTabList({
  state,
  onOpen,
}: {
  state: ReturnType<typeof useWorkspaceTabs>;
  onOpen: () => void;
}) {
  return (
    <nav className="workspace-tab-strip" aria-label="Workspace tabs">
      <div className="workspace-tab-list">
        {state.tabs.map((tab) => {
          const destination = tabDestination(tab.href);
          const title = tab.title ?? (tabPath(tab.href) === 'review/session' ? 'Review session' : destination?.label ?? 'Page');
          return (
            <div key={tab.id} className="workspace-tab" data-selected={tab.id === state.selected}>
              <button
                type="button"
                className="workspace-tab-select"
                aria-current={tab.id === state.selected ? 'page' : undefined}
                title={title}
                onClick={(event) => {
                  state.activate(tab);
                  event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}
              >
                <Icon name={destination?.icon ?? 'search'} size={15} />
                <span>{title}</span>
              </button>
              {state.tabs.length > 1 && (
                <button type="button" className="workspace-tab-close" title="Close tab" aria-label={`Close ${title} tab`} onClick={() => state.close(tab.id)}>
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-button workspace-new-tab" aria-label="New tab" title="New tab" onClick={onOpen}>
        <Icon name="plus" size={17} />
      </button>
    </nav>
  );
}
