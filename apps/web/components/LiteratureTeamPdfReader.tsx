'use client';

import { useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { loadLiteraturePdfDownload } from '../lib/literature-pdfs';
import type { Page } from '../lib/types';
import { LiteraturePdfReader, type LiteraturePdfHighlight, type LiteraturePdfSelection } from './LiteraturePdfReader';
import { ErrorState, Field, Loading, Notice } from './ui';
import styles from './LiteraturePdfReader.module.css';

const colors = { yellow: '#f6ce45', green: '#70d68b', blue: '#73b9ff', pink: '#ff98ba', purple: '#ba9af5' };
type Color = keyof typeof colors;
type Kind = NonNullable<LiteraturePdfHighlight['kind']>;
type Annotation = LiteraturePdfSelection & {
  id: string; kind: Kind; color: Color; comment: string | null; tags: string[]; version: string;
  created_by: string; created_by_name: string;
};
type Draft = LiteraturePdfSelection & {
  id: string; kind: Kind; color: Color; comment: string; labels: string; version?: string;
};
const labels: Record<Kind, string> = { highlight: 'Highlight', underline: 'Underline', note: 'Page note', area: 'Area', ink: 'Ink' };

export function LiteratureTeamPdfReader({ attachmentPath, fileName, role, userId, onClose }: {
  attachmentPath: string; fileName: string; role: 'admin' | 'editor' | 'reader'; userId?: string; onClose: () => void;
}) {
  const path = `${attachmentPath}/annotations`;
  const [page, setPage] = useState(1);
  const [more, setMore] = useState<{ page: number; data: Page<Annotation> }>();
  const [active, setActive] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [remove, setRemove] = useState<Annotation>();
  const annotations = useResource<Page<Annotation>>(`${path}?page=${page}&limit=50`);
  const action = useAction(() => { setMore(undefined); annotations.reload(); });
  const paging = useAction();
  const currentMore = more?.page === page ? more.data : undefined;
  const items = annotations.error ? [] : [...(annotations.data?.items ?? []), ...(currentMore?.items ?? [])].filter((item) => item.page === page);
  const next = annotations.error ? null : currentMore ? currentMore.next_cursor : annotations.data?.next_cursor;
  const canAdd = role !== 'reader';
  const canManage = (item: Annotation) => role === 'admin' || (role === 'editor' && userId === item.created_by);

  function start(kind: Kind, selection: LiteraturePdfSelection) {
    if (action.busy) return;
    action.setError(null);
    setRemove(undefined);
    setActive(undefined);
    setDraft({ ...selection, id: uuid(), kind, color: 'yellow', comment: '', labels: '' });
  }

  function open(item: Annotation, edit: boolean) {
    setActive(item.id);
    if (!edit || !canManage(item) || action.busy) return;
    action.setError(null);
    setRemove(undefined);
    setDraft({ ...item, comment: item.comment ?? '', labels: item.tags.join('; ') });
  }

  return <LiteraturePdfReader title={fileName} onClose={() => { if (!action.busy) onClose(); }}
    load={(signal) => loadLiteraturePdfDownload(`/api/v1${attachmentPath}/download`, signal)}
    onPageChange={(value) => { setPage(value); setActive(undefined); }} onSelection={canAdd ? (value) => start('highlight', value) : undefined}
    onAddNote={canAdd ? (value) => start('note', value) : undefined}
    onAddArea={canAdd ? (value) => start('area', value) : undefined}
    onAddInk={canAdd ? (value) => start('ink', value) : undefined}
    pendingInk={!draft?.version && draft?.ink_path ? draft : undefined}
    activeAnnotation={active}
    onOpenNote={(id) => { const item = items.find((value) => value.id === id); if (item) open(item, true); }}
    highlights={items.map((item) => ({ ...item, color: colors[item.color] }))}
    sidePanel={<section aria-label="Shared PDF annotations">
      <h3>Shared annotations</h3>
      <p className="muted small-text">Page {page}</p>
      <ErrorState error={annotations.error} retry={annotations.reload} />
      {annotations.loading && <Loading />}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {draft && <form onSubmit={(event) => {
        event.preventDefault();
        if (action.busy) return;
        void action.run(async () => {
          const tags = draft.labels.split(';').map((tag) => tag.trim()).filter(Boolean);
          if (tags.length > 20 || tags.some((tag) => tag.length > 64)) throw new Error('Use up to 20 tags of up to 64 characters.');
          const fields = { kind: draft.kind, color: draft.color, comment: draft.comment, tags };
          if (draft.version) await api(`${path}/${draft.id}`, { method: 'PATCH', version: draft.version, body: fields });
          else await api(path, { method: 'POST', body: { ...fields, id: draft.id, page: draft.page, text: draft.text,
            rects: draft.rects, ...(draft.ink_path && { ink_path: draft.ink_path }) } });
          setActive(draft.id);
          setDraft(undefined);
        });
      }}>
        <p className="muted small-text">{labels[draft.kind]} · Page {draft.page}</p>
        {draft.text && <blockquote>{draft.text}</blockquote>}
        {(draft.kind === 'highlight' || draft.kind === 'underline') && <Field label="Mark">
          <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Kind })}>
            <option value="highlight">Highlight</option><option value="underline">Underline</option>
          </select>
        </Field>}
        <Field label="Color"><select value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value as Color })}>
          {Object.keys(colors).map((color) => <option key={color}>{color}</option>)}
        </select></Field>
        <Field label="Comment"><textarea rows={3} value={draft.comment} maxLength={12000} required={draft.kind === 'note'}
          onChange={(event) => setDraft({ ...draft, comment: event.target.value })} /></Field>
        <Field label="Annotation tags" hint="Separate tags with semicolons."><input value={draft.labels} maxLength={1320}
          onChange={(event) => setDraft({ ...draft, labels: event.target.value })} /></Field>
        <div className="inline-actions">
          <button className="button small" type="button" disabled={action.busy} onClick={() => setDraft(undefined)}>Cancel</button>
          <button className="button small primary" type="submit" disabled={action.busy || (draft.kind === 'note' && !draft.comment.trim())}>
            Save shared annotation
          </button>
        </div>
      </form>}
      {!items.length && !annotations.loading && !annotations.error && !draft && <p className="muted">No shared annotations on this page.</p>}
      <ul className={styles.annotationList}>{items.map((item) => <li key={item.id} aria-current={active === item.id ? 'location' : undefined}>
        <button className="text-link" type="button" onClick={() => open(item, false)}>{labels[item.kind]}</button>
        <p className="muted small-text">Added by {item.created_by_name}</p>
        {item.text && <blockquote>{item.text}</blockquote>}
        {item.comment && <p>{item.comment}</p>}
        {!!item.tags.length && <p className="muted small-text">{item.tags.join(' · ')}</p>}
        {canManage(item) && <div className="inline-actions">
          <button className="button small" type="button" disabled={action.busy} onClick={() => open(item, true)}>Edit annotation</button>
          {remove?.id === item.id ? <>
            <button className="button small" type="button" disabled={action.busy} onClick={() => setRemove(undefined)}>Cancel removal</button>
            <button className="button small danger" type="button" disabled={action.busy} onClick={() => void action.run(async () => {
              await api(`${path}/${item.id}`, { method: 'DELETE', version: item.version });
              setRemove(undefined);
              if (draft?.id === item.id) setDraft(undefined);
            })}>Confirm annotation removal</button>
          </> : <button className="button small" type="button" disabled={action.busy} onClick={() => setRemove(item)}>Remove annotation</button>}
        </div>}
      </li>)}</ul>
      {paging.error && <Notice tone="error">{paging.error}</Notice>}
      {next && <button className="button small" type="button" disabled={annotations.loading || paging.busy || action.busy}
        onClick={() => void paging.run(async () => {
          const data = await api<Page<Annotation>>(`${path}?page=${page}&limit=50&cursor=${encodeURIComponent(next)}`);
          setMore({ page, data: { ...data, items: [...(currentMore?.items ?? []), ...data.items] } });
        })}>Load more annotations</button>}
    </section>}
  />;
}
