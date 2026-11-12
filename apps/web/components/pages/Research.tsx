'use client';
import Link from 'next/link';
import { useState } from 'react';
import {
  api,
  datetime,
  instantToLocalInput,
  localInputToInstant,
  useAction,
  useResource,
  uuid,
} from '../../lib/api';
import type { Entity, Knowledge, Page, Project, ResearchEvent, ResearchObject, Task } from '../../lib/types';
import { ProjectMaterials } from '../ResearchLinks';
import { Badge, Empty, ErrorState, Field, Icon, Loading, MathContent, Modal, Notice, label } from '../ui';
import { TaskModal } from './Today';

export function ResearchPage({ id }: { id?: string }) {
  const projects = useResource<Page<Project>>('/research/projects?limit=100');
  const [create, setCreate] = useState(false);
  const [filter, setFilter] = useState('active');
  if (id) return <ProjectDetail id={id} />;
  const items = projects.data?.items.filter((x) => filter === 'all' || x.status === filter) || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">RESEARCH WORKSPACE</span>
          <h1>Research</h1>
        </div>
        <button className="button primary" onClick={() => setCreate(true)}>
          <Icon name="plus" size={17} />
          New research project
        </button>
      </div>
      <div className="collection-toolbar">
        <div className="tabs">
          {[
            ['active', 'In progress'],
            ['paused', 'Paused'],
            ['completed', 'Completed'],
            ['all', 'All'],
          ].map(([v, l]) => (
            <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
        </div>
        <span className="muted small-text">{items.length} projects</span>
      </div>
      <ErrorState error={projects.error} retry={projects.reload} />
      {projects.loading && !projects.data && <Loading />}
      {projects.data && items.length === 0 && (
        <div className="panel">
          <Empty
            icon="research"
            title="Every project starts with a question"
            action={
              <button className="button primary" onClick={() => setCreate(true)}>
                Create a research project
              </button>
            }
          >
            Bring questions, proof attempts, experiments, and next steps together.
          </Empty>
        </div>
      )}
      <div className="project-grid">
        {items.map((p) => (
          <Link href={`/research/${p.id}`} className="project-card" key={p.id}>
            <div className="project-card-top">
              <span className="project-monogram">
                <Icon name="research" size={23} />
              </span>
              <Badge tone={p.status === 'completed' ? 'green' : 'blue'}>{label(p.status)}</Badge>
            </div>
            <span className="eyebrow">{p.research_area || 'RESEARCH PROJECT'}</span>
            <h2>{p.title}</h2>
            <p>{p.description || 'No description yet. Add some context for your research question.'}</p>
            <div className="project-card-bottom">
              <span>
                {p.deadline ? `Due ${datetime(p.deadline, true)}` : `Updated ${datetime(p.updated_at, true)}`}
              </span>
              <Icon name="arrow" size={18} />
            </div>
          </Link>
        ))}
      </div>
      {create && (
        <ProjectEditor
          onClose={() => setCreate(false)}
          onSaved={(p) => {
            setCreate(false);
            window.location.href = `/research/${p.id}`;
          }}
        />
      )}
    </>
  );
}
function ProjectDetail({ id }: { id: string }) {
  const project = useResource<Project>(`/research/projects/${id}`);
  const objects = useResource<Page<ResearchObject>>(`/research/projects/${id}/objects?limit=100`);
  const tasks = useResource<Page<Task>>(`/tasks?project_id=${id}&limit=100`);
  const timeline = useResource<Page<ResearchEvent>>(`/research/projects/${id}/timeline?limit=50`);
  const links = useResource<Page<Entity & { research_object_id: string; knowledge_item_id: string }>>(
    '/research/knowledge-links?limit=500',
  );
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [edit, setEdit] = useState(false);
  const [objectEditor, setObjectEditor] = useState<ResearchObject | 'new' | null>(null);
  const [selected, setSelected] = useState<ResearchObject | null>(null);
  const [task, setTask] = useState(false);
  const [taskObject, setTaskObject] = useState<string | undefined>();
  const [tab, setTab] = useState('objects');
  const [knowledgeLink, setKnowledgeLink] = useState<ResearchObject | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const refresh = () => {
    project.reload();
    objects.reload();
    tasks.reload();
    timeline.reload();
    links.reload();
  };
  const action = useAction(refresh);
  if (!project.data)
    return (
      <>
        <ErrorState error={project.error} retry={project.reload} />
        {project.loading && <Loading />}
      </>
    );
  const p = project.data;
  const filteredTasks = tasks.data?.items.filter((t) => t.project_id === id) || [];
  return (
    <>
      <Link href="/research" className="back-link">
        ← All research projects
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <span className="eyebrow">{p.research_area || 'RESEARCH PROJECT'}</span>
          <h1>{p.title}</h1>
          <p>{p.description}</p>
        </div>
        <div className="heading-actions">
          <Badge tone="blue">{label(p.status)}</Badge>
          <button className="button" onClick={() => setEdit(true)}>
            <Icon name="edit" size={16} />
            Edit project
          </button>
          <button
            className="icon-button danger"
            aria-label="Archive project"
            onClick={() => {
              if (
                confirm('Archive this project? Research history and independent knowledge will be preserved.')
              )
                void action.run(async () => {
                  await api(`/research/projects/${id}`, { method: 'DELETE', version: p.version });
                  window.location.href = '/research';
                });
            }}
          >
            <Icon name="trash" size={17} />
          </button>
        </div>
      </div>
      <div className="project-info-strip">
        <span>
          <Icon name="clock" size={15} />
          {p.deadline ? `Due ${datetime(p.deadline)}` : 'No fixed deadline'}
        </span>
        <span>Project importance {p.importance} / 5</span>
        <span>{objects.data?.items.length || 0} research objects</span>
        <span>
          {filteredTasks.filter((t) => t.status === 'completed').length} / {filteredTasks.length} tasks
          completed
        </span>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <div className="detail-columns">
        <div>
          <section className="panel">
            <div className="panel-heading">
              <div className="tabs">
                {[
                  ['objects', 'Research objects'],
                  ['tasks', 'Research tasks'],
                  ['notes', 'Project notes'],
                ].map(([v, l]) => (
                  <button key={v} className={tab === v ? 'active' : ''} onClick={() => setTab(v)}>
                    {l}
                  </button>
                ))}
              </div>
              <button
                className="button small primary"
                onClick={() => {
                  if (tab === 'tasks') {
                    setEditingTask(undefined);
                    setTaskObject(undefined);
                    setTask(true);
                  } else if (tab === 'notes') setEdit(true);
                  else setObjectEditor('new');
                }}
              >
                <Icon name="plus" size={15} />
                {tab === 'tasks' ? 'Add task' : tab === 'notes' ? 'Edit notes' : 'Add object'}
              </button>
            </div>
            {tab === 'objects' && (
              <>
                <div className="panel-filter">
                  <select
                    aria-label="Claim status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="all">All claim statuses</option>
                    {[
                      'needs_verification',
                      'conjecture',
                      'computationally_verified',
                      'proved',
                      'disproved',
                    ].map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </select>
                </div>
                <ErrorState error={objects.error} retry={objects.reload} />
                {objects.data?.items.length === 0 && (
                  <Empty icon="research" title="Start with your first question">
                    Add a conjecture, proof attempt, experiment, or literature note.
                  </Empty>
                )}
                <div className="object-list">
                  {objects.data?.items
                    .filter((o) => statusFilter === 'all' || o.claim_status === statusFilter)
                    .map((o) => (
                      <article className="object-card" key={o.id}>
                        <div className="object-card-top">
                          <Badge tone="blue">{label(o.object_type)}</Badge>
                          <Badge
                            tone={
                              o.claim_status === 'proved'
                                ? 'green'
                                : o.claim_status === 'computationally_verified'
                                  ? 'purple'
                                  : o.claim_status === 'disproved'
                                    ? 'peach'
                                    : ''
                            }
                          >
                            {label(o.claim_status)}
                          </Badge>
                        </div>
                        <button className="object-title" onClick={() => setSelected(o)}>
                          {o.title}
                          <Icon name="arrow" size={17} />
                        </button>
                        <MathContent content={o.content.slice(0, 350)} className="object-excerpt" />
                        <div className="object-card-bottom">
                          <span>{datetime(o.updated_at, true)}</span>
                          <div className="inline-actions">
                            <button
                              className="text-link"
                              onClick={() => {
                                setEditingTask(undefined);
                                setTaskObject(o.id);
                                setTask(true);
                              }}
                            >
                              Create task
                            </button>
                            <button
                              className="icon-button"
                              aria-label="Edit research object"
                              onClick={() => setObjectEditor(o)}
                            >
                              <Icon name="edit" size={15} />
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                </div>
              </>
            )}
            {tab === 'tasks' && (
              <>
                <ErrorState error={tasks.error} retry={tasks.reload} />
                {filteredTasks.length === 0 ? (
                  <Empty icon="planner" title="Choose the next step for your research">
                    Tasks are available to the daily planner automatically.
                  </Empty>
                ) : (
                  <div className="research-task-list">
                    {filteredTasks.map((t) => (
                      <div className={`research-task ${t.status === 'completed' ? 'done' : ''}`} key={t.id}>
                        <button
                          className={`task-check ${t.status === 'completed' ? 'checked' : ''}`}
                          aria-label={`Complete ${t.title}`}
                          disabled={t.status === 'completed' || action.busy}
                          onClick={() =>
                            void action.run(() =>
                              api(`/tasks/${t.id}/complete`, {
                                method: 'POST',
                                version: t.version,
                                body: { completed_at: new Date().toISOString() },
                              }),
                            )
                          }
                        >
                          {t.status === 'completed' && <Icon name="check" size={13} />}
                        </button>
                        <div>
                          <h3>
                            <button
                              className="task-title-button"
                              onClick={() => {
                                setEditingTask(t);
                                setTask(true);
                              }}
                            >
                              {t.title}
                            </button>
                          </h3>
                          <p>{t.description}</p>
                          <div className="task-meta">
                            <Badge>{label(t.status)}</Badge>
                            <span>{t.estimated_minutes} min</span>
                            {t.due_at && <span>{datetime(t.due_at, true)}</span>}
                          </div>
                        </div>
                        <select
                          aria-label={`Status for ${t.title}`}
                          value={t.status}
                          disabled={t.status === 'completed'}
                          onChange={(e) =>
                            void action.run(() =>
                              api(`/tasks/${t.id}`, {
                                method: 'PATCH',
                                version: t.version,
                                body: { status: e.target.value },
                              }),
                            )
                          }
                        >
                          {['backlog', 'ready', 'in_progress', 'blocked', 'archived'].map((s) => (
                            <option key={s} value={s}>
                              {label(s)}
                            </option>
                          ))}
                          {t.status === 'completed' && <option value="completed">Completed</option>}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {tab === 'notes' && (
              <div className="content-panel">
                <MathContent
                  content={
                    p.notes || 'No project notes yet. Keep context, ideas, and reference locations here.'
                  }
                />
                {p.source_code_locations.length > 0 && (
                  <div className="source-reference">
                    <Icon name="external" size={15} />
                    <span>{p.source_code_locations.join('\n')}</span>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
        <aside>
          <ProjectMaterials projectId={id} />
          <section className="panel timeline-panel">
            <div className="panel-heading">
              <h2>Research timeline</h2>
              <Badge>{timeline.data?.items.length || 0}</Badge>
            </div>
            <ErrorState error={timeline.error} retry={timeline.reload} />
            {timeline.data?.items.length === 0 && (
              <p className="panel-description muted">Meaningful changes are recorded here automatically.</p>
            )}
            <div className="timeline">
              {timeline.data?.items.map((e) => (
                <article key={e.id}>
                  <span className="timeline-dot" />
                  <small>{datetime(e.created_at)}</small>
                  <h4>{eventLabel(e.event_type)}</h4>
                  <p>
                    {String(
                      e.event_payload.title ||
                        e.event_payload.new_status ||
                        e.event_payload.claim_status ||
                        e.event_payload.to ||
                        '',
                    )}
                  </p>
                </article>
              ))}
            </div>
          </section>
          <div className="quiet-card small">
            <span className="eyebrow">MATHEMATICAL RIGOR</span>
            <p>
              Evidence has a scope.
              <br />
              Proofs have a source.
            </p>
            <small>Claim statuses record your judgment, rather than formal certification.</small>
          </div>
        </aside>
      </div>
      {edit && (
        <ProjectEditor
          project={p}
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            refresh();
          }}
        />
      )}{' '}
      {objectEditor && (
        <ObjectEditor
          projectId={id}
          object={objectEditor === 'new' ? undefined : objectEditor}
          onClose={() => setObjectEditor(null)}
          onSaved={() => {
            setObjectEditor(null);
            setSelected(null);
            refresh();
          }}
        />
      )}{' '}
      {task && (
        <TaskModal
          task={editingTask}
          projectId={id}
          objectId={taskObject}
          onClose={() => setTask(false)}
          onSaved={() => {
            setTask(false);
            refresh();
          }}
        />
      )}
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)} wide>
          <div className="inline-actions">
            <Badge tone="blue">{label(selected.object_type)}</Badge>
            <Badge tone={selected.claim_status === 'proved' ? 'green' : 'purple'}>
              {label(selected.claim_status)}
            </Badge>
          </div>
          <div className="object-detail-content">
            <MathContent content={selected.content} />
            {selected.proof_content && (
              <>
                <h3>Proof / Explanation</h3>
                <MathContent content={selected.proof_content} />
              </>
            )}
            {Object.keys(selected.evidence_metadata).length > 0 && (
              <div className="evidence-box">
                <h3>Computational evidence and scope</h3>
                <p>
                  <strong>Scope</strong> {String(selected.evidence_metadata.scope || '')}
                </p>
                <p>
                  <strong>Result</strong> {String(selected.evidence_metadata.result || '')}
                </p>
              </div>
            )}
            {selected.evidence_reference && (
              <p className="source-reference">Evidence reference: {selected.evidence_reference}</p>
            )}
          </div>
          <h3 className="section-small-title">Related knowledge</h3>
          {links.data?.items
            .filter((l) => l.research_object_id === selected.id)
            .map((l) => (
              <div className="relation-row" key={l.id}>
                <Link className="text-link" href={`/knowledge/${l.knowledge_item_id}`}>
                  Open knowledge item ↗
                </Link>
                <button
                  className="icon-button"
                  aria-label="Remove knowledge link"
                  onClick={() =>
                    void action.run(() =>
                      api(`/research/knowledge-links/${l.id}`, { method: 'DELETE', version: l.version }),
                    )
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          <div className="modal-footer">
            <button className="button small" onClick={() => setKnowledgeLink(selected)}>
              Related knowledge
            </button>
            <button
              className="button small danger"
              onClick={() => {
                if (confirm('Archive this research object? Its audit history will be preserved.'))
                  void action.run(async () => {
                    await api(`/research/objects/${selected.id}`, {
                      method: 'DELETE',
                      version: selected.version,
                    });
                    setSelected(null);
                  });
              }}
            >
              Archive object
            </button>
            <button
              className="button primary"
              onClick={() => {
                setObjectEditor(selected);
                setSelected(null);
              }}
            >
              Edit object
            </button>
          </div>
        </Modal>
      )}
      {knowledgeLink && (
        <KnowledgeLinkModal
          object={knowledgeLink}
          onClose={() => setKnowledgeLink(null)}
          onSaved={() => {
            setKnowledgeLink(null);
            links.reload();
          }}
        />
      )}
    </>
  );
}
function ProjectEditor({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(project?.title || '');
  const [description, setDescription] = useState(project?.description || '');
  const [area, setArea] = useState(project?.research_area || '');
  const [status, setStatus] = useState(project?.status || 'active');
  const [importance, setImportance] = useState(String(project?.importance ?? 3));
  const [deadline, setDeadline] = useState(instantToLocalInput(project?.deadline));
  const [deadlineChanged, setDeadlineChanged] = useState(false);
  const [notes, setNotes] = useState(project?.notes || '');
  const [code, setCode] = useState(project?.source_code_locations.join('\n') || '');
  const action = useAction();
  return (
    <Modal title={project ? 'Edit research project' : 'New research project'} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const p = await api<Project>(
              project ? `/research/projects/${project.id}` : '/research/projects',
              {
                method: project ? 'PATCH' : 'POST',
                version: project?.version,
                body: {
                  ...(project ? {} : { id: creationId }),
                  title,
                  description,
                  research_area: area,
                  status,
                  importance: Number(importance),
                  ...(!project || deadlineChanged
                    ? { deadline: deadline ? localInputToInstant(deadline) : null }
                    : {}),
                  notes,
                  source_code_locations: code
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              },
            );
            onSaved(p);
          });
        }}
      >
        <Field label="Project title">
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="For example: A study of graded rings"
          />
        </Field>
        <Field label="Background and objectives">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Research area">
            <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Commutative Algebra" />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {['active', 'paused', 'completed', 'archived'].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Importance">
            <input
              type="number"
              min="1"
              max="5"
              required
              value={importance}
              onChange={(e) => setImportance(e.target.value)}
            />
          </Field>
          <Field label="Deadline (optional)">
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value);
                setDeadlineChanged(true);
              }}
            />
          </Field>
        </div>
        <Field label="Project notes">
          <textarea
            rows={5}
            className="code-editor"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <Field label="Code locations (one per line)">
          <textarea
            rows={2}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Git repository URL or local path"
          />
        </Field>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            Save project
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ObjectEditor({
  projectId,
  object,
  onClose,
  onSaved,
}: {
  projectId: string;
  object?: ResearchObject;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(object?.title || '');
  const [type, setType] = useState(object?.object_type || 'question');
  const [content, setContent] = useState(object?.content || '');
  const [claim, setClaim] = useState(object?.claim_status || 'needs_verification');
  const [proof, setProof] = useState(object?.proof_content || '');
  const [reference, setReference] = useState(object?.evidence_reference || '');
  const [scope, setScope] = useState(String(object?.evidence_metadata.scope || ''));
  const [result, setResult] = useState(String(object?.evidence_metadata.result || ''));
  const [preview, setPreview] = useState(false);
  const action = useAction(onSaved);
  return (
    <Modal title={object ? 'Edit research object' : 'Add research object'} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (claim === 'proved' && !proof.trim() && !reference.trim()) {
            action.setError('A proved claim requires proof text or a reference.');
            return;
          }
          void action.run(() =>
            api(object ? `/research/objects/${object.id}` : `/research/projects/${projectId}/objects`, {
              method: object ? 'PATCH' : 'POST',
              version: object?.version,
              body: {
                ...(object ? { base_snapshot: object } : { id: creationId }),
                title,
                object_type: type,
                content,
                claim_status: claim,
                proof_content: proof || null,
                evidence_reference: reference || null,
                evidence_metadata: {
                  ...(object?.evidence_metadata || {}),
                  ...(scope ? { scope } : {}),
                  ...(result ? { result } : {}),
                },
              },
            }),
          );
        }}
      >
        <div className="form-grid">
          <Field label="Title">
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Object type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {[
                'question',
                'conjecture',
                'theorem',
                'lemma',
                'proof_attempt',
                'counterexample',
                'experiment',
                'observation',
                'literature_note',
              ].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="editor-toolbar">
          <span>MATHEMATICAL CONTENT</span>
          <button type="button" className="text-link" onClick={() => setPreview(!preview)}>
            {preview ? 'Edit' : 'Rendered preview'}
          </button>
        </div>
        {preview ? (
          <div className="math-preview">
            <MathContent content={content} />
          </div>
        ) : (
          <Field label="Content">
            <textarea
              required
              className="code-editor"
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
        )}
        <Field label="Mathematical claim status">
          <select value={claim} onChange={(e) => setClaim(e.target.value)}>
            {['needs_verification', 'conjecture', 'computationally_verified', 'proved', 'disproved'].map(
              (x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ),
            )}
          </select>
        </Field>
        {claim === 'computationally_verified' && (
          <div className="form-grid">
            <Field label="Verification scope">
              <textarea
                required
                rows={3}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="Parameter range, samples, algorithm, and code version"
              />
            </Field>
            <Field label="Results / evidence">
              <textarea
                required
                rows={3}
                value={result}
                onChange={(e) => setResult(e.target.value)}
                placeholder="Record the results and their limitations"
              />
            </Field>
          </div>
        )}
        <Field label="Proof text / proof attempt">
          <textarea
            rows={5}
            className="code-editor"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
          />
        </Field>
        <Field label="Proof or evidence reference">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Literature, code, logs, or proof location"
          />
        </Field>
        <Notice>
          Claim status changes enter the project timeline. Computational evidence does not establish a general
          proof.
        </Notice>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            Save research object
          </button>
        </div>
      </form>
    </Modal>
  );
}
function KnowledgeLinkModal({
  object,
  onClose,
  onSaved,
}: {
  object: ResearchObject;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const items = useResource<Page<Knowledge>>('/knowledge-items?limit=500');
  const [selected, setSelected] = useState('');
  const a = useAction(onSaved);
  return (
    <Modal title="Link to knowledge" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api('/research/knowledge-links', {
              method: 'POST',
              body: { id: creationId, research_object_id: object.id, knowledge_item_id: selected },
            }),
          );
        }}
      >
        <Field label="Knowledge item">
          <select required value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="">Choose knowledge</option>
            {items.data?.items.map((x) => (
              <option value={x.id} key={x.id}>
                {x.title}
              </option>
            ))}
          </select>
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Create link
          </button>
        </div>
      </form>
    </Modal>
  );
}
function eventLabel(value: string) {
  const m: Record<string, string> = {
    project_created: 'Project created',
    object_created: 'Research object added',
    object_updated: 'Research object updated',
    claim_status_changed: 'Claim status changed',
    task_completed: 'Research task completed',
    project_updated: 'Project updated',
    object_deleted: 'Research object archived',
  };
  return m[value] || value.replaceAll('_', ' ');
}
