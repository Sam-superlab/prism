'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, datetime, todayDate, useAction, useResource, uuid } from '../../lib/api';
import type { BibliographyItem } from '../../lib/bibliography';
import { literaturePdfHref } from '../../lib/literature-pdf-notes';
import { pdfIndexPath, type LiteraturePdfIndex } from '../../lib/literature-pdf-index';
import type { LiteratureAttachment } from '../../lib/literature-pdfs';
import {
  investigationRelations,
  researchQuestionHref,
  researchQuestionStatusLabels,
  resultRelations,
  sourceRelations,
  type QuestionRelation,
  type ResearchQuestionLink,
  type ResearchQuestionSource,
} from '../../lib/research-question-links';
import type { Page, Project, ResearchObject, Task } from '../../lib/types';
import { ConnectionGraph } from '../ConnectionGraph';
import { ResearchSidebarPanel, visibleCount } from '../ResearchSidebarPanel';
import { ResearchMarkdown, useProjectBibliography } from '../ResearchReferences';
import { Badge, ErrorState, Field, Icon, Loading, Modal, Notice, label } from '../ui';
import { ResearchObjectEditor } from './ResearchObjectEditor';
import { TaskModal } from './Today';
import styles from './ResearchQuestion.module.css';

type SourceRelation = keyof typeof sourceRelations;
type RecordRelation = keyof typeof investigationRelations | keyof typeof resultRelations;
const recordTypes: Record<RecordRelation, readonly string[]> = {
  attempt: ['proof_attempt'],
  experiment: ['experiment'],
  conjecture: ['conjecture'],
  result: ['observation', 'lemma', 'theorem'],
  counterexample: ['counterexample'],
};
const allRelations = { ...sourceRelations, ...investigationRelations, ...resultRelations };
type Section = 'sources' | 'investigation' | 'results';
type Editor =
  | { kind: 'question' }
  | { kind: 'sources'; prefill?: ResearchQuestionSource }
  | { kind: 'investigation' | 'results' }
  | { kind: 'record'; relation: RecordRelation };

function sourceHref(link: ResearchQuestionLink) {
  if (!link.reference_id) return undefined;
  return link.attachment_id
    ? literaturePdfHref(link.reference_id, link.attachment_id, link.page ?? undefined)
    : `/research/library?reference=${link.reference_id}`;
}

function SectionPanel({ title, children, action }: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const id = useId();
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-heading">
        <h2 id={id}>{title}</h2>
        {action}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </section>
  );
}

function QuestionLinks({ items, empty, onRemove, busy }: {
  items: ResearchQuestionLink[];
  empty: string;
  onRemove: (link: ResearchQuestionLink) => void;
  busy: boolean;
}) {
  if (!items.length) return <p className={styles.empty}>{empty}</p>;
  return (
    <ul className={styles.links}>
      {items.map((link) => {
        const href = link.research_object_id
          ? `/research/${link.project_id}?object=${link.research_object_id}`
          : sourceHref(link);
        return <li key={link.id}>
          <div className={styles.linkContent}>
            {href ? <Link href={href} className={`text-link ${styles.linkTitle}`}>
              <span>{link.target_title}{link.page ? ` · PDF page ${link.page}` : ''}</span>
              <Icon name="arrow" size={15} />
            </Link> : <strong>{link.target_title}</strong>}
            <div className={styles.linkMeta}>
              <span>{allRelations[link.relation_type]}</span>
              {link.target_claim_status && <Badge tone={link.target_claim_status === 'proved' ? 'green' : ''}>
                {label(link.target_claim_status)}
              </Badge>}
            </div>
            {link.notes && <p className={styles.note}>{link.notes}</p>}
          </div>
          <button className="icon-button" type="button" title="Remove link"
            aria-label={`Remove link to ${link.target_title}`} disabled={busy} onClick={() => onRemove(link)}>
            <Icon name="close" size={17} />
          </button>
        </li>;
      })}
    </ul>
  );
}

