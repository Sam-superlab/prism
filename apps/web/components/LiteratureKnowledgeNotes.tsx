'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Page } from '../lib/types';
import { MarkdownEditor } from './MarkdownEditor';
import { ErrorState, Field, Loading, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type Knowledge = { id: string; title: string; type: string; subject?: string | null };
type KnowledgeLink = { id: string; version: string; knowledge_item_id: string; title: string; type: string; subject?: string | null };

export function LiteratureKnowledgeNotes({ id }: { id: string }) {
  const path = `/research/references/${id}`;
  const [mode, setMode] = useState<'create' | 'link'>();
  const [selection, setSelection] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [content, setContent] = useState('');
  const [draftIds, setDraftIds] = useState(() => ({ id: uuid(), link_id: uuid() }));
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const links = useResource<Page<KnowledgeLink>>(`${path}/knowledge-links?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  const notes = useResource<Page<Knowledge>>(mode === 'link' ? `/knowledge-items?limit=25&q=${encodeURIComponent(query)}` : null);
  const action = useAction(links.reload);
  const linked = new Set(links.data?.items.map((item) => item.knowledge_item_id));
  const candidates = notes.data?.items.filter((item) => !linked.has(item.id)) ?? [];

  function closeForm() {
    setMode(undefined);
    setSelection('');
    setSearch('');
    setQuery('');
    setContent('');
    action.setError(null);
  }

  return <section aria-label="Reference notes" className={styles.referenceNotes}>
    <h3>Notes</h3>
    <div className={styles.inlineActions}>
      <button type="button" className="button small" disabled={action.busy || mode === 'create'} onClick={() => {
        closeForm();
        setDraftIds({ id: uuid(), link_id: uuid() });
        setMode('create');
      }}>New note</button>
      <button type="button" className="button small" disabled={action.busy || mode === 'link'} onClick={() => {
        closeForm();
        setDraftIds({ id: uuid(), link_id: uuid() });
        setMode('link');
      }}>Link a Knowledge item</button>
    </div>
    {mode === 'create' && <form onSubmit={(event) => {
      event.preventDefault();
      const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
      if (!title || !content.trim()) return;
      void action.run(async () => {
        await api(`${path}/notes`, { method: 'POST', body: { ...draftIds, title, content: content.trim() } });
        setCursors([]);
        closeForm();
      });
    }}>
      <Field label="Note title"><input name="title" required maxLength={300} autoFocus /></Field>
      <MarkdownEditor label="Note" rows={5} value={content} onChange={setContent} required />
      <div className={styles.inlineActions}>
        <button type="button" className="button small" disabled={action.busy} onClick={closeForm}>Cancel</button>
        <button type="submit" className="button small primary" disabled={action.busy || !content.trim()}>Save note</button>
      </div>
    </form>}
    {mode === 'link' && <>
      <form className={styles.inlineActions} onSubmit={(event) => {
        event.preventDefault();
        setSelection('');
        setQuery(search.trim());
      }}>
        <input aria-label="Search Knowledge" type="search" value={search} maxLength={200} autoFocus
          onChange={(event) => setSearch(event.target.value)} />
        <button className="button small" type="submit">Search</button>
      </form>
      <ErrorState error={notes.error} retry={notes.reload} />
      {notes.loading && <Loading />}
      {candidates.length > 0 && <Field label="Knowledge item">
        <select value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="">Choose an item</option>
          {candidates.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
        </select>
      </Field>}
      {!notes.loading && !notes.error && !candidates.length && <p className="muted small-text">No available Knowledge items. Try another search.</p>}
      <div className={styles.inlineActions}>
        <button type="button" className="button small" disabled={action.busy} onClick={closeForm}>Cancel</button>
        <button type="button" className="button small primary" disabled={action.busy || !selection} onClick={() => void action.run(async () => {
          await api(`${path}/knowledge-links`, { method: 'POST', body: { id: draftIds.link_id, knowledge_item_id: selection } });
          setCursors([]);
          closeForm();
        })}>Link item</button>
      </div>
    </>}
    {action.error && <Notice tone="error">{action.error}</Notice>}
    <ErrorState error={links.error} retry={links.reload} />
    {links.loading && <Loading />}
    {!links.loading && links.data?.items.length === 0 && <p className="muted small-text">No notes linked.</p>}
    <ul className={styles.rows}>
      {links.data?.items.map((link) => <li key={link.id} className={styles.row}>
        <Link href={`/knowledge/${link.knowledge_item_id}`} className="text-link">{link.title}</Link>
        <button type="button" className="button small" disabled={action.busy} aria-label={`Unlink ${link.title}`}
          onClick={() => void action.run(() => api(`/research/reference-knowledge-links/${link.id}`, { method: 'DELETE', version: link.version }))}>
          Unlink
        </button>
      </li>)}
    </ul>
    {(cursor || links.data?.next_cursor) && <div className={styles.pagination}>
      <button type="button" className="button small" disabled={!cursor} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous notes</button>
      <button type="button" className="button small" disabled={!links.data?.next_cursor} onClick={() => {
        const next = links.data?.next_cursor;
        if (next) setCursors((current) => [...current, next]);
      }}>Next notes</button>
    </div>}
  </section>;
}
