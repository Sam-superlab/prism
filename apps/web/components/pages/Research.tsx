'use client';
import { MarkdownEditor } from '../MarkdownEditor';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  datetime,
  instantToLocalInput,
  localInputToInstant,
  useAction,
  useResource,
  uuid,
} from '../../lib/api';
import type { Entity, Knowledge, Page, Project, ResearchObject, Task } from '../../lib/types';
import type { GuideLanguage } from '../../lib/getting-started-copy';
import { researchQuestionHref, researchQuestionStatusLabels, type ResearchQuestionSource } from '../../lib/research-question-links';
import { ConnectionGraph } from '../ConnectionGraph';
import { ModuleGuide, ModuleGuideHint, useModuleGuide, type ModuleGuideState } from '../ModuleGuide';
import { ProjectMaterials } from '../ResearchLinks';
import { ResearchActivity } from '../ResearchActivity';
import { CitationField, ResearchMarkdown, ResearchReferences, useProjectBibliography } from '../ResearchReferences';
import type { BibliographyItem } from '../../lib/bibliography';
import { Badge, Empty, ErrorState, Field, Icon, Loading, MathContent, Modal, Notice, label } from '../ui';
import { TaskModal } from './Today';
import { ResearchQuestionPage, ResearchRecordOrigins } from './ResearchQuestion';
import { ResearchObjectEditor } from './ResearchObjectEditor';
import questionStyles from './ResearchQuestion.module.css';