export function ResearchQuestionPage({ projectId, questionId, source }: {
  projectId: string;
  questionId: string;
  source?: ResearchQuestionSource;
}) {
  const router = useRouter();
  const question = useResource<ResearchObject>(`/research/objects/${questionId}`);
  const project = useResource<Project>(`/research/projects/${projectId}`);
  const bibliography = useProjectBibliography(projectId);
  const linksPath = `/research/question-links?question_id=${questionId}&limit=100`;
  const links = useResource<Page<ResearchQuestionLink>>(linksPath);
  const tasks = useResource<Page<Task>>(`/tasks?research_object_id=${questionId}&limit=100`);
  const [editor, setEditor] = useState<Editor>();
  const [editingTask, setEditingTask] = useState<Task | 'new'>();
  const [sourceRequest, setSourceRequest] = useState<string>();
  const [notice, setNotice] = useState('');
  const [showGraph, setShowGraph] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const linkAction = useAction(links.reload);
  const moreAction = useAction();
  const taskAction = useAction(tasks.reload);
  const sourceKey = source ? `${source.referenceId}/${source.pdfId}/${source.page}` : undefined;
  const prefilled = sourceKey !== undefined && sourceKey !== sourceRequest;
  const activeEditor = editor ?? (prefilled ? { kind: 'sources' as const, prefill: source } : undefined);
  useEffect(() => {
    window.addEventListener('prism:tasks-changed', tasks.reload);
    return () => window.removeEventListener('prism:tasks-changed', tasks.reload);
  }, [tasks.reload]);
  function closeEditor() {
    setEditor(undefined);
    if (prefilled) {
      setSourceRequest(sourceKey);
      router.replace(researchQuestionHref(projectId, questionId), { scroll: false });
    }
  }
  const ready = question.data?.project_id === projectId && question.data.object_type === 'question' ? question.data : null;
  if (question.loading && !question.data || project.loading && !project.data) return <Loading />;
  if (question.error || project.error) return <ErrorState error={question.error || project.error} retry={() => {
    question.reload();
    project.reload();
  }} />;
  if (!ready || !project.data) return <Notice tone="error">This research question is unavailable in this project.</Notice>;

  const items = links.data?.items ?? [];
  const attachments = items.filter((link) => link.reference_id);
  const investigations = items.filter((link) => link.relation_type in investigationRelations);
  const results = items.filter((link) => link.relation_type in resultRelations);
  const questionTasks = (tasks.data?.items ?? []).filter((task) =>
    task.research_object_id === questionId && task.status !== 'archived',
  );
  const references = bibliography.data?.items ?? [];
  const actionButton = (title: string, kind: Section) => (
    <button type="button" className="button small" onClick={() => setEditor({ kind })}>
      <Icon name="plus" size={15} />
      {title}
    </button>
  );
  const remove = (link: ResearchQuestionLink) => void linkAction.run(() =>
    api(`/research/question-links/${link.id}`, { method: 'DELETE', version: link.version }),
  );
  return (
    <>
      <Link href={`/research/${projectId}`} className="back-link">← {project.data.title}</Link>
      <div className="page-heading detail-heading">
        <div className={styles.heading}>
          <span className="eyebrow">RESEARCH QUESTION</span>
          <h1>{ready.title}</h1>
        </div>
        <div className={`heading-actions ${styles.editQuestion}`}>
          <Badge tone={ready.question_status === 'resolved' ? 'green' : 'blue'}>
            {researchQuestionStatusLabels[ready.question_status ?? 'open']}
          </Badge>
          <button type="button" className="button" onClick={() => setEditor({ kind: 'question' })}>
            <Icon name="edit" size={16} /> Edit question
          </button>
        </div>
      </div>
      {notice && <p className="muted small-text" role="status">{notice}</p>}
      <ErrorState error={links.error} retry={links.reload} />
      {linkAction.error && <Notice tone="error">{linkAction.error}</Notice>}
      {taskAction.error && <Notice tone="error">{taskAction.error}</Notice>}
      <div className={styles.layout}>
        <div className={styles.column}>
          <SectionPanel title="Question">
            <ResearchMarkdown content={ready.content} references={references} />
          </SectionPanel>
          <SectionPanel title="Investigation" action={actionButton('Link investigation', 'investigation')}>
            {links.loading && !links.data ? <Loading /> : <QuestionLinks items={investigations}
              empty="Link a proof attempt, a computational experiment, or a conjecture." onRemove={remove} busy={linkAction.busy} />}
          </SectionPanel>
          <SectionPanel title="Results" action={actionButton('Link result', 'results')}>
            {links.loading && !links.data ? <Loading /> : <QuestionLinks items={results}
              empty="Link a result or counterexample that addresses this question." onRemove={remove} busy={linkAction.busy} />}
          </SectionPanel>
        </div>
        <div className={styles.column}>
          <ResearchSidebarPanel title="Sources"
            count={links.data ? visibleCount(attachments.length, Boolean(links.data.next_cursor)) : undefined}
            open={showSources} onToggle={setShowSources} action={actionButton('Add source', 'sources')}>
            {links.loading && !links.data ? <Loading /> : <QuestionLinks items={attachments}
              empty="Add a Library reference or a specific page of its PDF." onRemove={remove} busy={linkAction.busy} />}
          </ResearchSidebarPanel>
          <ResearchSidebarPanel title="Next actions"
            count={tasks.data ? visibleCount(questionTasks.length, Boolean(tasks.data.next_cursor)) : undefined}
            open={showActions} onToggle={setShowActions}
            action={<button type="button" className="button small primary" onClick={() => setEditingTask('new')}>
              <Icon name="plus" size={15} /> Add next action
            </button>}>
            <ErrorState error={tasks.error} retry={tasks.reload} />
            {tasks.loading && !tasks.data ? <Loading /> : questionTasks.length === 0
              ? <p className={styles.empty}>Add a next action to continue this question from Dashboard.</p>
              : <>
                <ul className={styles.links}>
                  {questionTasks.map((task) => <li key={task.id}>
                    {task.status !== 'completed' && <button type="button" className="task-check"
                      aria-label={`Complete ${task.title}`} disabled={taskAction.busy} onClick={() => void taskAction.run(async () => {
                        await api(`/tasks/${task.id}/complete`, {
                          method: 'POST', version: task.version, body: { completed_at: new Date().toISOString() },
                        });
                        window.dispatchEvent(new Event('prism:tasks-changed'));
                      })}>
                      <Icon name="check" size={14} />
                    </button>}
                    <div className={styles.linkContent}>
                      <button type="button" className={`text-link ${styles.taskHeading}`} onClick={() => setEditingTask(task)}>{task.title}</button>
                      <div className={styles.linkMeta}>
                        <span>{label(task.status)}</span>
                        {task.planned_date && <span>{task.planned_date === todayDate() ? 'Planned today' : `Planned ${task.planned_date}`}</span>}
                        {task.due_at && <span>Due {datetime(task.due_at, true)}</span>}
                      </div>
                    </div>
                  </li>)}
                </ul>
                <Link href="/today" className="text-link">Open Dashboard</Link>
              </>}
          </ResearchSidebarPanel>
        </div>
      </div>
      {links.data?.next_cursor && (
        <button className="button" type="button" disabled={moreAction.busy} onClick={() => void moreAction.run(async () => {
          const cursor = links.data?.next_cursor;
          if (!cursor) return;
          const next = await api<Page<ResearchQuestionLink>>(`${linksPath}&cursor=${encodeURIComponent(cursor)}`);
          links.setData((current) => current && current.next_cursor === cursor
            ? { items: [...current.items, ...next.items], next_cursor: next.next_cursor }
            : current);
        })}>Load more links</button>
      )}
      {moreAction.error && <Notice tone="error">{moreAction.error}</Notice>}
      <details className={`panel ${styles.graph}`} onToggle={(event) => setShowGraph(event.currentTarget.open)}>
        <summary>Local graph</summary>
        {showGraph && <ConnectionGraph focus={`research:${questionId}`} inset />}
      </details>
      {activeEditor?.kind === 'question' && <ResearchObjectEditor
        projectId={projectId} object={ready} types={['question']} title="Edit research question" references={references}
        onClose={closeEditor} onSaved={() => { question.reload(); closeEditor(); }}
      />}
      {activeEditor?.kind === 'sources' && <QuestionSourceEditor
        projectId={projectId} questionId={questionId} prefill={activeEditor.prefill}
        onClose={closeEditor} onSaved={() => { links.reload(); setShowSources(true); closeEditor(); }}
      />}
      {(activeEditor?.kind === 'investigation' || activeEditor?.kind === 'results') && <QuestionRecordPicker
        projectId={projectId} questionId={questionId} section={activeEditor.kind}
        onClose={closeEditor} onSaved={() => { links.reload(); closeEditor(); }}
        onCreate={(relation) => setEditor({ kind: 'record', relation })}
      />}
      {activeEditor?.kind === 'record' && <NewQuestionRecord
        projectId={projectId} questionId={questionId} relation={activeEditor.relation} references={references}
        onClose={closeEditor} onSaved={() => { links.reload(); closeEditor(); }}
      />}
      {editingTask && <TaskModal projectId={projectId} objectId={questionId}
        task={editingTask === 'new' ? undefined : editingTask} defaultPlannedDate={todayDate()}
        onClose={() => setEditingTask(undefined)} onSaved={(saved) => {
          setEditingTask(undefined);
          tasks.reload();
          if (saved) setNotice(saved.planned_date === todayDate()
            ? `“${saved.title}” is planned for today.`
            : `Saved “${saved.title}”.`);
        }}
      />}
    </>
  );
}

