'use client';

import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { annotationNoteMarkdown, literaturePdfHref } from '../lib/literature-pdf-notes';
import type { Page } from '../lib/types';
import { MarkdownEditor } from './MarkdownEditor';
import { ErrorState, Field, Loading, Notice } from './ui';
import styles from './LiteraturePdfReader.module.css';

const colors = { yellow: '#f6ce45', green: '#70d68b', blue: '#73b9ff', pink: '#ff98ba', purple: '#ba9af5' };
type Color = keyof typeof colors;
type Anchor = { section: number; section_key: string | null; block: number; start: number; end: number; quote: string };
type Annotation = { id: string; attachment_id: string; anchor: Anchor; color: Color; comment: string; tags: string[]; version: string };
type Draft = { id: string; anchor: Anchor; color: Color; comment: string; tags: string; version?: string };
type Section = { section: number; key: string | null; block: number; text: string };

function rangeAt(root: HTMLElement, selection: Selection | null, sections: Map<string, Section>): Anchor | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const getBlock = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
    ?.closest<HTMLElement>('[data-text-anchor]');
  const block = getBlock(range.startContainer);
  if (!block || block !== getBlock(range.endContainer) || !root.contains(block)) return;
  const source = sections.get(block.dataset.textAnchor ?? '');
  if (!source || (source.key?.length ?? 0) > 512) return;
  const leading = range.cloneRange();
  leading.selectNodeContents(block);
  leading.setEnd(range.startContainer, range.startOffset);
  const start = leading.toString().length;
  const quote = range.toString();
  const end = start + quote.length;
  if (!quote.trim() || quote.length > 4_000 || source.text.slice(start, end) !== quote) return;
  return { section: source.section, section_key: source.key, block: source.block, start, end, quote };
}

function matches(anchor: Anchor, source?: Section) {
  return source?.key === anchor.section_key && source?.text.slice(anchor.start, anchor.end) === anchor.quote;
}

