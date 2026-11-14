'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, useAction, useResource, uuid } from '../lib/api';
import { annotationNoteMarkdown, literaturePdfHref } from '../lib/literature-pdf-notes';
import type { LiteratureAttachmentFormat } from '../lib/literature-pdfs';
import type { Page } from '../lib/types';
import { ErrorState, Field, Loading, Modal, Notice } from './ui';
import { MarkdownEditor } from './MarkdownEditor';
import styles from './ResearchReferences.module.css';

const locationLabels = { pdf: 'Page', epub: 'Chapter', webpage: 'Paragraph' } as const;
const colors = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', purple: 'Purple' } as const;
type Color = keyof typeof colors;
type Annotation = {
  id: string; attachment_id: string; reference_id: string; title: string; file_name: string;
  page: number; format: LiteratureAttachmentFormat; kind: string; quote: string; comment: string; color: Color; tags: string[];
};
type Note = { id: string; title: string; content: string };
type ColorHeadings = Partial<Record<Color, string>>;

function readHeadings(key: string): ColorHeadings {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}') as ColorHeadings;
    return Object.fromEntries(Object.keys(colors).flatMap((name) => {
      const value = stored[name as Color];
      return typeof value === 'string' ? [[name, value.slice(0, 80)]] : [];
    }));
  } catch { return {}; }
}

function sourceHref(item: Annotation) {
  return literaturePdfHref(item.reference_id, item.attachment_id, item.page, item.id);
}