function QuestionSourceEditor({ projectId, questionId, prefill, onClose, onSaved }: {
  projectId: string;
  questionId: string;
  prefill?: ResearchQuestionSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id] = useState(uuid);
  const [search, setSearch] = useState('');
  const [referenceId, setReferenceId] = useState(prefill?.referenceId ?? '');
  const [pdfId, setPdfId] = useState(prefill?.pdfId ?? '');
  const [page, setPage] = useState(prefill ? String(prefill.page) : '');
  const [relation, setRelation] = useState<SourceRelation>('motivates');
  const [notes, setNotes] = useState('');
  const refs = useResource<Page<BibliographyItem & { project_id?: string | null }>>(
    `/research/library?native=true&limit=50${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`,
  );
  const selectedReference = useResource<BibliographyItem>(referenceId ? `/research/references/${referenceId}` : null);
  const pdfs = useResource<{ items: LiteratureAttachment[] }>(referenceId ? `/research/references/${referenceId}/attachments` : null);
  const index = useResource<LiteraturePdfIndex>(pdfId ? pdfIndexPath(pdfId) : null);
  const pdfOptions = pdfs.data?.items.filter((file) =>
    file.status === 'ready' && file.format === 'pdf' && file.reference_id === referenceId,
  ) ?? [];
  const refOptions = refs.data?.items.filter((ref) => !ref.project_id || ref.project_id === projectId) ?? [];
  const selectedOption = selectedReference.data?.id === referenceId ? selectedReference.data : null;
  const pageLimit = !index.loading && !index.error && index.data?.page_count ? index.data.page_count : 100000;
  const canSave = Boolean((selectedOption || refOptions.some((ref) => ref.id === referenceId)) &&
    (!pdfId || pdfOptions.some((pdf) => pdf.id === pdfId)));
  const action = useAction();
  return (
    <Modal title="Add source" onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        void action.run(async () => {
          await api('/research/question-links', { method: 'POST', body: {
            id, question_id: questionId, reference_id: referenceId, relation_type: relation, notes,
            ...(pdfId ? { attachment_id: pdfId } : {}), ...(pdfId && page ? { page: Number(page) } : {}),
          } });
          onSaved();
        });
      }}>
        <Field label="Search Library">
          <input type="search" value={search} maxLength={300} onChange={(event) => setSearch(event.target.value)} />
        </Field>
        <ErrorState error={refs.error} retry={refs.reload} />
        <Field label="Reference">
          <select required value={referenceId} onChange={(event) => {
            setReferenceId(event.target.value);
            setPdfId('');
            setPage('');
          }}>
            <option value="">{refs.loading ? 'Loading references…' : 'Choose a reference'}</option>
            {referenceId && !refOptions.some((ref) => ref.id === referenceId) && <option value={referenceId}>
              {selectedOption?.title ?? 'Loading selected reference…'}
            </option>}
            {refOptions.map((ref) => <option key={ref.id} value={ref.id}>{ref.title}</option>)}
          </select>
        </Field>
        {referenceId && <ErrorState error={selectedReference.error} retry={selectedReference.reload} />}
        {referenceId && <ErrorState error={pdfs.error} retry={pdfs.reload} />}
        {referenceId && <Field label="PDF attachment">
          <select value={pdfId} onChange={(event) => { setPdfId(event.target.value); setPage(''); }}>
            <option value="">Whole reference</option>
            {pdfId && !pdfOptions.some((file) => file.id === pdfId) && <option value={pdfId}>
              {pdfs.loading ? 'Loading PDF attachment…' : 'PDF attachment unavailable'}
            </option>}
            {pdfOptions.map((file) => <option key={file.id} value={file.id}>{file.file_name}</option>)}
          </select>
        </Field>}
        {pdfId && <Field label="PDF page" hint="Use the page number shown in the PDF reader.">
          <input type="number" required min={1} max={pageLimit} step={1} value={page} onChange={(event) => setPage(event.target.value)} />
        </Field>}
        <Field label="Relationship">
          <select value={relation} onChange={(event) => setRelation(event.target.value as SourceRelation)}>
            {Object.entries(sourceRelations).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)">
          <textarea value={notes} rows={3} maxLength={4000} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="button primary" disabled={action.busy || !canSave}>Save source</button>
        </div>
      </form>
    </Modal>
  );
}

