'use client';

import { useEffect, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Page } from '../lib/types';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';

export type LiteratureCollection = { id: string; name: string; parent_id: string | null; version: string };
type Membership = { id: string; collection_id: string; version: string };
const collectionPath = '/research/library/collections';
const membershipPath = '/research/library/memberships';

function orderedCollections(items: LiteratureCollection[]) {
  const byParent = new Map<string | null, LiteratureCollection[]>();
  for (const item of items) {
    const siblings = byParent.get(item.parent_id) ?? [];
    siblings.push(item);
    byParent.set(item.parent_id, siblings);
  }
  const ordered: { item: LiteratureCollection; depth: number }[] = [];
  const visited = new Set<string>();
  function walk(parentId: string | null, depth: number) {
    for (const item of (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      ordered.push({ item, depth });
      walk(item.id, depth + 1);
    }
  }
  walk(null, 0);
  return ordered;
}

export function useLiteratureCollections() {
  return useResource<{ items: LiteratureCollection[] }>(collectionPath);
}

export function CollectionNavigation({
  id, collections, selected, onSelect, onChanged,
}: {
  id?: string;
  collections: ReturnType<typeof useLiteratureCollections>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
}) {
  const [edit, setEdit] = useState<LiteratureCollection | 'new'>();
  const [remove, setRemove] = useState<LiteratureCollection>();
  const items = collections.data?.items ?? [];
  const ordered = orderedCollections(items);
  const current = items.find((item) => item.id === selected);
  const action = useAction(() => {
    setRemove(undefined);
    onSelect(null);
    onChanged();
  });

  return (
    <aside id={id} className={styles.collectionNavigation} aria-label="Literature collections">
      <div className={styles.collectionHeader}>
        <h2>Collections</h2>
        <button className="icon-button" type="button" aria-label="New collection" title="New collection"
          onClick={() => setEdit('new')}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <ErrorState error={collections.error} retry={collections.reload} />
      <nav aria-label="Collection filters">
        <button type="button" className={styles.collectionChoice} aria-current={!selected ? 'true' : undefined}
          onClick={() => onSelect(null)}>All references</button>
        {ordered.map(({ item, depth }) => (
          <button
            key={item.id}
            type="button"
            className={styles.collectionChoice}
            aria-current={selected === item.id ? 'true' : undefined}
            style={{ paddingInlineStart: `calc(0.55rem + ${Math.min(depth, 6)} * 0.8rem)` }}
            onClick={() => onSelect(item.id)}
          >
            {item.name}
          </button>
        ))}
      </nav>
      {current && (
        <div className={styles.inlineActions}>
          <button className="button small" type="button" onClick={() => setEdit(current)}>Edit collection</button>
          <button className="button small" type="button" onClick={() => { action.setError(null); setRemove(current); }}>
            Delete collection
          </button>
        </div>
      )}
      {edit && (
        <CollectionEditor
          item={edit === 'new' ? undefined : edit}
          parentId={edit === 'new' ? selected : edit.parent_id}
          ordered={ordered}
          onClose={() => setEdit(undefined)}
          onSaved={(id) => {
            setEdit(undefined);
            onSelect(id);
            onChanged();
          }}
        />
      )}
      {remove && (
        <Modal title="Delete collection" onClose={() => { if (!action.busy) setRemove(undefined); }}>
          <p>Delete “{remove.name}”? The collection must be empty.</p>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          <div className="modal-footer">
            <button className="button" type="button" disabled={action.busy} onClick={() => setRemove(undefined)}>Cancel</button>
            <button className="button primary" type="button" disabled={action.busy} onClick={() => {
              void action.run(() => api(`${collectionPath}/${remove.id}`, { method: 'DELETE', version: remove.version }));
            }}>Delete collection</button>
          </div>
        </Modal>
      )}
    </aside>
  );
}

function CollectionEditor({
  item, parentId, ordered, onClose, onSaved,
}: {
  item?: LiteratureCollection;
  parentId: string | null;
  ordered: ReturnType<typeof orderedCollections>;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [id] = useState(() => item?.id ?? uuid());
  const action = useAction();
  const descendants = new Set(item ? [item.id] : []);
  for (const { item: child } of ordered) {
    if (child.parent_id && descendants.has(child.parent_id)) descendants.add(child.id);
  }
  return (
    <Modal title={item ? 'Edit collection' : 'New collection'} onClose={() => { if (!action.busy) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const name = String(form.get('name') ?? '').trim();
        if (!name) return;
        const parent = String(form.get('parent') ?? '') || null;
        void action.run(async () => {
          if (item) await api(`${collectionPath}/${id}`, {
            method: 'PATCH', version: item.version, body: { name, parent_id: parent },
          });
          else await api(collectionPath, { method: 'POST', body: { id, name, parent_id: parent } });
          onSaved(id);
        });
      }}>
        <Field label="Name">
          <input name="name" defaultValue={item?.name} required maxLength={120} />
        </Field>
        <Field label="Parent collection">
          <select name="parent" defaultValue={parentId ?? ''}>
            <option value="">Library root</option>
            {ordered.filter(({ item: parent }) => !descendants.has(parent.id)).map(({ item: parent, depth }) => (
              <option key={parent.id} value={parent.id}>{'  '.repeat(depth)}{parent.name}</option>
            ))}
          </select>
        </Field>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" type="submit" disabled={action.busy}>Save collection</button>
        </div>
      </form>
    </Modal>
  );
}

export function ReferenceCollections({
  id, title, items, onClose, onChanged,
}: {
  id: string;
  title: string;
  items: LiteratureCollection[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const load = async () => {
      const entries: Membership[] = [];
      const params = new URLSearchParams({ reference_id: id, limit: '100' });
      while (true) {
        const result = await api<Page<Membership>>(`${membershipPath}?${params}`, { signal: controller.signal });
        entries.push(...result.items);
        if (!result.next_cursor) return entries;
        params.set('cursor', result.next_cursor);
      }
    };
    void load().then((entries) => {
      if (!controller.signal.aborted) setMemberships(entries);
    }).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [id, revision]);
  const [membershipIds] = useState(() => new Map<string, string>());
  const action = useAction(() => {
    reload();
    onChanged();
  });
  const ordered = orderedCollections(items);
  return (
    <Modal title="Manage collections" onClose={() => { if (!action.busy) onClose(); }}>
      <p>{title}</p>
      <ErrorState error={error} retry={reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {loading && <Loading />}
      {!loading && !error && (
        <ul className={styles.rows}>
          {ordered.map(({ item, depth }) => {
            const membership = memberships.find((entry) => entry.collection_id === item.id);
            return (
              <li className={styles.row} key={item.id} style={{ paddingInlineStart: `${Math.min(depth, 6) * 0.8}rem` }}>
                <span>{item.name}</span>
                <button className="button small" type="button"
                  aria-label={membership ? `Remove from ${item.name}` : `Add to ${item.name}`}
                  disabled={action.busy || loading}
                  onClick={() => {
                    void action.run(async () => {
                      if (membership) {
                        await api(`${membershipPath}/${membership.id}`, { method: 'DELETE', version: membership.version });
                        membershipIds.delete(item.id);
                        return;
                      }
                      const membershipId = membershipIds.get(item.id) ?? uuid();
                      membershipIds.set(item.id, membershipId);
                      await api(membershipPath, {
                        method: 'POST', body: { id: membershipId, collection_id: item.id, reference_id: id },
                      });
                    });
                  }}>
                  {membership ? 'Remove' : 'Add'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {items.length === 0 && <p className="muted">Create a collection from the library first.</p>}
    </Modal>
  );
}