export function useLiteratureTextAnnotations({ attachmentId, referenceId, fileName, sections, section, root, annotationId, onJump }: {
  attachmentId: string; referenceId: string; fileName: string; sections: readonly Section[]; section?: number; root: RefObject<HTMLElement | null>;
  annotationId?: string; onJump: (section: number) => void;
}) {
  const path = `/research/attachments/${attachmentId}/text-annotations`;
  const page = useResource<Page<Annotation>>(`${path}?limit=100${section ? `&section=${section}` : ''}`);
  const target = useResource<Annotation>(annotationId ? `/research/text-annotations/${annotationId}` : null);
  const [draft, setDraft] = useState<Draft>();
  const [active, setActive] = useState(annotationId);
  const [removing, setRemoving] = useState<string>();
  const [selectionError, setSelectionError] = useState('');
  const [more, setMore] = useState<{ section?: number; data: Page<Annotation> }>();
  const [note, setNote] = useState<{ id: string; linkId: string; title: string; content: string; source: string }>();
  const [savedNote, setSavedNote] = useState<string>();
  const action = useAction(() => { setMore(undefined); page.reload(); if (annotationId) target.reload(); });
  const paging = useAction();
  const noteAction = useAction();
  const nextPage = more?.section === section ? more?.data : undefined;
  const nextCursor = nextPage ? nextPage.next_cursor : page.data?.next_cursor;
  const items = useMemo(() => {
    const current = page.error ? [] : [...(page.data?.items ?? []), ...(nextPage?.items ?? [])];
    if (target.data?.attachment_id === attachmentId && target.data.id === annotationId && !target.error && !current.some((item) => item.id === target.data?.id))
      current.unshift(target.data);
    return current.filter((item) => !section || item.anchor.section === section);
  }, [annotationId, attachmentId, nextPage?.items, page.data?.items, page.error, section, target.data, target.error]);
  const sources = useMemo(() => new Map(sections.map((item) => [`${item.section}:${item.block}`, item])), [sections]);
  const anchored = useMemo(() => {
    const byBlock = new Map<string, Annotation[]>();
    for (const item of items) {
      const key = `${item.anchor.section}:${item.anchor.block}`;
      if (!matches(item.anchor, sources.get(key))) continue;
      const list = byBlock.get(key);
      if (list) list.push(item);
      else byBlock.set(key, [item]);
    }
    return byBlock;
  }, [items, sources]);

  useEffect(() => { setActive(annotationId); }, [annotationId]);
  useEffect(() => {
    if (!active || !items.some((item) => item.id === active)) return;
    root.current?.querySelector<HTMLElement>('[data-active-text-mark="true"]')?.scrollIntoView({ block: 'center' });
  }, [active, items, root, sources]);

  function capture() {
    const anchor = root.current && rangeAt(root.current, window.getSelection(), sources);
    if (!anchor) {
      setSelectionError('Select up to 4,000 characters within one text block.');
      return;
    }
    setSelectionError('');
    setRemoving(undefined);
    action.setError(null);
    setDraft({ id: uuid(), anchor, color: 'yellow', comment: '', tags: '' });
    window.getSelection()?.removeAllRanges();
  }

  function paint(sectionNumber: number, block: number, text: string): ReactNode {
    const key = `${sectionNumber}:${block}`;
    const marks = anchored.get(key);
    if (!marks?.length) return text;
    const edges = [...new Set([0, text.length, ...marks.flatMap(({ anchor }) => [anchor.start, anchor.end])])].sort((a, b) => a - b);
    return edges.slice(0, -1).map((start, index) => {
      const end = edges[index + 1];
      const covering = marks.filter(({ anchor }) => anchor.start <= start && anchor.end >= end);
      const top = covering.find((mark) => mark.id === active) ?? covering.at(-1);
      const value = text.slice(start, end);
      return top ? <mark key={start} data-active-text-mark={top.id === active || undefined}
        style={{ backgroundColor: `color-mix(in srgb, ${colors[top.color]} 46%, transparent)` }} className={styles.textAnchorMark}>{value}</mark> : value;
    });
  }

  return { paint,
    trigger: <button className="button small" type="button" disabled={action.busy} onMouseDown={(event) => event.preventDefault()} onClick={capture}>
      Annotate selection
    </button>,
    panel: <section aria-label="Text annotations">
      <h3>Annotations</h3>
      {page.loading && <Loading />}
      <ErrorState error={page.error} retry={page.reload} />
      {target.error && <Notice tone="error">Could not open this annotation.</Notice>}
      {selectionError && <p role="status" className="muted small-text">{selectionError}</p>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {!!items.length && !note && <button className="button small" type="button" onClick={() => {
        const file = { id: attachmentId, reference_id: referenceId };
        const entries = items.map((item) => ({ ...item, page: item.anchor.section, text: item.anchor.quote }))
          .sort((a, b) => a.page - b.page || a.anchor.block - b.anchor.block || a.anchor.start - b.anchor.start);
        const options = { locationLabel: section ? 'Chapter' as const : 'Paragraph' as const };
        const chunks: string[] = [];
        let length = 0;
        for (const entry of entries) {
          const chunk = annotationNoteMarkdown(fileName, file, [entry], options);
          if (length + chunk.length + 2 > 64_000) break;
          chunks.push(chunk); length += chunk.length + 2;
        }
        noteAction.setError(null); setSavedNote(undefined);
        setNote({ id: uuid(), linkId: uuid(), title: `${fileName} — Reading notes`.slice(0, 300),
          content: chunks.join('\n\n'),
          source: literaturePdfHref(referenceId, attachmentId, entries[0].page, entries[0].id) });
        if (chunks.length < entries.length) noteAction.setError(`This draft includes ${chunks.length} of ${entries.length} loaded annotations.`);
      }}>Create note from annotations</button>}
      {savedNote && <a className="text-link" href={`/knowledge/${savedNote}`}>Open saved note</a>}
      {note && <form onSubmit={(event) => {
        event.preventDefault();
        if (noteAction.busy || !note.title.trim() || !note.content.trim()) return;
        void noteAction.run(async () => {
          await api(`/research/references/${referenceId}/notes`, { method: 'POST', key: note.id, body: {
            id: note.id, link_id: note.linkId, title: note.title.trim(), content: note.content, source_reference: note.source,
          } });
          setSavedNote(note.id); setNote(undefined);
        });
      }}>
        <Field label="Note title"><input required maxLength={300} value={note.title} onChange={(event) => setNote({ ...note, title: event.target.value })} /></Field>
        <MarkdownEditor label="Note Markdown" rows={5} maxLength={64_000} value={note.content} onChange={(content) => setNote({ ...note, content })} />
        {noteAction.error && <Notice tone="error">{noteAction.error}</Notice>}
        <div className="inline-actions">
          <button className="button small" type="button" disabled={noteAction.busy} onClick={() => setNote(undefined)}>Cancel note</button>
          <button className="button small primary" type="submit" disabled={noteAction.busy || !note.title.trim() || !note.content.trim()}>Save knowledge note</button>
        </div>
      </form>}
      {draft && <form onSubmit={(event) => {
        event.preventDefault();
        if (action.busy) return;
        void action.run(async () => {
          const tags = draft.tags.split(';').map((tag) => tag.trim()).filter(Boolean);
          if (tags.length > 20 || tags.some((tag) => tag.length > 64)) throw new Error('Use up to 20 tags of up to 64 characters.');
          const values = { color: draft.color, comment: draft.comment, tags };
          if (draft.version) await api(`/research/text-annotations/${draft.id}`, { method: 'PATCH', version: draft.version, body: values });
          else await api(path, { method: 'POST', key: draft.id, body: { ...values, id: draft.id, anchor: draft.anchor } });
          setActive(draft.id); setDraft(undefined);
        });
      }}>
        <blockquote>{draft.anchor.quote}</blockquote>
        <Field label="Annotation color"><select value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value as Color })}>
          {Object.keys(colors).map((color) => <option key={color}>{color}</option>)}
        </select></Field>
        <Field label="Annotation comment"><textarea rows={3} value={draft.comment} maxLength={12_000}
          onChange={(event) => setDraft({ ...draft, comment: event.target.value })} /></Field>
        <Field label="Annotation tags" hint="Separate tags with semicolons."><input value={draft.tags} maxLength={1320}
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></Field>
        <div className="inline-actions">
          <button className="button small" type="button" disabled={action.busy} onClick={() => setDraft(undefined)}>Cancel</button>
          <button className="button small primary" type="submit" disabled={action.busy}>Save annotation</button>
        </div>
      </form>}
      {!items.length && !page.loading && !page.error && !draft && <p className="muted small-text">No annotations here.</p>}
      <ul className={styles.annotationList}>{items.map((item) => <li key={item.id} aria-current={active === item.id ? 'location' : undefined}>
        <button className="text-link" type="button" onClick={() => { setActive(item.id); onJump(item.anchor.section); }}>
          Section {item.anchor.section}
        </button>
        <blockquote>{item.anchor.quote}</blockquote>
        {item.comment && <p>{item.comment}</p>}
        {!!item.tags?.length && <p className="muted small-text">{item.tags.join(' · ')}</p>}
        {!matches(item.anchor, sources.get(`${item.anchor.section}:${item.anchor.block}`)) && <p className="muted small-text">
          The original text location could not be confirmed.
        </p>}
        <div className="inline-actions">
          <button className="button small" type="button" disabled={action.busy} onClick={() => {
            setRemoving(undefined); action.setError(null); setDraft({ ...item, tags: item.tags.join('; ') });
          }}>Edit annotation</button>
          {removing === item.id ? <>
            <button className="button small" type="button" disabled={action.busy} onClick={() => setRemoving(undefined)}>Cancel removal</button>
            <button className="button small danger" type="button" disabled={action.busy} onClick={() => void action.run(async () => {
              await api(`/research/text-annotations/${item.id}`, { method: 'DELETE', version: item.version });
              setRemoving(undefined);
              if (draft?.id === item.id) setDraft(undefined);
            })}>Confirm annotation removal</button>
          </> : <button className="button small" type="button" disabled={action.busy} onClick={() => setRemoving(item.id)}>Remove annotation</button>}
        </div>
      </li>)}</ul>
      {paging.error && <Notice tone="error">{paging.error}</Notice>}
      {nextCursor && <button className="button small" type="button" disabled={page.loading || paging.busy || action.busy}
        onClick={() => void paging.run(async () => {
          const data = await api<Page<Annotation>>(`${path}?limit=100${section ? `&section=${section}` : ''}&cursor=${encodeURIComponent(nextCursor)}`);
          setMore({ section, data: { ...data, items: [...(nextPage?.items ?? []), ...data.items] } });
        })}>Load more annotations</button>}
    </section>,
  };
}