function QuestionRecordPicker({ projectId, questionId, section, onClose, onSaved, onCreate }: {
  projectId: string;
  questionId: string;
  section: 'investigation' | 'results';
  onClose: () => void;
  onSaved: () => void;
  onCreate: (relation: RecordRelation) => void;
}) {
  const [id] = useState(uuid);
  const [relation, setRelation] = useState<RecordRelation>(section === 'results' ? 'result' : 'attempt');
  const options = section === 'results' ? resultRelations : investigationRelations;
  const [search, setSearch] = useState('');
  const [recordId, setRecordId] = useState('');
  const [notes, setNotes] = useState('');
  const params = new URLSearchParams({ limit: '100' });
  if (search.trim()) params.set('q', search.trim());
  if (recordTypes[relation].length === 1) params.set('object_type', recordTypes[relation][0]);
  const records = useResource<Page<ResearchObject>>(`/research/projects/${projectId}/objects?${params}`);
  const matching = records.data?.items.filter((record) => recordTypes[relation].includes(record.object_type)) ?? [];
  const action = useAction();
  return (
    <Modal title={section === 'results' ? 'Link result' : 'Link investigation'} onClose={onClose}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!matching.some((item) => item.id === recordId)) return;
        void action.run(async () => {
          await api('/research/question-links', { method: 'POST', body: {
            id, question_id: questionId, relation_type: relation, research_object_id: recordId, notes,
          } });
          onSaved();
        });
      }}>
        <Field label="Relationship">
          <select value={relation} onChange={(event) => { setRelation(event.target.value as RecordRelation); setRecordId(''); }}>
            {Object.entries(options).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </select>
        </Field>
        <Field label="Search records">
          <input type="search" value={search} maxLength={300} onChange={(event) => { setSearch(event.target.value); setRecordId(''); }} />
        </Field>
        <ErrorState error={records.error} retry={records.reload} />
        <Field label="Research record">
          <select required value={recordId} onChange={(event) => setRecordId(event.target.value)}>
            <option value="">{records.loading ? 'Loading records…' : matching.length ? 'Choose a record' : 'No matching records'}</option>
            {matching.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)">
          <textarea value={notes} rows={3} maxLength={4000} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button type="button" className="button" onClick={() => onCreate(relation)}>Create record</button>
          <button type="submit" className="button primary" disabled={action.busy || !matching.some((item) => item.id === recordId)}>Save link</button>
        </div>
      </form>
    </Modal>
  );
}

