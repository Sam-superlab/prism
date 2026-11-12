'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { Entity, Knowledge, Page, Paper, Project, ResearchObject } from '../lib/types';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';

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
    <section className="panel" aria-label="Research connections">
      <div className="panel-heading">
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
        <p className="muted small-text">
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

export function ProjectMaterials({ projectId }: { projectId: string }) {
  const notes = useResource<Page<KnowledgeLink>>(
    `/research/knowledge-links?project_id=${projectId}&limit=500`,
  );
  const papers = useResource<Page<PaperLink>>(`/research/paper-links?project_id=${projectId}&limit=500`);
  const action = useAction(() => {
    notes.reload();
    papers.reload();
  });

  const remove = (kind: Material['kind'], link: ProjectLink) =>
    void action.run(() =>
      api(`/research/${kind}-links/${link.id}`, { method: 'DELETE', version: link.version }),
    );

  return (
    <section className="panel" aria-label="Project materials">
      <div className="panel-heading">
        <h2>Project materials</h2>
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
    </section>
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
