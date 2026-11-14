'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import { annotationNoteMarkdown, annotationNoteTemplates, literaturePdfHref, orderedAnnotationNoteEntries } from '../lib/literature-pdf-notes';
import { literaturePdfPath, loadLiteraturePdf, type LiteraturePdf } from '../lib/literature-pdfs';
import type { LiteraturePdfIndex } from '../lib/literature-pdf-index';
import { useLiteratureReadingPosition } from '../lib/literature-reading-position';
import { canRecognizeLiteraturePdfScans } from '../lib/literature-pdf-ocr';
import { pdfAnnotationColors as colors } from '../lib/literature-embedded-pdf-annotations';
import { LiteratureEmbeddedPdfAnnotations } from './LiteratureEmbeddedPdfAnnotations';
import { LiteraturePdfReader, type LiteraturePdfSelection } from './LiteraturePdfReader';
import { LiteratureResearchSource } from './LiteratureResearchSource';
import { MarkdownEditor } from './MarkdownEditor';
import { ErrorState, Field, Loading, Modal, Notice } from './ui';
import styles from './LiteraturePdfReader.module.css';

type Color = keyof typeof colors;
type Annotation = LiteraturePdfSelection & {
  id: string;
  kind: 'highlight' | 'underline' | 'note' | 'area' | 'ink';
  comment?: string | null;
  color: Color;
  tags?: string[];
  version: string;
};
export function LiteraturePdfAnnotations({ file, referenceTitle, startPage, onClose, inline, annotationId }: {
  file: LiteraturePdf; referenceTitle: string; startPage?: number; onClose: () => void; inline?: boolean;
  annotationId?: string;
}) {
  const path = `${literaturePdfPath(file.id)}/annotations`;
  const [items, setItems] = useState<Annotation[]>([]);
  const [showOriginal, setShowOriginal] = useState(true);
  const originalMarksKey = `prism.literature.pdf-original-marks.v1.${file.id}`;
  useEffect(() => {
    try { setShowOriginal(localStorage.getItem(originalMarksKey) !== 'hidden'); } catch {}
  }, [originalMarksKey]);
  function changeOriginalMarks(show: boolean) {
    setShowOriginal(show);
    try { localStorage.setItem(originalMarksKey, show ? 'shown' : 'hidden'); } catch {}
  }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    async function read() {
      const all: Annotation[] = [];
      const query = new URLSearchParams();
      while (true) {
        const batch = await api<{ items: Annotation[]; next_cursor: string | null }>(`${path}?${query}`,
          { signal: controller.signal });
        all.push(...batch.items);
        if (!batch.next_cursor) return all;
        query.set('cursor', batch.next_cursor);
      }
    }
    void read().then((data) => { if (!controller.signal.aborted) setItems(data); })
      .catch((error) => { if (!controller.signal.aborted) setLoadError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  const [pending, setPending] = useState<{ id: string; selection: LiteraturePdfSelection }>();
  const [kind, setKind] = useState<Annotation['kind']>('highlight');
  const [color, setColor] = useState<Color>('yellow');
  const [comment, setComment] = useState('');
  const [tags, setTags] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [edit, setEdit] = useState<Annotation>();
  const [requestedPage, setRequestedPage] = useState<number>();
  const [researchPage, setResearchPage] = useState<number>();
  const [jump, setJump] = useState(0);
  const [activeAnnotation, setActiveAnnotation] = useState(annotationId);
  const annotationList = useRef<HTMLUListElement>(null);
  const position = useLiteratureReadingPosition(`${literaturePdfPath(file.id)}/reading-position`,
    `prism.literature.pdf-page.v1.${file.id}`, startPage);
  const load = useCallback((signal: AbortSignal) => loadLiteraturePdf(file.id, signal), [file.id]);
  const action = useAction(reload);
  const highlights = useMemo(() => items.map((item) => ({ ...item, color: colors[item.color] })), [items]);
  const annotationIds = useMemo(() => new Set(items.map(({ id }) => id)), [items]);
  const [note, setNote] = useState<{
    id: string; link_id: string; title: string; content: string; page: number;
    template: keyof typeof annotationNoteTemplates; entries: Annotation[]; edited: boolean;
  }>();
  const [selectedMarks, setSelectedMarks] = useState<string[]>([]);
  const availableTags = [...new Set(items.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const visibleItems = filterTag ? items.filter((item) => item.tags?.includes(filterTag)) : items;
  const noteMarks = selectedMarks.length ? items.filter((item) => selectedMarks.includes(item.id)) : visibleItems;
  const [savedNote, setSavedNote] = useState<string>();
  useEffect(() => { setActiveAnnotation(annotationId); }, [annotationId]);
  useEffect(() => {
    if (!activeAnnotation || !items.some((item) => item.id === activeAnnotation)) return;
    const element = annotationList.current?.querySelector('[aria-current="location"]');
    element?.scrollIntoView({ block: 'nearest' });
  }, [items, activeAnnotation]);
  useEffect(() => {
    if (filterTag && !items.some((item) => item.tags?.includes(filterTag))) setFilterTag('');
  }, [filterTag, items]);
  const commentField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (kind !== 'highlight' && kind !== 'underline' && (pending || edit)) commentField.current?.focus();
  }, [kind, pending, edit]);
  const [indexProgress, setIndexProgress] = useState('');
  const index = useResource<LiteraturePdfIndex>(`${literaturePdfPath(file.id)}/text-index`);
  const indexController = useRef<AbortController>(null);
  const [scanOcrAvailable, setScanOcrAvailable] = useState(false);
  const noteAction = useAction();
  const exportAction = useAction();
  const indexAction = useAction();
  useEffect(() => { setScanOcrAvailable(canRecognizeLiteraturePdfScans()); }, []);
  useEffect(() => () => indexController.current?.abort(), []);
  async function buildIndex(recognizeScans = false) {
    const controller = new AbortController();
    indexController.current = controller;
    setIndexProgress('');
    try {
      const [{ indexLiteraturePdf }, { withLiteratureIndexLock }] = await Promise.all([
        import('../lib/literature-pdf-index'), import('../lib/literature-attachment-index'),
      ]);
      const indexed = await withLiteratureIndexLock(async () => {
        await indexLiteraturePdf(file.id, controller.signal, (page, total) => setIndexProgress(`${page}/${total} pages`), { recognizeScans });
        return true;
      });
      if (!indexed) throw new Error('Another attachment is being indexed. Try again after it finishes.');
      index.reload();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      index.reload();
    } finally {
      indexController.current = null;
    }
  }
  const pendingOcr = index.data?.status === 'indexing' && index.data.text_mode === 'local-ocr';
  const showOcr = scanOcrAvailable && (index.data?.status === 'missing' || pendingOcr ||
    (index.data?.status === 'ready' && index.data.text_mode !== 'local-ocr'));
  async function exportPdf() {
    const controller = new AbortController();
    const [{ exportAnnotatedLiteraturePdf }, bytes] = await Promise.all([
      import('../lib/literature-pdf-export'), load(controller.signal),
    ]);
    const annotated = await exportAnnotatedLiteraturePdf(bytes, highlights);
    const url = URL.createObjectURL(new Blob([Uint8Array.from(annotated)], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.file_name.replace(/\.pdf$/i, '') + '-annotated.pdf';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  if (position.initialPage === undefined) return <Modal title={file.file_name} onClose={onClose} wide inline={inline}><Loading /></Modal>;
  return <><LiteraturePdfReader key={file.id} title={file.file_name} load={load} initialPage={position.initialPage} inline={inline}
    modeStorageKey={`prism.literature.pdf-mode.v1.${file.id}`}
    activeAnnotation={activeAnnotation}
    showOriginalAnnotations={showOriginal}
    requestedPage={requestedPage === undefined ? undefined : { page: requestedPage, revision: jump }}
    onPageChange={position.onPageChange}
    onUseForResearch={setResearchPage}
    onSelection={(selection) => {
      if (action.busy) return;
      setEdit(undefined);
      if (kind !== 'highlight' && kind !== 'underline') setKind('highlight');
      setComment('');
      setTags('');
      setPending({ id: uuid(), selection });
    }}
    onAddNote={(selection) => {
      if (action.busy) return;
      setEdit(undefined);
      setKind('note');
      setComment('');
      setTags('');
      setPending({ id: uuid(), selection });
    }}
    onAddArea={(selection) => {
      if (action.busy) return;
      setEdit(undefined);
      setKind('area');
      setComment('');
      setTags('');
      setPending({ id: uuid(), selection });
    }}
    onAddInk={(selection) => {
      if (action.busy) return;
      setEdit(undefined);
      setKind('ink');
      setComment('');
      setTags('');
      setPending({ id: uuid(), selection });
    }}
    pendingInk={pending?.selection.ink_path ? pending.selection : undefined}
    onOpenNote={(id) => {
      const item = items.find((annotation) => annotation.id === id);
      if (item && !action.busy) {
        setPending(undefined);
        setEdit(item);
        setKind(item.kind);
        setColor(item.color);
        setComment(item.comment ?? '');
        setTags(item.tags?.join('; ') ?? '');
      }
    }}
    highlights={highlights}
    onClose={() => { if (!action.busy && !noteAction.busy && !exportAction.busy) onClose(); }}
    sidePanel={(pdf) => (
      <section aria-label="PDF annotations">
        <h3>Annotations</h3>
        {position.saveError && <Notice tone="error">{position.saveError}{' '}
          <button type="button" className="text-link" onClick={position.retry}>Sync this page</button>
          {position.syncConflict && <button type="button" className="text-link" onClick={() => void position.useSyncedPage((page) => {
            setRequestedPage(page);
            setJump((value) => value + 1);
          })}>Open synced page</button>}
        </Notice>}
        <div className="inline-actions">
          {!pendingOcr && <button className="button small" type="button" disabled={indexAction.busy || index.loading || index.data?.status === 'ready'}
            onClick={() => void indexAction.run(() => buildIndex())}>
            {index.data?.status === 'ready' ? 'Indexed' : index.data?.status === 'indexing' ? 'Resume text index' : 'Index PDF text'}
          </button>}
          {showOcr && <button className="button small" type="button" disabled={indexAction.busy || index.loading}
            onClick={() => void indexAction.run(() => buildIndex(true))}>{pendingOcr ? 'Resume scan recognition' : 'Index scanned pages'}</button>}
          {indexAction.busy && <button className="button small" type="button" onClick={() => indexController.current?.abort()}>Stop indexing</button>}
          <button className="button small" type="button" disabled={!items.length || loading || !!loadError || exportAction.busy}
            onClick={() => void exportAction.run(exportPdf)}>{exportAction.busy ? 'Exporting…' : 'Export annotated PDF'}</button>
          <button className="button small" type="button" disabled={!noteMarks.length || loading || !!loadError || noteAction.busy}
            onClick={() => {
              noteAction.setError(null);
              setNote({ id: uuid(), link_id: uuid(), title: `${referenceTitle} — Reading notes`.slice(0, 300),
                content: annotationNoteMarkdown(referenceTitle, file, noteMarks), page: noteMarks[0].page,
                template: 'standard', entries: noteMarks, edited: false });
            }}>Create note from annotations</button>
        </div>
        <LiteratureEmbeddedPdfAnnotations pdf={pdf} pdfId={file.id} path={path} existing={annotationIds}
          showOriginal={showOriginal} onShowOriginal={changeOriginalMarks} onImported={reload}
          onPage={(page) => { setRequestedPage(page); setJump((value) => value + 1); }} />
        {indexAction.busy && <p role="status" className="muted small-text">{indexProgress || 'Indexing…'}</p>}
        {!indexAction.busy && pendingOcr && !scanOcrAvailable && <p className="muted small-text">Resume scan recognition in PRISM for macOS.</p>}
        {showOcr && !indexAction.busy && <p className="muted small-text">Scan recognition runs on this Mac. Recognized text is added to your searchable workspace index.</p>}
        <ErrorState error={index.error} retry={index.reload} />
        {indexAction.error && <Notice tone="error">{indexAction.error}</Notice>}
        {exportAction.error && <Notice tone="error">{exportAction.error}</Notice>}
        {savedNote && <a className="text-link" href={`/knowledge/${savedNote}`}>Open saved note</a>}
        {note && (
          <form onSubmit={(event) => {
            event.preventDefault();
            void noteAction.run(async () => {
              await api(`/research/references/${file.reference_id}/notes`, { method: 'POST', body: {
                id: note.id, link_id: note.link_id, title: note.title, content: note.content,
                source_reference: literaturePdfHref(file.reference_id, file.id, note.page),
              } });
              setSavedNote(note.id);
              setNote(undefined);
            });
          }}>
            <Field label="Note title">
              <input required value={note.title} maxLength={300}
                onChange={(event) => setNote({ ...note, title: event.target.value })} />
            </Field>
            <Field label="Note template" hint={note.edited ? 'Start a new note to apply a different template.' : undefined}>
              <select value={note.template} disabled={note.edited || noteAction.busy} onChange={(event) => {
                const template = event.target.value as keyof typeof annotationNoteTemplates;
                const options = { template, order: 'page' as const };
                const [first] = orderedAnnotationNoteEntries(note.entries, options);
                setNote({ ...note, template, content: annotationNoteMarkdown(referenceTitle, file, note.entries, options),
                  page: first?.page ?? note.page });
              }}>
                {Object.entries(annotationNoteTemplates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <MarkdownEditor label="Note Markdown" rows={6} required value={note.content}
              onChange={(content) => setNote({ ...note, content, edited: true })} />
            {noteAction.error && <Notice tone="error">{noteAction.error}</Notice>}
            <div className="inline-actions">
              <button className="button small" type="button" disabled={noteAction.busy} onClick={() => setNote(undefined)}>Cancel note</button>
              <button className="button small primary" type="submit" disabled={noteAction.busy || !note.content.trim()}>Save knowledge note</button>
            </div>
          </form>
        )}
        <ErrorState error={loadError} retry={reload} />
        {loading && <Loading />}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {!!availableTags.length && <Field label="Filter annotations by tag">
          <select value={availableTags.includes(filterTag) ? filterTag : ''} onChange={(event) => setFilterTag(event.target.value)}>
            <option value="">All tags</option>
            {availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </Field>}
        {pending || edit ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              const labels = tags.split(';').map((tag) => tag.trim()).filter(Boolean);
              if (labels.length > 20 || labels.some((tag) => tag.length > 64))
                throw new Error('Use up to 20 tags of up to 64 characters.');
              if (pending) {
                await api(path, { method: 'POST', body: { ...pending.selection, id: pending.id, kind, color, comment, tags: labels } });
              } else if (edit) {
                await api(`/research/pdf-annotations/${edit.id}`, { method: 'PATCH', version: edit.version, body: { kind, color, comment, tags: labels } });
              }
              setPending(undefined);
              setEdit(undefined);
            });
          }}>
            {(kind === 'highlight' || kind === 'underline') && <blockquote>{pending?.selection.text ?? edit?.text}</blockquote>}
            {kind === 'note' || kind === 'area' || kind === 'ink' ? <p className="muted">
              {{ note: 'Page note', area: 'Marked area', ink: 'Ink stroke' }[kind]} · Page {pending?.selection.page ?? edit?.page}
            </p> : <Field label="Mark">
              <select value={kind} onChange={(event) => setKind(event.target.value as Annotation['kind'])}>
                <option value="highlight">Highlight</option><option value="underline">Underline</option>
              </select>
            </Field>}
            <Field label="Color">
              <select value={color} onChange={(event) => setColor(event.target.value as Color)}>
                {Object.keys(colors).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </Field>
            <Field label="Comment">
              <textarea ref={commentField} rows={3} value={comment} maxLength={12000} required={kind === 'note'}
                onChange={(event) => setComment(event.target.value)} />
            </Field>
            <Field label="Annotation tags" hint="Separate tags with semicolons.">
              <input value={tags} maxLength={1320} onChange={(event) => setTags(event.target.value)} />
            </Field>
            <div className="inline-actions">
              <button type="button" className="button small" disabled={action.busy}
                onClick={() => { setEdit(undefined); setPending(undefined); action.setError(null); }}>Cancel</button>
              <button className="button small primary" type="submit" disabled={action.busy || (kind === 'note' && !comment.trim())}>Save annotation</button>
            </div>
          </form>
        ) : (
          items.length === 0 && !loading && !loadError &&
          <p className="muted">Select text on the page to add a highlight or underline.</p>
        )}
        <ul ref={annotationList} className={styles.annotationList}>
          {visibleItems.map((item) => (
            <li key={item.id} aria-current={activeAnnotation === item.id ? 'location' : undefined}>
              <label>
                <input type="checkbox" checked={selectedMarks.includes(item.id)}
                  aria-label={`Include annotation on page ${item.page}: ${(item.text || item.comment || '').slice(0, 80)}`}
                  onChange={(event) => setSelectedMarks((previous) => event.target.checked
                    ? [...previous, item.id] : previous.filter((id) => id !== item.id))} />
                {' '}Include in note
              </label>
              <button type="button" className="text-link" onClick={() => {
                setActiveAnnotation(item.id); setRequestedPage(item.page); setJump((value) => value + 1);
              }}>
                Page {item.page}
              </button>
              {item.text && <blockquote>{item.text}</blockquote>}
              {item.comment && <p>{item.comment}</p>}
              {!!item.tags?.length && <p className="muted small-text">{item.tags.join(' · ')}</p>}
              {item.kind === 'area' && <span className="muted small-text">Marked area</span>}
              {item.kind === 'ink' && <span className="muted small-text">Ink stroke</span>}
              <div className="inline-actions">
                <button className="button small" type="button" disabled={action.busy} onClick={() => {
                  setPending(undefined); setEdit(item); setKind(item.kind); setColor(item.color); setComment(item.comment ?? '');
                  setTags(item.tags?.join('; ') ?? '');
                }}>Edit</button>
                <button className="button small" type="button" disabled={action.busy} onClick={() => void action.run(async () => {
                  await api(`/research/pdf-annotations/${item.id}`, { method: 'DELETE', version: item.version });
                  setSelectedMarks((previous) => previous.filter((id) => id !== item.id));
                  if (edit?.id === item.id) setEdit(undefined);
                })}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    )} />
    {researchPage !== undefined && (
      <LiteratureResearchSource
        source={{ referenceId: file.reference_id, pdfId: file.id, page: researchPage }}
        title={referenceTitle}
        onClose={() => setResearchPage(undefined)}
      />
    )}
  </>;
}