export function LiteratureAnnotationBrowser({ userId, onClose }: { userId?: string; onClose: () => void }) {
  const [filters, setFilters] = useState({ q: '', tag: '', color: '' });
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Map<string, Annotation>>(new Map());
  const [includeQuote, setIncludeQuote] = useState(true);
  const [includeComment, setIncludeComment] = useState(true);
  const [includeAreaImages, setIncludeAreaImages] = useState(true);
  const [groupByColor, setGroupByColor] = useState(false);
  const [headings, setHeadings] = useState<ColorHeadings>({});
  const [draft, setDraft] = useState<Note>();
  const [saved, setSaved] = useState<string>();
  const [notice, setNotice] = useState('');
  const params = new URLSearchParams({ limit: '25' });
  for (const [name, value] of Object.entries(filters)) if (value) params.set(name, value);
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const result = useResource<Page<Annotation>>(`/research/library/annotations?${params}`);
  const save = useAction();
  const hasAreaSelection = [...selected.values()].some(({ kind }) => kind === 'area');
  const headingKey = userId ? `prism.literature.annotation-headings.v1.${userId}` : null;
  useEffect(() => { setHeadings(headingKey ? readHeadings(headingKey) : {}); }, [headingKey]);

  function prepare() {
    const groups = new Map<string, string[]>();
    let count = 0;
    let length = 0;
    for (const item of selected.values()) {
      const group = groupByColor ? (headings[item.color]?.trim() || colors[item.color]).replace(/([\\`*_[\]<>$])/g, '\\$1') : '';
      const chunk = annotationNoteMarkdown(item.title, { id: item.attachment_id, reference_id: item.reference_id },
        [{ id: item.id, page: item.page, kind: item.kind, text: item.quote, comment: item.comment }],
        { includeQuote, includeComment, includeAreaImages, locationLabel: locationLabels[item.format] });
      if (!chunk) continue;
      if (length + chunk.length + group.length + 24 > 64_000) break;
      const entries = groups.get(group);
      if (entries) entries.push(chunk);
      else groups.set(group, [chunk]);
      length += chunk.length + group.length + 24;
      count++;
    }
    if (!count) { setNotice('No selected annotations have content for this draft.'); return; }
    const content = [...groups.entries()].map(([label, entries]) => label
      ? `## ${label}\n\n${entries.join('\n\n')}` : entries.join('\n\n')).join('\n\n');
    setNotice(count < selected.size ? `The draft includes ${count} of ${selected.size} selected annotations.` : '');
    setSaved(undefined); save.setError(null);
    setDraft({ id: uuid(), title: 'Literature reading notes', content });
  }

  return <Modal title="Library annotations" wide onClose={() => { if (!save.busy) onClose(); }}>
    <form className={styles.toolbar} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const read = (name: string) => String(data.get(name) ?? '').trim();
      setCursors([]); setFilters({ q: read('q'), tag: read('tag'), color: read('color') });
    }}>
      <input className={styles.search} type="search" aria-label="Search annotations" name="q" placeholder="Quote or comment" maxLength={200} />
      <input type="search" aria-label="Filter by annotation tag" name="tag" placeholder="Annotation tag" maxLength={64} />
      <label>Color <select name="color" aria-label="Filter by annotation color">
        <option value="">All colors</option>
        {Object.entries(colors).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="submit" className="button small">Filter</button>
    </form>
    <ErrorState error={result.error} retry={result.reload} />
    {result.loading && <Loading />}
    {!result.loading && !result.error && !result.data?.items.length && <p className="muted">No annotations match these filters.</p>}
    <ul className={styles.rows}>{!result.error && result.data?.items.map((item) => <li className={styles.row} key={item.id}>
      <div>
        <label className="check-label"><input type="checkbox" checked={selected.has(item.id)} disabled={!!draft || result.loading}
          onChange={(event) => {
            const checked = event.target.checked;
            if (checked && selected.size >= 50) { setNotice('Select up to 50 annotations per note.'); return; }
            setNotice(''); setSelected((old) => {
              const next = new Map(old);
              if (checked) next.set(item.id, item);
              else next.delete(item.id);
              return next;
            });
          }} /> Include annotation</label>
        <Link href={sourceHref(item)} className={`text-link ${styles.rowTitle}`} onClick={onClose}>
          {item.title} · {locationLabels[item.format]} {item.page}
        </Link>
        <p className="muted small-text">{[item.file_name, colors[item.color], ...item.tags].join(' · ')}</p>
        {item.quote && <blockquote>{item.quote}</blockquote>}
        {item.comment && <p>{item.comment}</p>}
        {item.kind === 'area' && <p className="muted small-text">Marked PDF area</p>}
      </div>
    </li>)}</ul>
    {(cursors.length > 0 || result.data?.next_cursor) && <div className={styles.pagination}>
      <button type="button" className="button small" disabled={!cursors.length || result.loading}
        onClick={() => setCursors((old) => old.slice(0, -1))}>Previous page</button>
      <button type="button" className="button small" disabled={!result.data?.next_cursor || result.loading}
        onClick={() => { if (result.data?.next_cursor) setCursors((old) => [...old, result.data!.next_cursor!]); }}>Next page</button>
    </div>}
    {notice && <Notice>{notice}</Notice>}
    {saved && <Link className="text-link" href={`/knowledge/${saved}`} onClick={onClose}>Open saved note</Link>}
    {!draft && <div className={styles.inlineActions}>
      <label className="check-label"><input type="checkbox" checked={includeQuote} onChange={(event) => setIncludeQuote(event.target.checked)} />Include quotes</label>
      <label className="check-label"><input type="checkbox" checked={includeComment} onChange={(event) => setIncludeComment(event.target.checked)} />Include comments</label>
      {hasAreaSelection && <label className="check-label">
        <input type="checkbox" checked={includeAreaImages} onChange={(event) => setIncludeAreaImages(event.target.checked)} />Include PDF area images
      </label>}
      <label className="check-label"><input type="checkbox" checked={groupByColor} onChange={(event) => setGroupByColor(event.target.checked)} />Group by color</label>
      <button type="button" className="button small primary" disabled={!selected.size || (!includeQuote && !includeComment &&
        (!includeAreaImages || !hasAreaSelection))} onClick={prepare}>
        Draft knowledge note ({selected.size})
      </button>
      {!!selected.size && <button type="button" className="button small" onClick={() => { setSelected(new Map()); setNotice(''); }}>Clear selection</button>}
    </div>}
    {!draft && groupByColor && <details>
      <summary>Customize color headings</summary>
      <div className="form-grid">{Object.entries(colors).map(([name, label]) => {
        const color = name as Color;
        return <Field key={color} label={`${label} heading`}><input maxLength={80} placeholder={label} value={headings[color] ?? ''}
          onChange={(event) => {
            const next = { ...headings, [color]: event.target.value };
            setHeadings(next);
            if (headingKey) try { localStorage.setItem(headingKey, JSON.stringify(next)); } catch {}
          }} /></Field>;
      })}</div>
    </details>}
    {draft && <form onSubmit={(event) => {
      event.preventDefault();
      if (save.busy || !draft.title.trim() || !draft.content.trim()) return;
      void save.run(async () => {
        await api('/knowledge-items', { method: 'POST', key: draft.id, body: { ...draft, title: draft.title.trim(), type: 'note' } });
        setSaved(draft.id); setDraft(undefined); setSelected(new Map()); setNotice('');
      });
    }}>
      <Field label="Note title"><input required maxLength={300} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
      <MarkdownEditor label="Note Markdown" rows={8} maxLength={64_000} value={draft.content} onChange={(content) => setDraft({ ...draft, content })} />
      {save.error && <Notice tone="error">{save.error}</Notice>}
      <div className={styles.inlineActions}>
        <button type="button" className="button small" disabled={save.busy} onClick={() => setDraft(undefined)}>Cancel draft</button>
        <button type="submit" className="button small primary" disabled={save.busy || !draft.title.trim() || !draft.content.trim()}>Save knowledge note</button>
      </div>
    </form>}
  </Modal>;
}