function NewQuestionRecord({ questionId, relation, onSaved, ...props }: {
  projectId: string;
  questionId: string;
  relation: RecordRelation;
  references: BibliographyItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return <ResearchObjectEditor {...props} title={`New ${allRelations[relation].toLowerCase()}`} types={recordTypes[relation]}
    onCommit={async (record, id) => {
      await api('/research/question-links', { method: 'POST', body: {
        id, question_id: questionId, relation_type: relation, research_object_id: record.id,
      } });
    }} onSaved={onSaved} />;
}

function OriginSources({ questionId }: { questionId: string }) {
  const links = useResource<Page<ResearchQuestionLink>>(`/research/question-links?question_id=${questionId}&limit=100`);
  const sources = links.data?.items.filter((item) => item.reference_id) ?? [];
  return <>
    <ErrorState error={links.error} retry={links.reload} />
    {sources.length > 0 && <>
      <p className="muted small-text">Sources linked to this question</p>
      <ul>
        {sources.map((source) => <li key={source.id}>
          <Link href={sourceHref(source)!} className="text-link">
            {source.target_title}{source.page ? ` · PDF page ${source.page}` : ''}
          </Link>
        </li>)}
      </ul>
    </>}
  </>;
}

export function ResearchRecordOrigins({ record }: { record: ResearchObject }) {
  const links = useResource<Page<ResearchQuestionLink>>(`/research/question-links?research_object_id=${record.id}&limit=100`);
  const items = links.data?.items ?? [];
  if (!items.length && !links.error) return null;
  return <div className={styles.originList}>
    <h3 className="section-small-title">Research questions</h3>
    <ErrorState error={links.error} retry={links.reload} />
    {items.map((origin) => <div className="evidence-box" key={origin.id}>
      <Link href={researchQuestionHref(origin.project_id, origin.question_id)} className="text-link">{origin.question_title}</Link>
      <p className={styles.linkMeta}>{allRelations[origin.relation_type]}</p>
      <OriginSources questionId={origin.question_id} />
    </div>)}
  </div>;
}
