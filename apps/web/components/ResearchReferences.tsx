'use client';

import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { CollectionNavigation, ReferenceCollections, useLiteratureCollections } from './LiteratureCollections';
import { LiteratureFullTextSearch } from './LiteratureFullTextSearch';
import { LiteratureDuplicates } from './LiteratureDuplicates';
import { LiteratureSavedSearches } from './LiteratureSavedSearches';
import { LiteratureIdentifierLookup, type LookupReference } from './LiteratureIdentifierLookup';
import { LiteraturePanes, useLibraryDetailsVisibility, useLibrarySort, type LibrarySort } from './LiteraturePanes';
import type { BibliographyExportFormat } from '../lib/bibliography-export';
import type { BibliographyCapture } from '../lib/bibliography-capture';
import type { LiteratureCondition } from '../lib/literature-advanced-search';
import type { LiteratureBatchItem, LiteratureBatchResult } from './LiteratureBatchEdit';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError, useAction, useResource, uuid } from '../lib/api';
import {
  bibliographyBibtex,
  arxivReferencePattern,
  citationKey,
  citationKeyPattern,
  referenceUrl,
  type BibliographyItem,
  type ReferenceFields,
  type Publication,
  referenceCreatorRoles,
  referenceCreators,
  type ReferenceCreator,
} from '../lib/bibliography';
import { ErrorState, Field, Icon, KnowledgeMarkdown, Loading, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';
import { ResearchSidebarPanel } from './ResearchSidebarPanel';

const BibliographyImport = dynamic(() => import('./BibliographyImport').then((module) => module.BibliographyImport), { loading: Loading });

const BrowserCaptureImport = dynamic(
  () => import('./BrowserCaptureImport').then((module) => module.BrowserCaptureImport),
  { loading: Loading },
);

const LiteraturePdfAttachments = dynamic(
  () => import('./LiteraturePdfAttachments').then((module) => module.LiteraturePdfAttachments),
  { loading: Loading, ssr: false },
);

const LiteraturePdfImport = dynamic(
  () => import('./LiteraturePdfImport').then((module) => module.LiteraturePdfImport),
  { loading: Loading, ssr: false },
);

const LiteratureAnnotationBrowser = dynamic(
  () => import('./LiteratureAnnotationBrowser').then((module) => module.LiteratureAnnotationBrowser),
  { loading: Loading },
);

const LiteratureCitationPreview = dynamic(
  () => import('./LiteratureCitationPreview').then((module) => module.LiteratureCitationPreview),
  { loading: Loading },
);
const LiteratureWritingExport = dynamic(
  () => import('./LiteratureWritingExport').then((module) => module.LiteratureWritingExport),
  { loading: Loading },
);

const LiteratureRelatedReferences = dynamic(
  () => import('./LiteratureRelatedReferences').then((module) => module.LiteratureRelatedReferences),
  { loading: Loading },
);
const LiteratureKnowledgeNotes = dynamic(
  () => import('./LiteratureKnowledgeNotes').then((module) => module.LiteratureKnowledgeNotes),
  { loading: Loading },
);
const LiteratureAdvancedSearch = dynamic(
  () => import('./LiteratureAdvancedSearch').then((module) => module.LiteratureAdvancedSearch),
  { loading: Loading },
);
const LiteratureBatchEdit = dynamic(
  () => import('./LiteratureBatchEdit').then((module) => module.LiteratureBatchEdit),
  { loading: Loading },
);
const LiteratureTeamLibraries = dynamic(
  () => import('./LiteratureTeamLibraries').then((module) => module.LiteratureTeamLibraries),
  { loading: Loading },
);
const LiteratureFeedPreview = dynamic(
  () => import('./LiteratureFeedPreview').then((module) => module.LiteratureFeedPreview),
  { loading: Loading },
);

type ProjectReference = BibliographyItem & { link_id?: string; link_version?: string };
type ReferenceDraft = LookupReference & { creators?: ReferenceCreator[]; tags?: string[]; snapshot?: BibliographyCapture['snapshot'] };
type Bibliography = { items: ProjectReference[] };

export function useProjectBibliography(projectId: string) {
  return useResource<Bibliography>(`/research/projects/${projectId}/bibliography`);
}

function authorYear(item: ReferenceFields) {
  return [item.authors.join(', '), item.year].filter(Boolean).join(' · ');
}

export function ResearchReferences({
  projectId,
  bibliography,
  onAddPaper,
}: {
  projectId: string;
  bibliography: ReturnType<typeof useProjectBibliography>;
  onAddPaper?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState<string>();
  const [dialog, setDialog] = useState<'add' | BibliographyItem | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [attachments, setAttachments] = useState<BibliographyItem>();
  const [showCitations, setShowCitations] = useState(false);
  const [showWritingExport, setShowWritingExport] = useState(false);
  const items = bibliography.data?.items ?? [];
  const loadCitations = useCallback(async () => bibliography.data?.items ?? [], [bibliography.data]);
  const action = useAction(bibliography.reload);
  const biblatex = useAction();
  async function exportProjectBibLaTeX() {
    const { bibliographyExport } = await import('../lib/bibliography-export');
    const { content, extension, mimeType } = bibliographyExport(items, 'biblatex');
    downloadBibliography(content, `references-biblatex${extension}`, mimeType);
  }
  useEffect(() => {
    function revealReference() {
      const hash = window.location.hash.slice(1);
      if (window.location.pathname === `/research/${projectId}` && /^reference-[a-f0-9-]{36}$/i.test(hash)) {
        setAnchor(hash);
        setExpanded(true);
      } else setAnchor(undefined);
    }
    revealReference();
    window.addEventListener('hashchange', revealReference);
    return () => window.removeEventListener('hashchange', revealReference);
  }, [projectId]);
  useEffect(() => {
    if (!expanded || !anchor || !bibliography.data) return;
    const timer = window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'nearest' }), 220);
    return () => window.clearTimeout(timer);
  }, [expanded, anchor, bibliography.data]);

  return (
    <>
      <ResearchSidebarPanel title="References" open={expanded} onToggle={setExpanded}
        count={bibliography.data ? String(items.length) : undefined}>
        <div className={styles.actions}>
          {onAddPaper && (
            <button className="button small" type="button" onClick={onAddPaper}>
              Choose paper
            </button>
          )}
          <button className="button small" type="button" onClick={() => setChoosing(true)}>Choose from library</button>
          <Link className="button small" href="/research/library">Open library</Link>
          <button className="button small" type="button" onClick={() => setDialog('add')}>
            <Icon name="plus" size={15} /> Add reference
          </button>
          {items.length > 0 && (
            <button className="button small" type="button" onClick={() => downloadBibtex(items, 'references.bib')}>
              Export BibTeX
            </button>
          )}
          {items.length > 0 && (
            <>
              <button className="button small" type="button" disabled={biblatex.busy}
                onClick={() => void biblatex.run(exportProjectBibLaTeX)}>Export BibLaTeX</button>
              <button className="button small" type="button" onClick={() => setShowCitations(true)}>Format citations</button>
              <button className="button small" type="button" onClick={() => setShowWritingExport(true)}>Export writing project</button>
            </>
          )}
        </div>
        <ErrorState error={bibliography.error} retry={bibliography.reload} />
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {biblatex.error && <Notice tone="error">{biblatex.error}</Notice>}
        {bibliography.loading && !bibliography.data && <Loading />}
        {bibliography.data && !items.length && (
          <p className="muted small-text">Add a reference or link a paper from Discover.</p>
        )}
        <ul className={styles.rows}>
          {items.map((item) => {
            const url = referenceUrl(item);
            return (
              <li className={styles.row} key={`${item.kind}:${item.id}`} id={`reference-${item.id}`}>
                <div>
                  {url ? (
                    <a className={`text-link ${styles.rowTitle}`} href={url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  ) : (
                    <span className={styles.rowTitle}>{item.title}</span>
                  )}
                  <span className={`small-text muted ${styles.rowMeta}`}>{authorYear(item)}</span>
                </div>
                {item.kind === 'reference' && (
                  <div className={styles.inlineActions}>
                    <Link className="button small" href={`/research/library?reference=${item.id}`}
                      aria-label={`Details for ${item.title}`}>Details</Link>
                    <button className="button small" type="button"
                      aria-label={`Attachments for ${item.title}`} onClick={() => setAttachments(item)}>Files</button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Edit reference ${item.title}`}
                      disabled={action.busy}
                      onClick={() => setDialog(item)}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`${item.link_id ? 'Unlink' : 'Remove reference'} ${item.title}`}
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          api(
                            item.link_id ? `/research/reference-links/${item.link_id}` : `/research/references/${item.id}`,
                            { method: 'DELETE', version: item.link_version ?? item.version },
                          ),
                        )
                      }
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </ResearchSidebarPanel>
      {showCitations && <LiteratureCitationPreview load={loadCitations} onClose={() => setShowCitations(false)} />}
      {showWritingExport && <LiteratureWritingExport load={loadCitations} onClose={() => setShowWritingExport(false)} />}
      {attachments && (
        <LiteraturePdfAttachments referenceId={attachments.id} title={attachments.title}
          onClose={() => setAttachments(undefined)} />
      )}
      {choosing && (
        <ChooseLibraryReference
          projectId={projectId}
          onClose={() => setChoosing(false)}
          onLinked={() => { setChoosing(false); bibliography.reload(); }}
        />
      )}
      {dialog && (
        <ReferenceEditor
          projectId={projectId}
          item={dialog === 'add' ? undefined : dialog}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null);
            bibliography.reload();
          }}
        />
      )}
    </>
  );
}

function downloadBibtex(items: BibliographyItem[], filename: string) {
  downloadBibliography(bibliographyBibtex(items), filename, 'text/plain;charset=utf-8');
}

function downloadBibliography(content: string, filename: string, mimeType: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: mimeType }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type LibraryItem = BibliographyItem & {
  project_id: string | null;
  projects: { id: string; title: string }[];
};
type LibraryReferenceDetail = ReferenceFields & { id: string; version: string; project_id: string | null };
type LibraryPage = { items: LibraryItem[]; next_cursor: string | null };
const libraryColumns = [{ sort: 'title', label: 'Title' }, { sort: 'author', label: 'Authors' },
  { sort: 'year', label: 'Year' }] as const;
const libraryPath = '/research/library';
const libraryReferenceHref = (id: string) => `${libraryPath}?reference=${id}`;
const readLibrary = (request: string, signal?: AbortSignal) => request.startsWith('{')
  ? api<LibraryPage>('/research/library/search', { method: 'POST', body: JSON.parse(request), signal })
  : api<LibraryPage>(`/research/library?${request}`, { signal });
const readReference = async (id: string, signal: AbortSignal) => ({
  requestedId: id,
  item: await api<LibraryReferenceDetail>(`/research/references/${id}`, { signal }),
});

function LibraryTool({ label, icon, onClick, disabled, primary, showLabel, pressed, controls, expanded }: {
  label: string; icon: string; onClick: () => void; disabled?: boolean; primary?: boolean;
  showLabel?: boolean; pressed?: boolean; controls?: string; expanded?: boolean;
}) {
  return <button className={primary ? 'button small primary' : 'icon-button'} type="button" aria-label={label}
    title={label} onClick={onClick} disabled={disabled} aria-pressed={pressed} aria-controls={controls} aria-expanded={expanded}>
    <Icon name={icon} size={17} />{showLabel && <span>{label}</span>}
  </button>;
}

export function LiteratureLibrary({ referenceId, pdfId, pdfPage, annotationId, userId, teamLibrariesEnabled, readerTab, onCloseReaderTab }: {
  referenceId?: string; pdfId?: string; pdfPage?: number; annotationId?: string; userId?: string; teamLibrariesEnabled?: boolean;
  readerTab?: boolean; onCloseReaderTab?: () => void;
}) {
  const router = useRouter();
  const detail = useResource(referenceId ?? null, readReference);
  const reference = detail.data?.requestedId === referenceId ? detail.data?.item : undefined;
  const [selectedPaper, setSelectedPaper] = useState<LibraryItem>();
  const inspector = useRef<HTMLElement>(null);
  const focusAfterSelect = useRef(false);
  const focusAfterClose = useRef(false);
  const inspectorTitle = useId();
  const detailsId = `${inspectorTitle}-pane`;
  const collectionId = useId();
  const { collapsed, setCollapsed } = useLibraryDetailsVisibility();
  const { sort, direction, setOrder } = useLibrarySort();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [collection, setCollection] = useState<string | null>(null);
  const [conditions, setConditions] = useState<LiteratureCondition | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTeams, setShowTeams] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [batchItems, setBatchItems] = useState<Map<string, LiteratureBatchItem>>(() => new Map());
  const [showBatch, setShowBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<LiteratureBatchResult>();
  const [undone, setUndone] = useState(false);
  const undoKey = useRef<string>(undefined);
  const [organizing, setOrganizing] = useState<Pick<LibraryItem, 'id' | 'title'>>();
  const [showExport, setShowExport] = useState(false);
  const [showCitations, setShowCitations] = useState(false);
  const [showWritingExport, setShowWritingExport] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [format, setFormat] = useState<BibliographyExportFormat>('bibtex');
  const collections = useLiteratureCollections();
  const [pagination, setPagination] = useState<{ order: string; cursors: string[] }>({ order: '', cursors: [] });
  const [editor, setEditor] = useState<'add' | BibliographyItem | null>(null);
  const [remove, setRemove] = useState<LibraryItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [importingPdf, setImportingPdf] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [previewFeed, setPreviewFeed] = useState(false);
  const [lookup, setLookup] = useState(false);
  const [draft, setDraft] = useState<ReferenceDraft>();
  const orderKey = `${sort}:${direction}`;
  const pages = pagination.order === orderKey ? pagination.cursors : [];
  useEffect(() => {
    setPagination((previous) => previous.order === orderKey ? previous : { order: orderKey, cursors: [] });
  }, [orderKey]);
  function setPages(update: string[] | ((previous: string[]) => string[])) {
    setPagination((previous) => ({ order: orderKey, cursors: typeof update === 'function'
      ? update(previous.order === orderKey ? previous.cursors : []) : update }));
  }
  const libraryRequest = useCallback((limit: number, cursor?: string) => {
    if (conditions) return JSON.stringify({ conditions, q: query || undefined, tag: tag || undefined,
      collection_id: collection || undefined, limit, cursor, sort, direction });
    const params = new URLSearchParams({ limit: String(limit), sort, direction });
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);
    if (collection) params.set('collection_id', collection);
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }, [query, tag, collection, conditions, sort, direction]);
  const cursor = pages.at(-1);
  const library = useResource<LibraryPage>(libraryRequest(25, cursor), readLibrary);
  const next = library.data?.next_cursor;
  const undoBatch = useAction(library.reload);
  const exporting = useAction();
  const loadCitations = useCallback(async (signal?: AbortSignal) => {
    const items: LibraryItem[] = [];
    let cursor: string | undefined;
    do {
      const result = await readLibrary(libraryRequest(100, cursor), signal);
      items.push(...result.items);
      cursor = result.next_cursor ?? undefined;
    } while (cursor);
    return items;
  }, [libraryRequest]);
  async function exportResults() {
    const items = await loadCitations();
    if (!items.length) return;
    const { bibliographyExport } = await import('../lib/bibliography-export');
    const { content, extension, mimeType } = bibliographyExport(items, format);
    downloadBibliography(content, `prism-library${format === 'biblatex' ? '-biblatex' : ''}${extension}`, mimeType);
    setShowExport(false);
  }
  const deletion = useAction(() => {
    if (remove?.id === reference?.id) window.history.replaceState(null, '', libraryPath);
    setRemove(null);
    if (library.data?.items.length === 1 && pages.length) setPages((previous) => previous.slice(0, -1));
    else library.reload();
  });
  const currentCollection = collections.data?.items.find(({ id }) => id === collection);
  const hasResults = !library.loading && !!library.data?.items.length;
  const [lastSelectedRow, setLastSelectedRow] = useState<LibraryItem>();
  const rowInList = library.data?.items.find((item) => item.kind === 'reference' && item.id === reference?.id);
  const selectedRow = rowInList ?? (lastSelectedRow?.id === reference?.id ? lastSelectedRow : undefined);
  useEffect(() => {
    if (rowInList) setLastSelectedRow(rowInList);
  }, [rowInList]);
  const paper = referenceId ? undefined : selectedPaper;
  const selectedTitle = reference?.title ?? paper?.title;
  useEffect(() => {
    const element = inspector.current;
    if (!element) return;
    if (focusAfterSelect.current && !collapsed && getComputedStyle(element).getPropertyValue('--library-stacked').trim() === '1') {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'nearest' });
    }
    focusAfterSelect.current = false;
    if (focusAfterClose.current) {
      searchInput.current?.focus({ preventScroll: true });
      searchInput.current?.scrollIntoView({ block: 'nearest' });
      focusAfterClose.current = false;
    }
  }, [referenceId, paper?.id, pdfId, collapsed]);
  useEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0;
  }, [referenceId, paper?.id]);
  function selectReference(id: string) {
    setSelectedPaper(undefined);
    if (referenceId !== id || pdfId) {
      focusAfterSelect.current = true;
      window.history.replaceState(null, '', libraryReferenceHref(id));
    }
  }
  function clearReference() {
    focusAfterClose.current = true;
    setSelectedPaper(undefined);
    if (referenceId) window.history.replaceState(null, '', libraryPath);
  }
  function toggleSelection() {
    setSelecting(!selecting);
    setBatchItems(new Map());
  }
  function changeSort(column: LibrarySort['sort']) {
    setPages([]);
    setOrder({ sort: column, direction: column === sort && direction === 'asc' ? 'desc' : 'asc' });
  }

  if (readerTab && referenceId && pdfId) return <>
    <ErrorState error={detail.error} retry={detail.reload} />
    {!reference && !detail.error && <Loading />}
    {reference && <LiteraturePdfAttachments key={pdfId} referenceId={reference.id} title={reference.title}
      openPdfId={pdfId} openPage={pdfPage} openAnnotationId={annotationId} inline
      onClose={onCloseReaderTab ?? (() => router.replace(libraryPath))} />}
  </>;

  return (
    <div className={styles.libraryShell}>
      <header className={styles.libraryHeading}>
        <h1>Library</h1>
        <div className={styles.libraryActions} role="group" aria-label="Library tools">
          <div className={styles.libraryToolGroup} role="group" aria-label="Add and import">
            <LibraryTool label="Add reference" icon="plus" primary showLabel onClick={() => setEditor('add')} />
            <LibraryTool label="Look up identifier" icon="search" onClick={() => setLookup(true)} />
            <LibraryTool label="Import PDF" icon="file" onClick={() => setImportingPdf(true)} />
            <LibraryTool label="Import bibliography" icon="import" onClick={() => setImporting(true)} />
            <LibraryTool label="Capture from browser" icon="external" onClick={() => setCapturing(true)} />
          </div>
          <div className={styles.libraryToolGroup} role="group" aria-label="Organize and read">
            <LibraryTool label="Select references" icon="select" pressed={selecting} onClick={toggleSelection} />
            <LibraryTool label="Find duplicates" icon="duplicates" onClick={() => setShowDuplicates(true)} />
            <LibraryTool label="Search attachment text" icon="fileSearch" onClick={() => setShowFullText(true)} />
            <LibraryTool label="Annotations" icon="annotation" onClick={() => setShowAnnotations(true)} />
            <LibraryTool label="Feeds" icon="feed" onClick={() => setPreviewFeed(true)} />
            {teamLibrariesEnabled && <LibraryTool label="Team libraries" icon="users" onClick={() => setShowTeams(true)} />}
          </div>
          <div className={styles.libraryToolGroup} role="group" aria-label="Cite and export">
            <LibraryTool label="Format citations" icon="quote" disabled={!hasResults} onClick={() => setShowCitations(true)} />
            <LibraryTool label="Export bibliography" icon="export" disabled={!hasResults || exporting.busy}
              onClick={() => { exporting.setError(null); setShowExport(true); }} />
            <LibraryTool label="Export writing project" icon="edit" disabled={!hasResults} onClick={() => setShowWritingExport(true)} />
          </div>
          <div className={styles.libraryToolGroup}>
            <LibraryTool label={collapsed ? 'Show reference details' : 'Hide reference details'} icon="detailsPane"
              controls={detailsId} expanded={!collapsed} onClick={() => {
                focusAfterSelect.current = collapsed && !!(referenceId || paper);
                setCollapsed(!collapsed);
              }} />
          </div>
        </div>
      </header>
      <LiteraturePanes collectionId={collectionId} detailsId={detailsId} inspecting={!collapsed && !!(referenceId || paper)}
        collections={<CollectionNavigation id={collectionId}
          collections={collections}
          selected={collection}
          onSelect={(id) => {
            setCollection(id);
            setPages([]);
            if (!collapsed && (referenceId || paper) && inspector.current &&
              getComputedStyle(inspector.current).getPropertyValue('--library-stacked').trim() === '1') clearReference();
          }}
          onChanged={collections.reload}
        />}
        results={<section className={styles.libraryResults} aria-label="Literature results">
        <h2>{currentCollection?.name ?? 'All references'}</h2>
        <form
          className={styles.toolbar}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim());
            setPages([]);
          }}
        >
          <input
            className={styles.search}
            name="q"
            ref={searchInput}
            maxLength={300}
            type="search"
            aria-label="Search library"
            placeholder="Title, author, year, or identifier"
          />
          <button className="button" type="submit">Search</button>
          <button className="button" type="button" onClick={() => setShowAdvanced(true)}>Advanced search</button>
        </form>
        {userId && (
          <LiteratureSavedSearches key={userId} userId={userId} filters={{ query, tag, collection, conditions }}
            onApply={(filters) => {
              setQuery(filters.query);
              setTag(filters.tag);
              setCollection(filters.collection);
              setConditions(filters.conditions ?? null);
              setPages([]);
              if (searchInput.current) searchInput.current.value = filters.query;
            }} />
        )}
        {conditions && <button type="button" className="button small" onClick={() => { setConditions(null); setPages([]); }}>
          Clear advanced conditions
        </button>}
        {tag && (
          <button type="button" className="button small" onClick={() => { setTag(''); setPages([]); }}>
            Clear tag filter · {tag}
          </button>
        )}
        <ErrorState error={library.error} retry={library.reload} />
        {selecting && <div className={styles.inlineActions}>
          <button type="button" className="button small" onClick={toggleSelection}>Done selecting</button>
          <button type="button" className="button small primary" disabled={!batchItems.size}
            onClick={() => setShowBatch(true)}>Edit selected ({batchItems.size})</button>
        </div>}
        {(batchResult || undone) && <div className={styles.inlineActions}>
          <span role="status" className="small-text">{undone ? 'Batch edit undone.' :
            `${batchResult!.changed_count} ${batchResult!.changed_count === 1 ? 'reference' : 'references'} updated.`}</span>
          {batchResult?.undo_token && <button type="button" className="button small" disabled={undoBatch.busy} onClick={() => {
            const token = batchResult.undo_token;
            undoKey.current ??= uuid();
            void undoBatch.run(async () => {
              await api('/research/library/batch-edit/undo', { method: 'POST', key: undoKey.current, body: { undo_token: token } });
              setBatchResult(undefined);
              setUndone(true);
            });
          }}>Undo batch edit</button>}
        </div>}
        {undoBatch.error && <Notice tone="error">{undoBatch.error}</Notice>}
        {collection && library.error && (
          <button className="button small" type="button"
            onClick={() => { setCollection(null); setPages([]); }}>Clear collection filter</button>
        )}
        <table className={styles.libraryTable} aria-label="Library references"
          aria-busy={library.loading}>
          <colgroup>
            {selecting && <col className={styles.librarySelectColumn} />}
            <col /><col className={styles.libraryAuthorColumn} /><col className={styles.libraryYearColumn} />
          </colgroup>
          <thead><tr>
            {selecting && <th scope="col" aria-label="Select references" />}
            {libraryColumns.map(({ sort: column, label }) => <th key={column} scope="col"
              aria-sort={sort === column ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
              <button type="button" onClick={() => changeSort(column)}>{label}
                {sort === column && <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d={direction === 'asc' ? 'm3 7 3-3 3 3' : 'm3 5 3 3 3-3'} />
                </svg>}
              </button>
            </th>)}
          </tr></thead>
          <tbody>
            {!library.loading && !library.error && library.data?.items.map((item) => {
              const current = item.kind === 'reference'
                ? item.id === (reference?.id ?? referenceId) : item.id === paper?.id;
              const authors = item.authors.join(', ');
              return <tr key={`${item.kind}:${item.id}`} id={`reference-${item.id}`} data-current={current}>
                {selecting && <td>{item.kind === 'reference' && <input type="checkbox" aria-label={`Select ${item.title}`}
                  checked={batchItems.has(item.id)} disabled={!batchItems.has(item.id) && batchItems.size >= 50}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setBatchItems((current) => {
                      const next = new Map(current);
                      if (checked) next.set(item.id, { id: item.id, version: item.version, title: item.title });
                      else next.delete(item.id);
                      return next;
                    });
                  }} />}</td>}
                <td>{item.kind === 'reference' ? (
                  <a href={libraryReferenceHref(item.id)} className={styles.libraryRowChoice}
                    title={item.title} aria-current={current ? 'true' : undefined} aria-controls={detailsId}
                    onClick={(event) => {
                      if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault();
                      selectReference(item.id);
                    }}>{item.title}</a>
                ) : (
                  <button className={styles.libraryRowChoice} type="button" title={item.title} aria-pressed={current}
                    aria-controls={detailsId} onClick={() => {
                      focusAfterSelect.current = true;
                      setSelectedPaper(item);
                      if (referenceId) window.history.replaceState(null, '', libraryPath);
                    }}>{item.title}</button>
                )}</td>
                <td title={authors || undefined}>{authors || '—'}</td>
                <td>{item.year ?? '—'}</td>
              </tr>;
            })}
          </tbody>
        </table>
        {library.loading && <Loading />}
        {!library.loading && !library.error && library.data && (
          <>
            {library.data.items.length === 0 && (
              <p className="muted">
                {query || tag || conditions ? 'No references match your search.' : collection ? 'This collection is empty.' : 'Add a reference or save a paper in Discover.'}
              </p>
            )}
            {(pages.length > 0 || next) && (
              <div className={styles.pagination}>
                <button
                  className="button small"
                  type="button"
                  disabled={!pages.length}
                  onClick={() => setPages((previous) => previous.slice(0, -1))}
                >
                  Previous page
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={!next}
                  onClick={() => { if (next) setPages((previous) => [...previous, next]); }}
                >
                  Next page
                </button>
              </div>
            )}
          </>
        )}
        </section>}
        details={<section className={styles.libraryInspector} ref={inspector} tabIndex={-1} id={detailsId} aria-labelledby={inspectorTitle}>
          <header className={styles.inspectorHeader}>
            <h2 id={inspectorTitle}>{selectedTitle ?? 'Reference details'}</h2>
            {(referenceId || paper) && <LibraryTool label="Close reference details" icon="close" onClick={clearReference} />}
          </header>
          {referenceId && !reference && (detail.error
            ? <ErrorState error={detail.error} retry={detail.reload} /> : <Loading />)}
          {!referenceId && !paper && <p className={`muted ${styles.inspectorEmpty}`}>Select a reference to see its details and attachments.</p>}
          {selectedTitle && <div className={styles.inspectorBody} key={reference?.id ?? `paper:${paper?.id}`}>
            {reference && <>
              <ReferenceMetadata item={reference} />
              <div className={styles.inspectorTools} role="group" aria-label="Selected reference tools">
                <LibraryTool label={`Edit reference ${reference.title}`} icon="edit"
                  onClick={() => setEditor({ ...reference, kind: 'reference' })} />
                <LibraryTool label={`Manage collections for ${reference.title}`} icon="folder"
                  onClick={() => setOrganizing(reference)} />
                {selectedRow?.project_id === null && selectedRow.projects.length === 0 &&
                  <LibraryTool label={`Remove reference ${reference.title}`} icon="trash" onClick={() => setRemove({ ...selectedRow, ...reference })} />}
                {referenceUrl(reference) && <a className="icon-button" aria-label="Open source" title="Open source"
                  href={referenceUrl(reference)!} target="_blank" rel="noreferrer"><Icon name="external" size={17} /></a>}
              </div>
              <LiteraturePdfAttachments referenceId={reference.id} title={reference.title} embedded />
              <LibraryReferenceDetails item={reference} onChanged={(item) => {
                detail.setData((current) => current?.item.id === item.id ? { ...current, item } : current);
                detail.reload();
                library.reload();
              }} onReloaded={(item) => detail.setData((current) => current?.item.id === item.id ? { ...current, item } : current)} />
            </>}
            {paper && <>
              <ReferenceMetadata item={paper} />
              <section className={styles.inspectorSection} aria-label="Attachments">
                <h3>Attachments</h3>
                <div className={styles.inlineActions}>
                  {referenceUrl(paper) && <a className="button small" href={referenceUrl(paper)!} target="_blank" rel="noreferrer">Open source</a>}
                  {paper.arxiv_id && arxivReferencePattern.test(paper.arxiv_id) && <a className="button small" href={`https://arxiv.org/pdf/${paper.arxiv_id}`} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> Open arXiv PDF
                  </a>}
                </div>
              </section>
            </>}
            {!!(selectedRow ?? paper)?.projects.length && <section className={styles.inspectorSection} aria-label="Research projects">
              <h3>Research projects</h3>
              {(selectedRow ?? paper)?.projects.map((project) => (
                <Link key={project.id} href={`/research/${project.id}`} className="text-link small-text">{project.title}</Link>
              ))}
            </section>}
            {!!reference?.tags?.length && <section className={styles.inspectorSection} aria-label="Tags">
              <h3>Tags</h3>
              <div className={styles.inlineActions}>{reference.tags.map((value) => (
                <button className="button small" type="button" key={value} aria-pressed={tag.toLowerCase() === value.toLowerCase()}
                  onClick={() => { setTag(value); setPages([]); }}>{value}</button>
              ))}</div>
            </section>}
            {reference && <>
              <LiteratureKnowledgeNotes id={reference.id} />
              <LiteratureRelatedReferences id={reference.id} />
            </>}
          </div>}
        </section>} />
      {showCitations && <LiteratureCitationPreview load={loadCitations} onClose={() => setShowCitations(false)} />}
      {showWritingExport && <LiteratureWritingExport load={loadCitations} onClose={() => setShowWritingExport(false)} />}
      {showFullText && <LiteratureFullTextSearch onClose={() => setShowFullText(false)} />}
      {showAnnotations && <LiteratureAnnotationBrowser userId={userId} onClose={() => setShowAnnotations(false)} />}
      {showDuplicates && (
        <LiteratureDuplicates onClose={() => setShowDuplicates(false)}
          onMerged={() => { setPages([]); library.reload(); }} />
      )}
      {showExport && (
        <Modal title="Export bibliography" onClose={() => { if (!exporting.busy) setShowExport(false); }}>
          <Field label="Format">
            <select value={format} disabled={exporting.busy}
              onChange={(event) => setFormat(event.target.value as BibliographyExportFormat)}>
              <option value="bibtex">BibTeX</option>
              <option value="biblatex">BibLaTeX</option>
              <option value="ris">RIS</option>
              <option value="csl-json">CSL JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </Field>
          <p className="muted">Exports all references in the current view, including results on other pages.</p>
          {exporting.error && <Notice tone="error">{exporting.error}</Notice>}
          <div className="modal-footer">
            <button className="button primary" type="button" disabled={exporting.busy}
              onClick={() => void exporting.run(exportResults)}>
              {exporting.busy ? 'Exporting…' : 'Download'}
            </button>
          </div>
        </Modal>
      )}
      {organizing && (
        <ReferenceCollections id={organizing.id} title={organizing.title} items={collections.data?.items ?? []}
          onClose={() => setOrganizing(undefined)}
          onChanged={library.reload} />
      )}
      {showAdvanced && <LiteratureAdvancedSearch initial={conditions} collections={collections.data?.items ?? []}
        onClose={() => setShowAdvanced(false)} onApply={(condition) => {
          setConditions(condition);
          setPages([]);
          setShowAdvanced(false);
        }} />}
      {showBatch && <LiteratureBatchEdit items={[...batchItems.values()]} onClose={() => setShowBatch(false)} onSaved={(result) => {
        setShowBatch(false);
        setSelecting(false);
        setBatchItems(new Map());
        setBatchResult(result);
        setUndone(false);
        undoKey.current = undefined;
        undoBatch.setError(null);
        library.reload();
        detail.reload();
      }} />}
      {showTeams && teamLibrariesEnabled &&
        <LiteratureTeamLibraries userId={userId} onClose={() => setShowTeams(false)} />}
      {reference && pdfId && (
        <LiteraturePdfAttachments key={pdfId} referenceId={reference.id} title={reference.title}
          openPdfId={pdfId} openPage={pdfPage} openAnnotationId={annotationId}
          onClose={() => selectReference(reference.id)} />
      )}
      {editor && (
        <ReferenceEditor
          item={editor === 'add' ? undefined : editor}
          initial={draft}
          onClose={() => { setEditor(null); setDraft(undefined); }}
          onAdded={(id) => {
            setEditor(null);
            setDraft(undefined);
            if (editor === 'add') {
              setQuery('');
              setTag('');
              setCollection(null);
              setConditions(null);
              setPages([]);
              searchInput.current?.form?.reset();
            }
            library.reload();
            detail.reload();
            selectReference(id);
          }}
        />
      )}
      {lookup && <LiteratureIdentifierLookup onClose={() => setLookup(false)} onReview={(fields) => {
        setLookup(false);
        setDraft(fields);
        setEditor('add');
      }} />}
      {capturing && <BrowserCaptureImport onClose={() => { setCapturing(false); library.reload(); }} onCapture={(capture) => {
        setCapturing(false);
        setDraft({ ...capture.fields, snapshot: capture.snapshot });
        setEditor('add');
      }} />}
      {previewFeed && <LiteratureFeedPreview onClose={() => setPreviewFeed(false)} onReview={(fields) => {
        setPreviewFeed(false);
        setDraft(fields);
        setEditor('add');
      }} />}
      {importingPdf && (
        <LiteraturePdfImport onClose={() => setImportingPdf(false)} onSaved={(id) => {
          setImportingPdf(false);
          library.reload();
          selectReference(id);
        }} />
      )}
      {importing && <BibliographyImport userId={userId} onClose={() => setImporting(false)} onImported={() => { library.reload(); collections.reload(); }} />}
      {remove && (
        <Modal title="Remove reference" onClose={() => { if (!deletion.busy) setRemove(null); }}>
          <p>Remove “{remove.title}” from your library?</p>
          {deletion.error && <Notice tone="error">{deletion.error}</Notice>}
          <div className="modal-footer">
            <button className="button" type="button" disabled={deletion.busy} onClick={() => setRemove(null)}>
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              disabled={deletion.busy}
              onClick={() => void deletion.run(() =>
                api(`/research/references/${remove.id}`, { method: 'DELETE', version: remove.version }),
              )}
            >
              Remove reference
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReferenceMetadata({ item }: { item: ReferenceFields }) {
  const publication = item.publication;
  const venue = [publication?.journal || publication?.booktitle, publication?.publisher].filter(Boolean).join(' · ');
  return <div className={styles.inspectorMetadata}>
    {authorYear(item) && <p>{authorYear(item)}</p>}
    {venue && <p className="muted">{venue}</p>}
    {!item.authors.length && referenceCreators(item).length > 0 && <p>{referenceCreators(item).map(({ name }) => name).join(', ')}</p>}
    {item.doi && <p className="small-text muted">DOI {item.doi}</p>}
    {item.arxiv_id && <p className="small-text muted">arXiv {item.arxiv_id}</p>}
  </div>;
}

function LibraryReferenceDetails({
  item,
  onChanged,
  onReloaded,
}: {
  item: LibraryReferenceDetail;
  onChanged: (item: LibraryReferenceDetail) => void;
  onReloaded: (item: LibraryReferenceDetail) => void;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const [edit, setEdit] = useState<{ draft: string; version: string }>();
  const [conflict, setConflict] = useState(false);
  const action = useAction();
  const publication = item.publication;
  const key = citationKey({ ...item, kind: 'reference' });
  const draft = edit?.draft.trim() ?? '';
  const valid = citationKeyPattern.test(draft);
  const canSave = valid && draft !== key && !conflict && !action.busy;
  async function copyCitationKey() {
    try {
      await navigator.clipboard.writeText(key);
      setCopyStatus('Citation key copied.');
    } catch {
      setCopyStatus('Clipboard unavailable. Select the key to copy it.');
    }
  }
  function closeEdit() {
    setEdit(undefined);
    setConflict(false);
    action.setError(null);
  }
  return (
    <section className={styles.inspectorSection} aria-label="Citation details">
      {publication?.abstract && <details className={styles.inspectorAbstract}>
        <summary>Abstract</summary><p>{publication.abstract}</p>
      </details>}
      <div className={styles.inlineActions}>
        <span className="muted">Citation key</span>
        <code className={styles.rowTitle}>{key}</code>
        <button className="button small" type="button" onClick={() => void copyCitationKey()}>
          Copy citation key
        </button>
        {!edit && (
          <button className="button small" type="button" onClick={() => {
            setCopyStatus('');
            setEdit({ draft: key, version: item.version });
          }}>
            Edit citation key
          </button>
        )}
      </div>
      {edit && (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          void action.run(async () => {
            const updated = await api<LibraryReferenceDetail>(`/research/references/${item.id}/citation-key`, {
              method: 'PATCH',
              version: edit.version,
              body: { citation_key: draft },
            }).catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 412) setConflict(true);
              throw error;
            });
            onChanged(updated);
            closeEdit();
            setCopyStatus('Citation key saved.');
          });
        }}>
          <Field label="Citation key" hint="Use letters, numbers, or _ . / : + -. Existing citations will keep working.">
            <input value={edit.draft} required maxLength={180} autoFocus spellCheck={false}
              autoCapitalize="off" autoComplete="off" disabled={action.busy}
              aria-invalid={!!edit.draft && !valid}
              onChange={(event) => {
                setEdit({ ...edit, draft: event.target.value });
                if (!conflict) action.setError(null);
              }} />
          </Field>
          {action.error && <Notice tone="error"><span role="alert">{action.error}</span></Notice>}
          <div className={styles.inlineActions}>
            {conflict && (
              <button className="button small" type="button" disabled={action.busy} onClick={() => {
                void action.run(async () => {
                  const latest = await api<LibraryReferenceDetail>(`/research/references/${item.id}`);
                  if (latest.id !== item.id) throw new Error('This reference was merged. Reopen it to edit its citation key.');
                  onReloaded(latest);
                  setEdit((previous) => previous && { ...previous, version: latest.version });
                  setConflict(false);
                });
              }}>Reload latest citation key</button>
            )}
            <button className="button small" type="button" disabled={action.busy} onClick={closeEdit}>
              Cancel
            </button>
            <button className="button small primary" type="submit" disabled={!canSave}>
              Save citation key
            </button>
          </div>
        </form>
      )}
      {copyStatus && <p className="small-text muted" role="status">{copyStatus}</p>}
    </section>
  );
}

function ChooseLibraryReference({
  projectId,
  onClose,
  onLinked,
}: {
  projectId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<string[]>([]);
  const ids = useRef(new Map<string, string>());
  const params = new URLSearchParams({ limit: '25', standalone: 'true' });
  if (query) params.set('q', query);
  const cursor = pages.at(-1);
  if (cursor) params.set('cursor', cursor);
  const library = useResource<LibraryPage>(`/research/library?${params}`);
  const action = useAction(onLinked);
  const next = library.data?.next_cursor;
  const items = library.data?.items ?? [];

  return (
    <Modal title="Choose from library" onClose={() => { if (!action.busy) onClose(); }} wide>
      <form className={styles.toolbar} onSubmit={(event) => {
        event.preventDefault();
        setQuery(String(new FormData(event.currentTarget).get('q') ?? '').trim());
        setPages([]);
      }}>
        <input className={styles.search} name="q" maxLength={300} aria-label="Search library"
          placeholder="Title, author, DOI, or citation key" />
        <button className="button" type="submit">Search</button>
      </form>
      <ErrorState error={library.error} retry={library.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {library.loading ? <Loading /> : (
        <>
          {items.length === 0 && !library.error && <p className="muted">No matching references.</p>}
          <ul className={styles.rows}>
            {items.map((item) => (
              <li className={styles.row} key={item.id}>
                <div>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={`small-text muted ${styles.rowMeta}`}>{authorYear(item)}</span>
                </div>
                <button
                  className="button small"
                  type="button"
                  aria-label={`Link ${item.title}`}
                  disabled={action.busy || item.projects.some((project) => project.id === projectId)}
                  onClick={() => {
                    const id = ids.current.get(item.id) ?? uuid();
                    ids.current.set(item.id, id);
                    void action.run(() => api('/research/reference-links', {
                      method: 'POST', body: { id, reference_id: item.id, project_id: projectId },
                    }));
                  }}
                >
                  {item.projects.some((project) => project.id === projectId) ? 'Linked' : 'Link'}
                </button>
              </li>
            ))}
          </ul>
          {(pages.length > 0 || next) && (
            <div className={styles.pagination}>
              <button className="button small" type="button" disabled={!pages.length}
                onClick={() => setPages((previous) => previous.slice(0, -1))}>Previous page</button>
              <button className="button small" type="button" disabled={!next}
                onClick={() => { if (next) setPages((previous) => [...previous, next]); }}>Next page</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

const editablePublicationFields = [
  ['journal', 'Journal'], ['booktitle', 'Book or proceedings title'], ['publisher', 'Publisher'],
  ['volume', 'Volume'], ['number', 'Issue'], ['pages', 'Pages'], ['isbn', 'ISBN'], ['issn', 'ISSN'], ['pmid', 'PubMed ID'], ['pmcid', 'PubMed Central ID'],
] as const;

function ReferenceEditor({
  projectId,
  item,
  initial,
  onClose,
  onAdded,
}: {
  projectId?: string;
  item?: BibliographyItem;
  initial?: ReferenceDraft;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [id] = useState(uuid);
  const action = useAction(() => onAdded(item?.id ?? id));
  const [savedReference, setSavedReference] = useState(false);
  const snapshotUpload = useRef<import('../lib/literature-pdfs').LiteraturePdfUpload>(null);
  const snapshot = initial?.snapshot;
  const defaults = item ?? initial;
  const defaultCreators = defaults ? referenceCreators(defaults) : [];
  return (
    <Modal title={item ? 'Edit reference' : 'Add reference'} onClose={() => { if (!action.busy) onClose(); }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = (name: string) => String(data.get(name) ?? '').trim();
          const year = value('year');
          const publication: Publication = { ...defaults?.publication };
          for (const [key] of [...editablePublicationFields, ['abstract'] as const]) {
            const next = key === 'pmcid' ? value(key).toUpperCase() : value(key);
            if (next) publication[key] = next;
            else delete publication[key];
          }
          const type = value('publication-type');
          if (type) publication.type = type;
          else delete publication.type;
          const creators = referenceCreatorRoles.flatMap((role) => {
            const names = defaultCreators.filter((entry) => entry.role === role);
            if (value(role) === names.map((entry) => entry.name).join('; ')) return names;
            return value(role).split(';').flatMap((name) => name.trim() ? [{ role, name: name.trim() }] : []);
          });
          // Keep the stored sequence when the displayed role lists did not change.
          const sameCreators = referenceCreatorRoles.every((role) => JSON.stringify(creators.filter((entry) => entry.role === role)) ===
            JSON.stringify(defaultCreators.filter((entry) => entry.role === role)));
          const fields = {
            title: value('title'),
            ...(sameCreators && item ? {} : { creators }),
            year: year ? Number(year) : null,
            doi: value('doi').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '') || null,
            arxiv_id: value('arxiv_id').replace(/^arxiv:\s*/i, '') || null,
            url: value('url') || null,
            tags: value('tags').split(';').map((tag) => tag.trim()).filter(Boolean),
            publication,
          };
          const keepSnapshot = data.get('include-snapshot') === 'on';
          void action.run(async () => {
            if (item) {
              await api(`/research/references/${item.id}`, { method: 'PATCH', version: item.version, body: fields });
              return;
            }
            if (!savedReference) {
              await api('/research/references', { method: 'POST', body: { ...fields, id, ...(projectId ? { project_id: projectId } : {}) } });
              setSavedReference(true);
            }
            if (snapshot && (keepSnapshot || snapshotUpload.current)) {
              const { uploadLiteratureAttachment } = await import('../lib/literature-pdfs');
              snapshotUpload.current ??= {
                file: new File([snapshot.text], 'Webpage snapshot.txt', { type: 'text/plain' }),
                id: uuid(), initKey: uuid(), completeKey: uuid(), chunkKeys: new Map(),
              };
              await uploadLiteratureAttachment(id, snapshotUpload.current, () => {}, 'webpage');
            }
          });
        }}
      >
        <fieldset disabled={savedReference} className={styles.referenceFields}>
        <Field label="Title">
          <input name="title" defaultValue={defaults?.title} required maxLength={500} />
        </Field>
        {referenceCreatorRoles.map((role) => <Field key={role}
          label={{ author: 'Authors', editor: 'Editors', translator: 'Translators' }[role]}
          hint="Separate names with semicolons.">
          <input name={role} defaultValue={defaultCreators.filter((entry) => entry.role === role).map((entry) => entry.name).join('; ')} />
        </Field>)}
        <div className="form-grid">
          <Field label="Year">
            <input name="year" defaultValue={defaults?.year ?? undefined} type="number" min={1} max={9999} />
          </Field>
          <Field label="DOI">
            <input name="doi" defaultValue={defaults?.doi ?? undefined} maxLength={280} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="arXiv ID">
            <input name="arxiv_id" defaultValue={defaults?.arxiv_id ?? undefined} maxLength={80} />
          </Field>
          <Field label="URL">
            <input name="url" defaultValue={defaults?.url ?? undefined} type="url" maxLength={2000} />
          </Field>
        </div>
        <details open={initial ? true : undefined} className={styles.publicationEditor}>
          <summary>Publication details</summary>
          <Field label="Publication type">
            <input name="publication-type" defaultValue={defaults?.publication?.type}
              pattern="[A-Za-z][A-Za-z0-9\-]{0,31}" maxLength={32} placeholder="article, book, thesis…" />
          </Field>
          <div className="form-grid">
            {editablePublicationFields.map(([field, label]) => (
              <Field key={field} label={label}>
                <input name={field} defaultValue={defaults?.publication?.[field]} maxLength={field === 'pmcid' ? 15 : 2000}
                  pattern={field === 'pmcid' ? '[Pp][Mm][Cc][1-9][0-9]{0,11}' : undefined} />
              </Field>
            ))}
          </div>
          <Field label="Abstract">
            <textarea name="abstract" rows={4} maxLength={12000} defaultValue={defaults?.publication?.abstract} />
          </Field>
        </details>
        <Field label="Tags" hint="Separate tags with semicolons.">
          <input name="tags" defaultValue={defaults?.tags?.join('; ')} maxLength={2640} />
        </Field>
        {snapshot && <details>
          <summary>Review captured page text{snapshot.truncated ? ' (partial)' : ''}</summary>
          <textarea readOnly aria-label="Captured page text" rows={5} value={snapshot.text} />
        </details>}
        {snapshot && <label><input type="checkbox" name="include-snapshot" defaultChecked /> Save page text as an attachment</label>}
        </fieldset>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={action.busy}>
            {savedReference ? 'Retry attachment' : 'Save reference'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CitationField({
  label,
  value,
  onChange,
  references,
  rows,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  references: BibliographyItem[];
  rows: number;
  required?: boolean;
}) {
  const editor = useRef<MarkdownEditorHandle>(null);
  const citations = useMemo(() => referenceCitations(references), [references]);
  const [key, setKey] = useState('');
  const canInsert = references.some((reference) => citationKey(reference) === key);
  return (
    <>
      <MarkdownEditor
        ref={editor}
        label={label}
        required={required}
        rows={rows}
        value={value}
        onChange={onChange}
        citations={citations}
      />
      {references.length > 0 && (
        <div className={styles.citationControls}>
          <div className={styles.toolbar}>
            <select
              aria-label={`Reference for ${label}`}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            >
              <option value="">Choose a reference</option>
              {references.map((item) => (
                <option key={citationKey(item)} value={citationKey(item)}>
                  {item.title}
                </option>
              ))}
            </select>
            <button className="button small" type="button" disabled={!canInsert} onClick={() => editor.current?.insert(`[@${key}]`)}>
              Insert citation
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function referenceCitations(references: BibliographyItem[]) {
  return Object.fromEntries(
    references.flatMap((item) => {
      const rendered = [item.authors[0]?.split(',')[0] || item.title, item.year].filter(Boolean).join(', ');
      return [citationKey(item), ...(item.citation_aliases ?? [])].map((key) => [key, rendered]);
    }),
  );
}

export function ResearchMarkdown({
  content,
  references,
}: {
  content: string;
  references: BibliographyItem[];
}) {
  return <KnowledgeMarkdown content={content} citations={referenceCitations(references)} />;
}
