'use client';

import { useEffect, useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { LiteratureCondition } from '../lib/literature-advanced-search';
import { ErrorState, Field, Icon, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';

export type LiteratureFilters = { query: string; tag: string; collection: string | null; conditions?: LiteratureCondition | null };
type SavedSearch = { id: string; name: string; query: string; tag: string; collection_id: string | null; version: string;
  conditions?: LiteratureCondition | null };
const path = '/research/library/saved-searches';

export function LiteratureSavedSearches({ userId, filters, onApply }: {
  userId: string;
  filters: LiteratureFilters;
  onApply: (filters: LiteratureFilters) => void;
}) {
  const resource = useResource<{ items: SavedSearch[] }>(path);
  const items = resource.data?.items ?? [];
  const [edit, setEdit] = useState<'new' | SavedSearch>();
  const [selected, setSelected] = useState('');
  const [migrationError, setMigrationError] = useState('');
  const migrated = useRef(false);
  const attempt = useRef<{ value: string; key: string }>(null);
  const action = useAction(resource.reload);
  const active = items.find((item) => item.id === selected);
  const canSave = !!(filters.query || filters.tag || filters.collection || filters.conditions);

  useEffect(() => {
    if (!resource.data || migrated.current) return;
    migrated.current = true;
    const localKey = `prism.literature.saved-searches.v1.${userId}`;
    const migrate = async () => {
      const stored: unknown = JSON.parse(localStorage.getItem(localKey) ?? '[]');
      if (!Array.isArray(stored) || !stored.length) return;
      const existing = new Set(resource.data?.items.map((item) => item.id));
      const pending = [];
      for (const item of stored) {
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' ||
            typeof item.query !== 'string' || typeof item.tag !== 'string' || existing.has(item.id)) continue;
        try {
          await api(path, { method: 'POST', body: {
            id: item.id, name: item.name, query: item.query, tag: item.tag,
            collection_id: typeof item.collection === 'string' ? item.collection : null,
          } });
        } catch {
          pending.push(item);
        }
      }
      if (pending.length) {
        localStorage.setItem(localKey, JSON.stringify(pending));
        setMigrationError('Some older saved searches could not be moved. Their local copies were kept.');
      } else localStorage.removeItem(localKey);
      resource.reload();
    };
    void migrate().catch(() => setMigrationError('Older saved searches could not be read on this device.'));
  }, [userId, resource.data, resource.reload]);

  function apply(item: SavedSearch) {
    onApply({ query: item.query, tag: item.tag, collection: item.collection_id, conditions: item.conditions });
  }

  return (
    <section aria-label="Saved searches">
      {(items.length > 0 || canSave) && <div className={`${styles.toolbar} ${styles.savedSearchToolbar}`}>
        {items.length > 0 && (
          <>
            <select className={styles.search} aria-label="Saved searches" value={selected}
              onChange={(event) => {
                const id = event.target.value;
                setSelected(id);
                const item = items.find((entry) => entry.id === id);
                if (item) apply(item);
              }}>
              <option value="">Saved searches</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {active && <div role="group" aria-label="Saved search actions" className={styles.libraryToolGroup}>
              <button className="icon-button" type="button" disabled={action.busy} aria-label="Apply saved search"
                title="Apply saved search" onClick={() => apply(active)}><Icon name="refresh" size={15} /></button>
              <button className="icon-button" type="button" disabled={action.busy} aria-label="Edit saved search"
                title="Edit saved search" onClick={() => { action.setError(null); setEdit(active); }}><Icon name="edit" size={15} /></button>
              <button className="icon-button" type="button" disabled={action.busy} aria-label="Remove saved search"
                title="Remove saved search" onClick={() => {
                void action.run(async () => {
                  await api(`${path}/${active.id}`, { method: 'DELETE', version: active.version });
                  setSelected('');
                });
              }}><Icon name="trash" size={15} /></button>
            </div>}
          </>
        )}
        {canSave && <button type="button" className="button small" disabled={resource.loading || action.busy}
          onClick={() => { action.setError(null); setEdit('new'); }}>Save current search</button>}
      </div>}
      <ErrorState error={resource.error} retry={resource.reload} />
      {migrationError && <Notice tone="warning">{migrationError}</Notice>}
      {action.error && !edit && <Notice tone="error">{action.error}</Notice>}
      {edit && (
        <Modal title={edit === 'new' ? 'Save current search' : 'Edit saved search'}
          onClose={() => { if (!action.busy) setEdit(undefined); }}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = String(form.get('name') ?? '').trim();
            if (!name) return;
            const conditions = edit === 'new' ? { query: filters.query, tag: filters.tag } : {
              query: String(form.get('query') ?? '').trim(),
              tag: String(form.get('tag') ?? '').trim(),
            };
            const value = JSON.stringify([edit, name, conditions, filters.collection]);
            if (attempt.current?.value !== value) attempt.current = { value, key: uuid() };
            const key = attempt.current.key;
            void action.run(async () => {
              const saved = edit === 'new'
                ? await api<SavedSearch>(path, { method: 'POST', key, body: {
                  id: key, name, ...conditions, collection_id: filters.collection,
                  ...(filters.conditions && { conditions: filters.conditions }),
                } })
                : await api<SavedSearch>(`${path}/${edit.id}`, { method: 'PATCH', key, version: edit.version, body: { name, ...conditions } });
              setSelected(saved.id);
              setEdit(undefined);
              attempt.current = null;
            });
          }}>
            <Field label="Search name">
              <input name="name" maxLength={120} required defaultValue={edit === 'new' ? undefined : edit.name} />
            </Field>
            {edit === 'new' ? <p className="muted">Results update as your library changes.</p> : (
              <>
                <Field label="Search text"><input name="query" defaultValue={edit.query} maxLength={300} /></Field>
                <Field label="Tag"><input name="tag" defaultValue={edit.tag} maxLength={64} /></Field>
              </>
            )}
            {action.error && <Notice tone="error">{action.error}</Notice>}
            <div className="modal-footer">
              <button className="button primary" type="submit" disabled={action.busy}>Save search</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
