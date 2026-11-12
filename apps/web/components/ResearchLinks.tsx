'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import {
  paperShelfQuery,
  paperShelves,
  usePaperFolderFeed,
  usePaperFolders,
  type PaperFolder,
  type PaperShelf,
} from '../lib/paper-folders';
import type { Entity, Knowledge, Page, Paper, Project, ResearchObject, UserPaper } from '../lib/types';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';
import styles from './ResearchLinks.module.css';

type Material = { kind: 'knowledge' | 'paper'; id: string; title: string };
type ProjectLink = Entity & { project_id: string | null };
type KnowledgeLink = ProjectLink & { knowledge_item_id: string; research_object_id: string | null };
type PaperLink = ProjectLink & { paper_id: string };
const isDirectLink = (link: ProjectLink): link is ProjectLink & { project_id: string } =>
  link.project_id !== null;

export function ResearchLinkModal({
  material,
  onClose,
  onChanged,
}: {
  material: Material;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const endpoint = `/research/${material.kind}-links`;
  const field = material.kind === 'knowledge' ? 'knowledge_item_id' : 'paper_id';
  const links = useResource<Page<ProjectLink>>(`${endpoint}?${field}=${material.id}&limit=500`);
  const projects = useResource<Page<Project>>('/research/projects?limit=500');
  const [project, setProject] = useState('');
  const [creationId, setCreationId] = useState(uuid);
  const action = useAction(() => {
    links.reload();
    onChanged?.();
  });
  const linked = links.data?.items.filter(isDirectLink) ?? [];
  const available =
    projects.data?.items.filter(
      (p) => ['active', 'paused'].includes(p.status) && !linked.some((link) => link.project_id === p.id),
    ) ?? [];
  return (
    <Modal title="Link to research" onClose={() => !action.busy && onClose()}>
      <p className="modal-description">{material.title}</p>
      <p className="muted small-text">
        Links to active projects can help PRISM recommend relevant papers in For You.
      </p>
      <ErrorState error={links.error} retry={links.reload} />
      <ErrorState error={projects.error} retry={projects.reload} />
      {(links.loading || projects.loading) && <Loading />}
      {linked.map((link) => (
        <div key={link.id} className="relation-row">
          <ProjectName projectId={link.project_id} />
          <button
            type="button"
            className="icon-button"
            aria-label="Remove research link"
            disabled={action.busy || links.loading}
            onClick={() =>
              void action.run(() =>
                api(`${endpoint}/${link.id}`, { method: 'DELETE', version: link.version }),
              )
            }
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      {!projects.loading &&
        !links.loading &&
        !projects.error &&
        !links.error &&
        (available.length ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!available.some((p) => p.id === project) || action.busy) return;
              void action.run(async () => {
                await api(endpoint, {
                  method: 'POST',
                  body: { id: creationId, project_id: project, [field]: material.id },
                });
                setCreationId(uuid());
                setProject('');
              });
            }}
          >
            <Field label="Research project">
              <select
                required
                value={project}
                disabled={action.busy}
                onChange={(event) => {
                  setProject(event.target.value);
                  setCreationId(uuid());
                }}
              >
                <option value="">Choose a project</option>
                {available.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </Field>
            <div className="modal-footer">
              <button className="button primary" disabled={!project || action.busy}>
                {action.busy ? 'Saving…' : 'Create link'}
              </button>
            </div>
          </form>
        ) : (
          <p className="muted small-text">
            {linked.length
              ? 'This item is linked to every available project.'
              : 'Create or activate a project in Research to link this item.'}
          </p>
        ))}
      {action.error && <Notice tone="error">{action.error}</Notice>}
    </Modal>
  );
}

function ProjectName({ projectId }: { projectId: string }) {
  const project = useResource<Project>(`/research/projects/${projectId}`);
  return (
    <Link className="text-link" href={`/research/${projectId}`}>
      {project.data?.title ?? (project.loading ? 'Loading project…' : 'Open research project')}
    </Link>
  );
}

function ObjectProjectName({ objectId }: { objectId: string }) {
  const object = useResource<ResearchObject>(`/research/objects/${objectId}`);
  if (!object.data) return null;
  return (
    <div className="relation-row">
      <div>
        <span className="small-text muted">{object.data.title}</span>
        <p>
          <ProjectName projectId={object.data.project_id} />
        </p>
      </div>
    </div>
  );
}

export function KnowledgeResearchLinks({ note }: { note: Knowledge }) {
  const [open, setOpen] = useState(false);
  const links = useResource<Page<KnowledgeLink>>(
    `/research/knowledge-links?knowledge_item_id=${note.id}&limit=500`,
  );
  return (
    <section className={`panel ${styles.card}`} aria-label="Research connections">
      <div className={`panel-heading ${styles.heading}`}>
        <h2>Research connections</h2>
        <button className="button small" onClick={() => setOpen(true)}>
          <Icon name="plus" size={15} /> Link to research
        </button>
      </div>
      <ErrorState error={links.error} retry={links.reload} />
      {links.loading && !links.data && <Loading />}
      {links.data?.items.map((link) =>
        isDirectLink(link) ? (
          <div className="relation-row" key={link.id}>
            <ProjectName projectId={link.project_id} />
          </div>
        ) : link.research_object_id ? (
          <ObjectProjectName key={link.id} objectId={link.research_object_id} />
        ) : null,
      )}
      {links.data?.items.length === 0 && (
        <p className={`muted small-text ${styles.description}`}>
          Link this note to a project to use it in research and paper recommendations.
        </p>
      )}
      {open && (
        <ResearchLinkModal
          material={{ kind: 'knowledge', id: note.id, title: note.title }}
          onClose={() => setOpen(false)}
          onChanged={links.reload}
        />
      )}
    </section>
  );
}

export function ProjectMaterials({
  projectId,
  userId,
  pickerOpen,
  pickerKind,
  onOpenPicker,
  onClosePicker,
  onLinked,
  onPaperLinksChanged,
  guideHint,
}: {
  projectId: string;
  userId?: string;
  pickerOpen: boolean;
  pickerKind?: Material['kind'];
  onOpenPicker: () => void;
  onClosePicker: () => void;
  onLinked: () => void;
  onPaperLinksChanged?: () => void;
  guideHint?: ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  const notes = useResource<Page<KnowledgeLink>>(
    `/research/knowledge-links?project_id=${projectId}&limit=500`,
  );
  const papers = useResource<Page<PaperLink>>(`/research/paper-links?project_id=${projectId}&limit=500`);
  const action = useAction(() => {
    notes.reload();
    papers.reload();
  });

  const remove = (kind: Material['kind'], link: ProjectLink) =>
    void action.run(async () => {
      await api(`/research/${kind}-links/${link.id}`, { method: 'DELETE', version: link.version });
      if (kind === 'paper') onPaperLinksChanged?.();
    });

  return (
    <section ref={section} tabIndex={-1} className={`panel ${styles.card}`} aria-label="Project materials">
      <div className={`panel-heading ${styles.heading}`}>
        <h2>Project materials</h2>
        <button className="button small" onClick={onOpenPicker}>
          <Icon name="plus" size={15} /> Add material
        </button>
      </div>
      <ErrorState error={notes.error} retry={notes.reload} />
      <ErrorState error={papers.error} retry={papers.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {(notes.loading || papers.loading) && <Loading />}
      {notes.data?.items.map((link) => (
        <MaterialRow
          key={link.id}
          kind="knowledge"
          id={link.knowledge_item_id}
          onRemove={() => remove('knowledge', link)}
          busy={action.busy}
        />
      ))}
      {papers.data?.items.map((link) => (
        <MaterialRow
          key={link.id}
          kind="paper"
          id={link.paper_id}
          onRemove={() => remove('paper', link)}
          busy={action.busy}
        />
      ))}
      {notes.data?.items.length === 0 && papers.data?.items.length === 0 && (
        <p className="muted small-text">
          Use Link to research in <Link href="/knowledge">Knowledge</Link> or{' '}
          <Link href="/discover">Discover</Link> to bring materials here.
        </p>
      )}
      {pickerOpen && (
        <ProjectMaterialPicker
          projectId={projectId}
          userId={userId}
          initialKind={pickerKind}
          linkedNotes={notes.data?.items ?? []}
          linkedPapers={papers.data?.items ?? []}
          onClose={onClosePicker}
          guideHint={guideHint}
          onLinked={(kind) => {
            notes.reload();
            papers.reload();
            if (kind === 'paper') onPaperLinksChanged?.();
            onLinked();
            window.requestAnimationFrame(() => section.current?.focus());
          }}
        />
      )}
    </section>
  );
}

function ProjectMaterialPicker({
  projectId,
  userId,
  initialKind = 'knowledge',
  linkedNotes,
  linkedPapers,
  onClose,
  onLinked,
  guideHint,
}: {
  projectId: string;
  userId?: string;
  initialKind?: Material['kind'];
  linkedNotes: KnowledgeLink[];
  linkedPapers: PaperLink[];
  onClose: () => void;
  onLinked: (kind: Material['kind']) => void;
  guideHint?: ReactNode;
}) {
  const [kind, setKind] = useState<Material['kind']>(initialKind);
  const [shelf, setShelf] = useState<PaperShelf | 'all'>('saved');
  const [folderId, setFolderId] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<{ id: string; linkId: string }>();
  const { folders } = usePaperFolders(userId);
  const subfolders = kind === 'paper' ? folders.filter((folder) => folder.shelf === shelf) : [];
  const folder = subfolders.find(({ id }) => id === folderId);
  const trimmedQuery = query.trim();
  const action = useAction(() => onLinked(kind));

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(trimmedQuery), 180);
    return () => window.clearTimeout(timer);
  }, [trimmedQuery]);

  const queryParam = search ? `&q=${encodeURIComponent(search)}` : '';
  const paperFilter = shelf === 'all' ? '' : paperShelfQuery(shelf);
  const path =
    kind === 'knowledge'
      ? `/knowledge-items?limit=18${queryParam}`
      : `/arxiv/feed?limit=18${paperFilter}${queryParam}`;

  return (
    <Modal title="Link material to project" onClose={() => !action.busy && onClose()}>
      {guideHint}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!selection || action.busy || search !== trimmedQuery) return;
          if (
            kind === 'knowledge'
              ? linkedNotes.some((link) => link.knowledge_item_id === selection.id)
              : linkedPapers.some((link) => link.paper_id === selection.id)
          )
            return;
          const field = kind === 'knowledge' ? 'knowledge_item_id' : 'paper_id';
          void action.run(() =>
            api(`/research/${kind}-links`, {
              method: 'POST',
              body: { id: selection.linkId, project_id: projectId, [field]: selection.id },
            }),
          );
        }}
      >
        <Field label="Search materials">
          <input
            type="search"
            value={query}
            maxLength={120}
            disabled={action.busy}
            placeholder={
              kind === 'knowledge' ? 'Search notes by title or text' : 'Search title, author or arXiv ID'
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setSelection(undefined);
            }}
          />
        </Field>
        <div className={styles.materialTypes} role="group" aria-label="Material type">
          {(['knowledge', 'paper'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              disabled={action.busy}
              onClick={() => {
                if (kind === value) return;
                setKind(value);
                setSelection(undefined);
              }}
            >
              {value === 'knowledge' ? 'Knowledge notes' : 'Papers'}
            </button>
          ))}
        </div>
        {kind === 'paper' && (
          <div className={styles.paperFilters}>
            <div className={`tabs ${styles.shelfTabs}`} role="group" aria-label="Paper collection">
              {(['saved', 'interested', 'liked', 'all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={shelf === value}
                  className={shelf === value ? 'active' : ''}
                  disabled={action.busy}
                  onClick={() => {
                    if (value === shelf) return;
                    setShelf(value);
                    setFolderId('');
                    setSelection(undefined);
                  }}
                >
                  {value === 'all' ? 'All papers' : paperShelves[value]}
                </button>
              ))}
            </div>
            {subfolders.length > 0 && (
              <Field label="Subfolder">
                <select
                  value={folder?.id ?? ''}
                  disabled={action.busy}
                  onChange={(event) => {
                    setFolderId(event.target.value);
                    setSelection(undefined);
                  }}
                >
                  <option value="">All in this collection</option>
                  {subfolders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
        {search === trimmedQuery ? (
          <MaterialResults
            key={`${path}:${folder?.id ?? ''}`}
            path={path}
            folder={folder}
            search={search}
            kind={kind}
            linkedNotes={linkedNotes}
            linkedPapers={linkedPapers}
            selectedId={selection?.id}
            onSelect={(id) =>
              setSelection((current) => (current?.id === id ? current : { id, linkId: uuid() }))
            }
            busy={action.busy}
          />
        ) : (
          <Loading />
        )}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={!selection || action.busy || search !== trimmedQuery}>
            Create link
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MaterialResults({
  path,
  folder,
  search,
  kind,
  linkedNotes,
  linkedPapers,
  selectedId,
  onSelect,
  busy,
}: {
  path: string;
  folder?: PaperFolder;
  search: string;
  kind: Material['kind'];
  linkedNotes: KnowledgeLink[];
  linkedPapers: PaperLink[];
  selectedId?: string;
  onSelect: (id: string) => void;
  busy: boolean;
}) {
  const page = useResource<Page<Knowledge | UserPaper>>(folder ? null : path);
  const folderPage = usePaperFolderFeed(folder ?? null, search);
  const resource = folder ? folderPage : page;
  const pagination = useAction();
  const [visibleCount, setVisibleCount] = useState(18);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const cursor = page.data?.next_cursor;
  const available = (resource.data?.items ?? []).flatMap((item) => {
    if ('paper' in item) {
      return linkedPapers.some((link) => link.paper_id === item.paper.id)
        ? []
        : [{ id: item.paper.id, title: item.paper.title, detail: item.paper.authors.join(', ') }];
    }
    return linkedNotes.some((link) => link.knowledge_item_id === item.id)
      ? []
      : [{ id: item.id, title: item.title, detail: item.subject }];
  });

  function loadMore() {
    if (folder) {
      setVisibleCount((count) => count + 18);
      return;
    }
    if (!cursor || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    void pagination.run(async () => {
      try {
        const next = await api<Page<Knowledge | UserPaper>>(`${path}&cursor=${encodeURIComponent(cursor)}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted)
          page.setData((current) => ({
            items: [...(current?.items ?? []), ...next.items],
            next_cursor: next.next_cursor,
          }));
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        request.current = null;
      }
    });
  }

  return (
    <>
      <ErrorState error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        <>
          {available.length > 0 ? (
            <ul className={styles.materialResults} aria-label="Material results">
              {(folder ? available.slice(0, visibleCount) : available).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.materialChoice}
                    aria-pressed={selectedId === item.id}
                    disabled={busy}
                    onClick={() => onSelect(item.id)}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      {item.detail && <small>{item.detail}</small>}
                    </span>
                    {selectedId === item.id && <Icon name="check" size={16} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            !resource.error && (
              <p className={`muted small-text ${styles.resultsEmpty}`}>
                {search
                  ? 'No unlinked materials match your search.'
                  : kind === 'knowledge'
                    ? 'No available notes. Add one in Knowledge.'
                    : folder
                      ? 'No unlinked papers in this folder.'
                      : 'No unlinked papers in this collection.'}
              </p>
            )
          )}
          {pagination.error && <Notice tone="error">{pagination.error}</Notice>}
          {(folder ? available.length > visibleCount : cursor) && (
            <button
              className="button small"
              type="button"
              disabled={busy || pagination.busy}
              onClick={loadMore}
            >
              {pagination.busy ? 'Loading more…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </>
  );
}

function MaterialRow({
  kind,
  id,
  busy,
  onRemove,
}: {
  kind: Material['kind'];
  id: string;
  busy: boolean;
  onRemove: () => void;
}) {
  const resource = useResource<Knowledge | Paper>(
    kind === 'knowledge' ? `/knowledge-items/${id}` : `/arxiv/papers/${id}`,
  );
  const title = resource.data?.title ?? (resource.loading ? 'Loading…' : 'Unavailable');
  return (
    <div className="relation-row">
      <div>
        <span className="small-text muted">{kind === 'knowledge' ? 'Knowledge note' : 'Paper'}</span>
        <p>
          {kind === 'knowledge' && resource.data ? (
            <Link href={`/knowledge/${id}`}>{title}</Link>
          ) : resource.data && 'source_url' in resource.data ? (
            <a href={resource.data.source_url} target="_blank" rel="noreferrer">
              {title}
            </a>
          ) : (
            title
          )}
        </p>
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label={`Remove ${kind} link`}
        onClick={onRemove}
        disabled={busy}
      >
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