export function ResearchPage({
  id,
  selectedObjectId,
  questionId,
  source,
  startQuestion,
  guideUserId,
  guideLanguage,
}: {
  id?: string;
  selectedObjectId?: string;
  questionId?: string;
  source?: ResearchQuestionSource;
  startQuestion?: boolean;
  guideUserId?: string;
  guideLanguage?: GuideLanguage;
}) {
  const router = useRouter();
  const projects = useResource<Page<Project>>(id ? null : '/research/projects?limit=100');
  const [create, setCreate] = useState<'regular' | 'guided'>();
  const [filter, setFilter] = useState('active');
  const guide = useModuleGuide('research', guideUserId, guideLanguage);
  if (id && questionId) return <ResearchQuestionPage projectId={id} questionId={questionId} source={source} />;
  if (id) return <ProjectDetail id={id} selectedObjectId={selectedObjectId} draftSource={startQuestion ? source : undefined}
    userId={guideUserId} guide={guide} />;
  const items = projects.data?.items.filter((x) => filter === 'all' || x.status === filter) || [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">RESEARCH WORKSPACE</span>
          <h1>Research</h1>
        </div>
        <div className="inline-actions">
          <button className="button primary" onClick={() => setCreate('regular')}>
            <Icon name="plus" size={17} />
            New research project
          </button>
        </div>
      </div>
      <ModuleGuide
        guide={guide}
        continuation={guide.progress?.itemId ? 'research' : undefined}
        href={guide.progress?.itemId ? `/research/${guide.progress.itemId}` : undefined}
        action={() => setCreate('guided')}
      />
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
              <button className="button primary" onClick={() => setCreate('regular')}>
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
            <ResearchMarkdown content={p.description || 'No description yet. Add some context for your research question.'} references={[]} />
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
          guideHint={
            create === 'guided' && (
              <ModuleGuideHint guide={guide}>{guide.copy.editor.research}</ModuleGuideHint>
            )
          }
          onClose={() => setCreate(undefined)}
          onSaved={(p) => {
            if (create === 'guided' || !guide.progress?.itemId) guide.continueWith(p.id);
            setCreate(undefined);
            router.push(`/research/${p.id}`);
          }}
        />
      )}
    </>
  );
}
function ProjectDetail({
  id,
  selectedObjectId,
  draftSource,
  userId,
  guide,
}: {
  id: string;
  selectedObjectId?: string;
  draftSource?: ResearchQuestionSource;
  userId?: string;
  guide: ModuleGuideState;
}) {
  const router = useRouter();
  const bibliography = useProjectBibliography(id);
  const references = bibliography.data?.items ?? [];
  const project = useResource<Project>(`/research/projects/${id}`);
  const objects = useResource<Page<ResearchObject>>(`/research/projects/${id}/objects?limit=100`);
  const questions = useResource<Page<ResearchObject>>(`/research/projects/${id}/objects?object_type=question&limit=100`);
  const tasks = useResource<Page<Task>>(`/tasks?project_id=${id}&limit=100`);
  const links = useResource<Page<Entity & { research_object_id: string; knowledge_item_id: string }>>(
    '/research/knowledge-links?limit=500',
  );
  const [editingTask, setEditingTask] = useState<Task | undefined>();
  const [edit, setEdit] = useState(false);
  const [objectEditor, setObjectEditor] = useState<ResearchObject | 'new' | 'question' | null>(null);
  const [closedDraft, setClosedDraft] = useState<string>();
  const [selected, setSelected] = useState<ResearchObject | null>(null);
  const selectedObject = useResource<ResearchObject>(
    selectedObjectId ? `/research/objects/${selectedObjectId}` : null,
  ).data;
  useEffect(() => {
    if (!selectedObjectId) setSelected(null);
    else if (selectedObject?.id === selectedObjectId && selectedObject.project_id === id) {
      if (selectedObject.object_type === 'question') {
        setSelected(null);
        router.replace(researchQuestionHref(id, selectedObject.id), { scroll: false });
      } else setSelected(selectedObject);
    }
  }, [id, selectedObjectId, selectedObject, router]);
  const [task, setTask] = useState(false);
  const [taskObject, setTaskObject] = useState<string | undefined>();
  const [tab, setTab] = useState('objects');
  const [knowledgeLink, setKnowledgeLink] = useState<ResearchObject | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [materialPicker, setMaterialPicker] = useState<'knowledge' | 'paper' | null>(null);
  const draftKey = draftSource ? `${draftSource.referenceId}/${draftSource.pdfId}/${draftSource.page}` : undefined;
  const activeDraft = draftSource && draftKey !== closedDraft ? draftSource : undefined;
  const activeObjectEditor = objectEditor ?? (activeDraft ? 'question' : null);
  function dismissObjectEditor() {
    setObjectEditor(null);
    if (activeDraft) {
      setClosedDraft(draftKey);
      router.replace(`/research/${id}`, { scroll: false });
    }
  }
  function closeSelected() {
    setSelected(null);
    const url = new URL(window.location.href);
    if (!url.searchParams.has('object')) return;
    url.searchParams.delete('object');
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }
  const refresh = () => {
    project.reload();
    objects.reload();
    questions.reload();
    tasks.reload();
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
          <ResearchMarkdown content={p.description} references={references} />
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
                  router.push('/research');
                });
            }}
          >
            <Icon name="trash" size={17} />
          </button>
        </div>
      </div>
      {guide.progress?.itemId === id && (
        <ModuleGuide guide={guide} continuation="research" action={() => setMaterialPicker('knowledge')} />
      )}
      {guide.progress && !guide.progress.itemId && guide.progress.status !== 'completed' && (
        <ModuleGuide guide={guide} href="/research" />
      )}
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
      <section className={`panel ${questionStyles.projectQuestions}`} aria-label="Research questions">
        <div className="panel-heading">
          <h2>Research questions</h2>
          <button className="button small primary" type="button" onClick={() => setObjectEditor('question')}>
            <Icon name="plus" size={15} /> New question
          </button>
        </div>
        <div className={questionStyles.panelBody}>
          <ErrorState error={questions.error} retry={questions.reload} />
          {questions.loading && !questions.data && <Loading />}
          {questions.data?.items.length === 0 && <p className={questionStyles.empty}>Start with the question you want to investigate.</p>}
          {!!questions.data?.items.length && <ul className={questionStyles.links}>
            {questions.data.items.map((question) => <li key={question.id}>
              <Link href={researchQuestionHref(id, question.id)} className={`text-link ${questionStyles.linkTitle}`}>
                <span>{question.title}</span><Icon name="arrow" size={15} />
              </Link>
              <Badge tone={question.question_status === 'resolved' ? 'green' : 'blue'}>
                {researchQuestionStatusLabels[question.question_status ?? 'open']}
              </Badge>
            </li>)}
          </ul>}
        </div>
      </section>
      <ResearchActivity projectId={id} />
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
                {objects.data && !objects.data.items.some((object) => object.object_type !== 'question') && (
                  <Empty icon="research" title="Start with your first question">
                    Add a conjecture, proof attempt, experiment, or literature note.
                  </Empty>
                )}
                <div className="object-list">
                  {objects.data?.items
                    .filter((o) => o.object_type !== 'question' && (statusFilter === 'all' || o.claim_status === statusFilter))
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
                          <ResearchMarkdown content={t.description} references={references} />
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
                <ResearchMarkdown
                  content={
                    p.notes || 'No project notes yet. Keep context, ideas, and reference locations here.'
                  }
                  references={references}
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
        <aside className={questionStyles.projectSidebar}>
          <ProjectMaterials
            projectId={id}
            userId={userId}
            onPaperLinksChanged={bibliography.reload}
            pickerOpen={!!materialPicker}
            pickerKind={materialPicker ?? undefined}
            onOpenPicker={() => setMaterialPicker('knowledge')}
            onClosePicker={() => setMaterialPicker(null)}
            guideHint={
              guide.progress?.itemId === id && (
                <ModuleGuideHint guide={guide}>{guide.copy.next.research}</ModuleGuideHint>
              )
            }
            onLinked={() => {
              if (guide.progress?.itemId === id) guide.finish();
              setMaterialPicker(null);
            }}
          />
          <ResearchReferences
            projectId={id}
            bibliography={bibliography}
            onAddPaper={() => setMaterialPicker('paper')}
          />
          <ConnectionGraph focus={`project:${id}`} />
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
          references={references}
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            refresh();
          }}
        />
      )}{' '}
      {activeObjectEditor && (
        <ResearchObjectEditor
          key={activeDraft ? draftKey : typeof activeObjectEditor === 'string' ? activeObjectEditor : activeObjectEditor.id}
          projectId={id}
          references={references}
          object={typeof activeObjectEditor === 'string' ? undefined : activeObjectEditor}
          types={activeObjectEditor === 'question' ? ['question'] : undefined}
          title={activeObjectEditor === 'question' ? 'New research question' : undefined}
          onCommit={activeDraft ? async (question, linkId) => {
            await api('/research/question-links', { method: 'POST', body: {
              id: linkId, question_id: question.id, relation_type: 'motivates',
              reference_id: activeDraft.referenceId, attachment_id: activeDraft.pdfId, page: activeDraft.page,
            } });
          } : undefined}
          onClose={dismissObjectEditor}
          onSaved={(object) => {
            setObjectEditor(null);
            setSelected(null);
            refresh();
            if (object.object_type === 'question')
              router.push(researchQuestionHref(id, object.id));
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
      {selected && selected.object_type !== 'question' && (
        <Modal title={selected.title} onClose={closeSelected} wide>
          <div className="inline-actions">
            <Badge tone="blue">{label(selected.object_type)}</Badge>
            <Badge tone={selected.claim_status === 'proved' ? 'green' : 'purple'}>
              {label(selected.claim_status)}
            </Badge>
          </div>
          <div className="object-detail-content">
            <ResearchMarkdown content={selected.content} references={references} />
            {selected.proof_content && (
              <>
                <h3>Proof / Explanation</h3>
                <ResearchMarkdown content={selected.proof_content} references={references} />
              </>
            )}
            {Object.keys(selected.evidence_metadata).length > 0 && (
              <div className="evidence-box">
                <h3>Computational evidence and scope</h3>
                <strong>Scope</strong>
                <ResearchMarkdown content={String(selected.evidence_metadata.scope || '')} references={references} />
                <strong>Result</strong>
                <ResearchMarkdown content={String(selected.evidence_metadata.result || '')} references={references} />
              </div>
            )}
            {selected.evidence_reference && (
              <p className="source-reference">Evidence reference: {selected.evidence_reference}</p>
            )}
          </div>
          <ResearchRecordOrigins record={selected} />
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
          <ConnectionGraph key={selected.id} focus={`research:${selected.id}`} inset />
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
                    closeSelected();
                  });
              }}
            >
              Archive object
            </button>
            <button
              className="button primary"
              onClick={() => {
                setObjectEditor(selected);
                closeSelected();
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
  guideHint,
  references = [],
  onClose,
  onSaved,
}: {
  project?: Project;
  guideHint?: ReactNode;
  references?: BibliographyItem[];
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
      {guideHint}
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
            placeholder="For example: Strong Persistence Property"
          />
        </Field>
        <MarkdownEditor label="Background and objectives" rows={3} value={description} onChange={setDescription} />
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
        <CitationField label="Project notes" rows={5} value={notes} onChange={setNotes} references={references} />
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
