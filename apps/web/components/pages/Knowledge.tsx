'use client';

import { MarkdownEditor } from '../MarkdownEditor';
import { knowledgeChapter, knowledgeChapterTitle } from '@prism/shared-utils';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { ApiError, api, datetime, useAction, useResource, uuid } from '../../lib/api';
import {
  chapterName,
  scopedPath,
  type Chapter,
  type ChapterRange,
  type StudyScope,
} from '../../lib/knowledge-scope';
import type { Card, Entity, Knowledge, Page, ProofStep, ReviewEvent } from '../../lib/types';
import { reviewCardTypes } from '../../lib/review-card-markdown';
import {
  updateReviewSession,
  useReviewSession,
  type PendingReview,
  type ReviewSession,
} from '../../lib/review-session';
import type { GuideLanguage } from '../../lib/getting-started-copy';
import { KnowledgeMarkdownActions } from '../KnowledgeMarkdownActions';
import { ConnectionGraph } from '../ConnectionGraph';
import { ModuleGuide, ModuleGuideHint, useModuleGuide, type ModuleGuideState } from '../ModuleGuide';
import { ReviewCardImport } from '../ReviewCardImport';
import { KnowledgeResearchLinks } from '../ResearchLinks';
import { ProofRecall, ProofStepEditor } from '../ProofRecall';
import proofStyles from '../ProofRecall.module.css';
import {
  Badge,
  Empty,
  ErrorState,
  Field,
  Icon,
  KnowledgeMarkdown,
  Loading,
  MathContent,
  Modal,
  Notice,
  knowledgeTypes,
  label,
} from '../ui';
import scopeStyles from './KnowledgeScope.module.css';

type SubjectList = { items: string[] };

function subjectName(subject: string) {
  return subject || 'Unassigned';
}

function SubjectFilter({
  label,
  subject,
  subjects,
  onChange,
  disabled,
}: {
  label: string;
  subject?: string;
  subjects: string[];
  onChange: (subject?: string) => void;
  disabled?: boolean;
}) {
  const choices = subject !== undefined && !subjects.includes(subject) ? [...subjects, subject] : subjects;
  return (
    <select
      aria-label={label}
      value={subject === undefined ? '' : `subject:${subject}`}
      onChange={(event) =>
        onChange(event.target.value ? event.target.value.slice('subject:'.length) : undefined)
      }
      disabled={disabled}
    >
      <option value="">All subjects</option>
      {choices.map((name) => (
        <option key={name} value={`subject:${name}`}>
          {subjectName(name)}
        </option>
      ))}
    </select>
  );
}

function ChapterFilter({
  scope: { subject, chapters },
  onChange,
  disabled,
}: {
  scope: StudyScope;
  onChange: (chapters?: ChapterRange) => void;
  disabled?: boolean;
}) {
  const catalog = useResource<{ items: Chapter[] }>(
    subject === undefined ? null : scopedPath('/knowledge-chapters', { subject }),
  );
  if (
    subject === undefined ||
    (!chapters && !catalog.loading && !catalog.error && !catalog.data?.items.length)
  )
    return null;
  const byNumber = new Map(catalog.data?.items.map((chapter) => [chapter.number, chapter]));
  if (chapters) {
    for (const number of [chapters.from, chapters.to]) {
      if (!byNumber.has(number)) byNumber.set(number, { number });
    }
  }
  const choices = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const locked = disabled || catalog.loading || Boolean(catalog.error);
  return (
    <div role="group" aria-label="Chapter range" className={scopeStyles.chapterRange}>
      {catalog.error ? (
        <ErrorState error={catalog.error} retry={catalog.reload} />
      ) : (
        <>
          <Field label="From chapter">
            <select
              value={chapters?.from ?? ''}
              disabled={locked}
              onChange={(event) => {
                const from = Number(event.target.value);
                onChange(from ? { from, to: Math.max(from, chapters?.to ?? from) } : undefined);
              }}
            >
              <option value="">All chapters</option>
              {choices.map((chapter) => (
                <option key={chapter.number} value={chapter.number}>
                  {chapterName(chapter)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Through chapter">
            <select
              value={chapters?.to ?? ''}
              disabled={locked || !chapters}
              onChange={(event) => {
                if (chapters) onChange({ from: chapters.from, to: Number(event.target.value) });
              }}
            >
              {!chapters && <option value="">Choose a starting chapter</option>}
              {choices
                .filter((chapter) => chapters && chapter.number >= chapters.from)
                .map((chapter) => (
                  <option key={chapter.number} value={chapter.number}>
                    {chapterName(chapter)}
                  </option>
                ))}
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

export function KnowledgePage({
  id,
  scope,
  guideUserId,
  guideLanguage,
}: {
  id?: string;
  scope: StudyScope;
  guideUserId?: string;
  guideLanguage?: GuideLanguage;
}) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const guide = useModuleGuide('knowledge', guideUserId, guideLanguage);
  return id ? (
    <KnowledgeDetail id={id} guide={guide} />
  ) : (
    <KnowledgeCollection
      key={scopedPath('/knowledge', scope)}
      scope={scope}
      q={q}
      type={type}
      setQ={setQ}
      setType={setType}
      guide={guide}
    />
  );
}

function KnowledgeCollection({
  scope,
  q,
  type,
  setQ,
  setType,
  guide,
}: {
  scope: StudyScope;
  q: string;
  type: string;
  setQ: (value: string) => void;
  setType: (value: string) => void;
  guide: ModuleGuideState;
}) {
  const router = useRouter();
  const { subject, chapters } = scope;
  const [switchingScope, switchScope] = useTransition();
  const [editor, setEditor] = useState<'regular' | 'guided'>();
  const subjects = useResource<SubjectList>('/knowledge-subjects');
  const itemsPath = scopedPath('/knowledge-items', scope, {
    limit: '100',
    ...(q ? { q } : {}),
    ...(type ? { type } : {}),
  });
  const items = useResource<Page<Knowledge>>(itemsPath);
  const pagination = useAction();
  const pageRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pageRequest.current?.abort(), [itemsPath]);

  function resetPages() {
    pageRequest.current?.abort();
    pagination.setError(null);
    items.setData(null);
  }

  function loadMore() {
    const cursor = items.data?.next_cursor;
    if (!cursor || items.loading || items.error || switchingScope || pageRequest.current) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    void pagination.run(async () => {
      try {
        const next = await api<Page<Knowledge>>(`${itemsPath}&cursor=${encodeURIComponent(cursor)}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          items.setData((page) =>
            page?.next_cursor === cursor ? { ...next, items: [...page.items, ...next.items] } : page,
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        pageRequest.current = null;
      }
    });
  }

  const filtered = Boolean(q || type || subject !== undefined);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE & RETENTION</div>
          <h1>Knowledge</h1>
        </div>
        <div className="heading-actions">
          <Link href="/knowledge/export" className="button">
            Export PDF
          </Link>
          <Link href={scopedPath('/review/session', scope)} className="button">
            Start review
            <Icon name="arrow" size={16} />
          </Link>
          <button className="button primary" onClick={() => setEditor('regular')}>
            <Icon name="plus" size={17} />
            New knowledge
          </button>
        </div>
      </div>
      <ModuleGuide
        guide={guide}
        continuation={guide.progress?.itemId ? 'knowledge' : undefined}
        href={guide.progress?.itemId ? `/knowledge/${guide.progress.itemId}` : undefined}
        action={() => setEditor('guided')}
      />
      <div className={`collection-toolbar ${scopeStyles.toolbar}`}>
        <label className="filter-search">
          <Icon name="search" size={18} />
          <input
            value={q}
            onChange={(e) => {
              resetPages();
              setQ(e.target.value);
            }}
            placeholder="Search knowledge titles or content…"
          />
        </label>
        <SubjectFilter
          label="Knowledge subject"
          subject={subject}
          subjects={subjects.data?.items ?? []}
          disabled={switchingScope || subjects.loading}
          onChange={(name) =>
            switchScope(() => router.replace(scopedPath('/knowledge', { subject: name }), { scroll: false }))
          }
        />
        <select
          aria-label="Knowledge type"
          value={type}
          onChange={(e) => {
            resetPages();
            setType(e.target.value);
          }}
        >
          <option value="">All types</option>
          {knowledgeTypes.map((t) => (
            <option key={t} value={t}>
              {label(t)}
            </option>
          ))}
        </select>
        <span className="muted small-text">{items.data?.items.length ?? '—'} knowledge items</span>
        <ChapterFilter
          scope={scope}
          disabled={switchingScope}
          onChange={(range) =>
            switchScope(() =>
              router.replace(scopedPath('/knowledge', { subject, chapters: range }), { scroll: false }),
            )
          }
        />
      </div>
      <ErrorState
        error={items.error || subjects.error}
        retry={items.error ? items.reload : subjects.reload}
      />
      {items.loading && !items.data && <Loading />}
      {items.data?.items.length === 0 && (
        <div className="panel">
          <Empty
            title={filtered ? 'No matching knowledge' : 'No knowledge items yet'}
            action={
              <button className="button primary" onClick={() => setEditor('regular')}>
                {filtered ? 'Create a knowledge item' : 'Create your first knowledge item'}
              </button>
            }
          >
            {filtered
              ? 'Adjust your search or filters, or add an item to this subject.'
              : 'Definitions, theorems, proofs, and counterexamples all belong here.'}
          </Empty>
        </div>
      )}
      <div className="knowledge-grid">
        {items.data?.items.map((item) => {
          const chapter = knowledgeChapter(item.tags);
          return (
            <Link key={item.id} href={`/knowledge/${item.id}`} className="knowledge-card">
              <div className="knowledge-card-top">
                <Badge
                  tone={
                    item.type === 'theorem' || item.type === 'lemma'
                      ? 'purple'
                      : item.type === 'definition'
                        ? 'blue'
                        : ''
                  }
                >
                  {label(item.type)}
                </Badge>
                <span className="small-text muted">{datetime(item.updated_at, true)}</span>
              </div>
              <h2>{item.title}</h2>
              <MathContent content={item.content.slice(0, 350)} className="knowledge-excerpt" />
              <div className="knowledge-card-bottom">
                <span>
                  {item.subject || 'Uncategorized'}
                  {chapter !== null
                    ? ` · ${chapterName({ number: chapter, title: knowledgeChapterTitle(item.tags) })}`
                    : item.tags.length
                      ? ` · ${item.tags[0]}`
                      : ''}
                </span>
                <span
                  className={`verification ${item.verification_status !== 'unverified' ? 'verified' : ''}`}
                >
                  <span />
                  {label(item.verification_status)}
                </span>
              </div>
              <Icon name="arrow" className="knowledge-arrow" size={18} />
            </Link>
          );
        })}
      </div>
      {pagination.error && <Notice tone="error">{pagination.error}</Notice>}
      {items.data?.next_cursor && (
        <button
          className="button"
          disabled={pagination.busy || items.loading || Boolean(items.error) || switchingScope}
          onClick={loadMore}
        >
          {pagination.busy ? 'Loading more…' : 'Load more'}
        </button>
      )}
      {editor && (
        <KnowledgeEditor
          initialSubject={subject}
          initialType={editor === 'guided' ? 'definition' : undefined}
          initialChapter={chapters && chapters.from === chapters.to ? chapters.from : undefined}
          guideHint={
            editor === 'guided' && (
              <ModuleGuideHint guide={guide}>{guide.copy.editor.knowledge}</ModuleGuideHint>
            )
          }
          onClose={() => setEditor(undefined)}
          onSaved={(item) => {
            if (editor === 'guided' || !guide.progress?.itemId) guide.continueWith(item.id);
            setEditor(undefined);
            router.push(`/knowledge/${item.id}`);
          }}
        />
      )}
    </>
  );
}
function KnowledgeDetail({ id, guide }: { id: string; guide: ModuleGuideState }) {
  const router = useRouter();
  const item = useResource<Knowledge>(`/knowledge-items/${id}`);
  const cards = useResource<Page<Card>>(`/knowledge-items/${id}/cards?limit=100`);
  const references = useResource<Page<{ id: string; reference_id: string; title: string }>>(
    `/knowledge-items/${id}/reference-links?limit=20`,
  );
  const [edit, setEdit] = useState(false);
  const [cardEdit, setCardEdit] = useState<Card | 'new' | null>(null);
  const [importCards, setImportCards] = useState(false);
  const [imported, setImported] = useState(0);
  const [history, setHistory] = useState<string | null>(null);
  const [relation, setRelation] = useState(false);
  const relations = useResource<
    Page<Entity & { source_item_id: string; target_item_id: string; relation_type: string }>
  >('/knowledge-relations?limit=500');
  const allItems = useResource<Page<Knowledge>>('/knowledge-items?limit=500');
  const refresh = () => {
    item.reload();
    cards.reload();
    relations.reload();
  };
  const action = useAction(refresh);
  if (!item.data)
    return (
      <>
        <ErrorState error={item.error} retry={item.reload} />
        {item.loading && <Loading />}
      </>
    );
  const k = item.data;
  const chapter = knowledgeChapter(k.tags);
  const chapterScope =
    chapter === null ? undefined : { subject: k.subject, chapters: { from: chapter, to: chapter } };
  return (
    <>
      <Link className="back-link" href="/knowledge">
        ← All knowledge
      </Link>
      {guide.progress?.itemId === id && (
        <ModuleGuide guide={guide} continuation="knowledge" action={() => setCardEdit('new')} />
      )}
      {guide.progress && !guide.progress.itemId && guide.progress.status !== 'completed' && (
        <ModuleGuide guide={guide} href="/knowledge" />
      )}
      <div className="page-heading detail-heading">
        <div>
          <div className="eyebrow">
            {label(k.type).toUpperCase()} ·{' '}
            <Link href={scopedPath('/knowledge', { subject: k.subject })}>{subjectName(k.subject)}</Link>
            {chapterScope && (
              <>
                {' '}
                ·{' '}
                <Link href={scopedPath('/knowledge', chapterScope)}>
                  {chapterName({ number: chapterScope.chapters.from, title: knowledgeChapterTitle(k.tags) })}
                </Link>
              </>
            )}
          </div>
          <h1>{k.title}</h1>
          <div className="inline-actions">
            <Badge tone={k.verification_status === 'unverified' ? '' : 'green'}>
              {label(k.verification_status)}
            </Badge>
            {k.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={() => setEdit(true)}>
            <Icon name="edit" size={16} />
            Edit
          </button>
          <Link className="button" href={`/knowledge/export?item=${encodeURIComponent(k.id)}`}>
            Export PDF
          </Link>
          <KnowledgeMarkdownActions items={[k]} />
          <button
            className="icon-button danger"
            aria-label="Archive knowledge"
            onClick={() => {
              if (confirm('Archive this knowledge item and its cards? Review history will be preserved.'))
                void action.run(async () => {
                  await api(`/knowledge-items/${id}`, { method: 'DELETE', version: k.version });
                  router.push('/knowledge');
                });
            }}
          >
            <Icon name="trash" size={18} />
          </button>
        </div>
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <div className="detail-columns">
        <div>
          <section className="panel content-panel">
            <div className="panel-heading">
              <h2>Content</h2>
              <span className="small-text muted">Updated {datetime(k.updated_at)}</span>
            </div>
            <KnowledgeMarkdown content={k.content} />
            {k.proof_content && (
              <>
                <div className="content-divider" />
                <h3 className="section-small-title">Proof / Explanation</h3>
                <KnowledgeMarkdown content={k.proof_content} />
              </>
            )}
            {k.source_reference && (
              <div className="source-reference">
                <Icon name="bookmark" size={15} />
                <span>Source: {k.source_reference}</span>
              </div>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">INDEPENDENT SCHEDULING</span>
                <h2>Review cards</h2>
              </div>
              <div className="inline-actions">
                <button className="button small" onClick={() => setImportCards(true)}>
                  Import cards
                </button>
                <button className="button small" onClick={() => setCardEdit('new')}>
                  <Icon name="plus" size={15} />
                  Add card
                </button>
              </div>
            </div>
            <p className="panel-description">
              Knowing a statement is different from knowing its proof. Each card has its own FSRS schedule.
            </p>
            <ErrorState error={cards.error} retry={cards.reload} />
            {imported > 0 && (
              <div role="status">
                <Notice>
                  Created {imported} {imported === 1 ? 'card' : 'cards'}.
                </Notice>
              </div>
            )}
            {cards.data?.items.length === 0 && (
              <Empty title="No review cards yet">
                Add cards for its statement, hypotheses, proof, or applications.
              </Empty>
            )}
            <div className="card-list">
              {cards.data?.items.map((c) => (
                <article key={c.id} className="review-card-row">
                  <div>
                    <Badge tone="purple">{label(c.card_type)}</Badge>
                    <h3>{c.prompt.slice(0, 100)}</h3>
                    <span className="small-text muted">
                      {c.suspended ? 'Suspended' : `Next review ${datetime(c.due_at)}`} · Reviews:{' '}
                      {c.review_count}
                    </span>
                  </div>
                  <div className="inline-actions">
                    {c.card_type === 'proof' &&
                      !!c.proof_steps?.length &&
                      !c.suspended &&
                      Date.parse(c.due_at) <= Date.now() && (
                        <Link href={`/review/session?card=${c.id}`} className="button small">
                          Practice proof
                        </Link>
                      )}
                    <button className="button small" onClick={() => setHistory(c.id)}>
                      History
                    </button>
                    <button className="icon-button" aria-label="Edit card" onClick={() => setCardEdit(c)}>
                      <Icon name="edit" size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={c.suspended ? 'Resume card' : 'Suspend card'}
                      onClick={() =>
                        void action.run(() =>
                          api(`/review/cards/${c.id}`, {
                            method: 'PATCH',
                            version: c.version,
                            body: { suspended: !c.suspended },
                          }),
                        )
                      }
                    >
                      {c.suspended ? '▶' : 'Ⅱ'}
                    </button>
                    <button
                      className="icon-button danger"
                      aria-label="Archive card"
                      onClick={() => {
                        if (confirm('Archive this card? Its history will be preserved.'))
                          void action.run(() =>
                            api(`/review/cards/${c.id}`, { method: 'DELETE', version: c.version }),
                          );
                      }}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
        <aside>
          <ConnectionGraph focus={`knowledge:${id}`} />
          <KnowledgeResearchLinks note={k} />
          {!!references.data?.items.length && <section className="panel" aria-label="Literature references">
            <div className="panel-heading"><h2>Literature references</h2></div>
            <ul className="card-list">
              {references.data.items.map((reference) => <li key={reference.id}>
                <Link href={`/research/library?reference=${reference.reference_id}`} className="text-link">{reference.title}</Link>
              </li>)}
            </ul>
          </section>}
          <section className="panel">
            <div className="panel-heading">
              <h2>Related knowledge</h2>
              <button
                className="icon-button"
                aria-label="Related knowledge"
                onClick={() => setRelation(true)}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            {relations.data?.items
              .filter((r) => r.source_item_id === id || r.target_item_id === id)
              .map((r) => {
                const other = r.source_item_id === id ? r.target_item_id : r.source_item_id;
                return (
                  <div className="relation-row" key={r.id}>
                    <Link href={`/knowledge/${other}`}>
                      <span className="small-text muted">{label(r.relation_type)}</span>
                      <p>{allItems.data?.items.find((x) => x.id === other)?.title || 'Related knowledge'}</p>
                    </Link>
                    <button
                      className="icon-button"
                      aria-label="Remove link"
                      onClick={() =>
                        void action.run(() =>
                          api(`/knowledge-relations/${r.id}`, { method: 'DELETE', version: r.version }),
                        )
                      }
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                );
              })}
            <p className="small-text muted panel-description">Connect dependencies, proofs, and examples.</p>
          </section>
          <div className="quiet-card small">
            <span className="eyebrow">RECALL BEFORE REVEAL</span>
            <p>
              Try to recall,
              <br />
              then reveal the answer.
            </p>
            <div className="inline-actions">
              {chapterScope && (
                <Link href={scopedPath('/review/session', chapterScope)} className="text-link">
                  Review this chapter →
                </Link>
              )}
              <Link href={scopedPath('/review/session', { subject: k.subject })} className="text-link">
                Review this subject →
              </Link>
            </div>
          </div>
        </aside>
      </div>
      {edit && (
        <KnowledgeEditor
          item={k}
          onClose={() => setEdit(false)}
          onSaved={() => {
            setEdit(false);
            refresh();
          }}
        />
      )}{' '}
      {cardEdit && (
        <CardEditor
          knowledge={k}
          card={cardEdit === 'new' ? undefined : cardEdit}
          guideHint={
            cardEdit === 'new' &&
            guide.progress?.itemId === id && (
              <ModuleGuideHint guide={guide}>{guide.copy.makeCard}</ModuleGuideHint>
            )
          }
          onClose={() => setCardEdit(null)}
          onSaved={() => {
            if (cardEdit === 'new' && guide.progress?.itemId === id) guide.finish();
            setCardEdit(null);
            cards.reload();
          }}
        />
      )}{' '}
      {importCards && (
        <ReviewCardImport
          knowledgeId={id}
          onClose={() => setImportCards(false)}
          onSaved={(count) => {
            setImportCards(false);
            setImported(count);
            cards.reload();
          }}
        />
      )}
      {history && <HistoryModal cardId={history} onClose={() => setHistory(null)} />}
      {relation && (
        <RelationModal
          sourceId={id}
          items={allItems.data?.items || []}
          onClose={() => setRelation(false)}
          onSaved={() => {
            setRelation(false);
            relations.reload();
          }}
        />
      )}
    </>
  );
}
const exportMetadataPrefixes = ['chapter:', 'chapter-title:', 'entry:', 'entry-label:', 'textbook-pages:'];

export function KnowledgeEditor({
  item,
  initialSubject,
  initialType,
  initialChapter,
  guideHint,
  onClose,
  onSaved,
}: {
  item?: Knowledge;
  initialSubject?: string;
  initialType?: string;
  initialChapter?: number;
  guideHint?: ReactNode;
  onClose: () => void;
  onSaved: (item: Knowledge) => void;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(item?.title || '');
  const [type, setType] = useState(item?.type ?? initialType ?? 'theorem');
  const [subject, setSubject] = useState(item?.subject ?? initialSubject ?? '');
  const subjects = useResource<SubjectList>('/knowledge-subjects');
  const subjectOptionsId = useId();
  const aiReviewHintId = useId();
  const savedTags = item?.tags ?? [];
  const ordinaryTags = savedTags.filter(
    (tag) => tag !== 'ai-review' && !exportMetadataPrefixes.some((prefix) => tag.startsWith(prefix)),
  );
  const [aiReview, setAiReview] = useState(savedTags.includes('ai-review'));
  const savedChapter = savedTags.find((tag) => tag.startsWith('chapter:'))?.slice('chapter:'.length) ?? '';
  const savedEntry = savedTags.find((tag) => tag.startsWith('entry:'))?.slice('entry:'.length) ?? '';
  const [tags, setTags] = useState(ordinaryTags.join(', '));
  const [chapter, setChapter] = useState(
    initialChapter === undefined ? savedChapter : String(initialChapter),
  );
  const [entry, setEntry] = useState(savedEntry);
  const [content, setContent] = useState(item?.content || '');
  const [proof, setProof] = useState(item?.proof_content || '');
  const [source, setSource] = useState(item?.source_reference || '');
  const [verification, setVerification] = useState(item?.verification_status || 'unverified');
  const action = useAction();
  return (
    <Modal title={item ? 'Edit knowledge item' : 'New knowledge item'} onClose={onClose} wide>
      {guideHint}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const userTags =
              tags === ordinaryTags.join(', ')
                ? ordinaryTags
                : tags
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(
                      (tag) =>
                        tag &&
                        tag !== 'ai-review' &&
                        !exportMetadataPrefixes.some((prefix) => tag.startsWith(prefix)),
                    );
            const exportTags = [
              ...(chapter ? [`chapter:${chapter}`] : []),
              ...(entry.trim() ? [`entry:${entry.trim()}`] : []),
              ...savedTags.filter(
                (tag) =>
                  (chapter === savedChapter && tag.startsWith('chapter-title:')) ||
                  (entry.trim() === savedEntry && tag.startsWith('entry-label:')) ||
                  (source === (item?.source_reference ?? '') && tag.startsWith('textbook-pages:')),
              ),
            ];
            const body = {
              title,
              type,
              subject:
                subject === (item?.subject ?? initialSubject) || subjects.data?.items.includes(subject)
                  ? subject
                  : subject.trim(),
              tags: [...userTags, ...exportTags, ...(aiReview ? ['ai-review'] : [])],
              content,
              proof_content: proof || null,
              source_reference: source || null,
              verification_status: verification,
            };
            const result = await api<Knowledge>(item ? `/knowledge-items/${item.id}` : '/knowledge-items', {
              method: item ? 'PATCH' : 'POST',
              version: item?.version,
              body: item ? { ...body, base_snapshot: item } : { id: creationId, ...body },
            });
            onSaved(result);
          });
        }}
      >
        <div className="form-grid">
          <Field label="Title">
            <input
              autoFocus
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="For example: Nakayama's Lemma"
            />
          </Field>
          <Field label="Object type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {knowledgeTypes.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Subject / course" hint="Choose an existing subject or type a new one.">
            <input
              list={subjectOptionsId}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Commutative Algebra"
            />
            <datalist id={subjectOptionsId}>
              {subjects.data?.items.filter(Boolean).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
          <Field label="Tags (comma-separated)">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="modules, local rings"
            />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Chapter number (optional)">
            <input
              inputMode="numeric"
              pattern="[1-9][0-9]{0,5}"
              value={chapter}
              onChange={(e) => setChapter(e.target.value)}
              placeholder="For example: 3"
            />
          </Field>
          <Field label="Entry number (optional)">
            <input
              maxLength={60}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="For example: 3.12"
            />
          </Field>
        </div>
        {process.env.NEXT_PUBLIC_PRISM_AI_REVIEW_DRAFTS === 'true' && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={aiReview}
                aria-describedby={aiReviewHintId}
                onChange={(event) => setAiReview(event.target.checked)}
              />
              Include this note in AI review drafts
            </label>
            <p id={aiReviewHintId} className="small-text muted">
              When AI drafting is enabled, PRISM may send this note’s title and main text to OpenAI.
            </p>
          </>
        )}
        <MarkdownEditor
          label="Mathematical content"
          previewLabel="Content preview"
          value={content}
          onChange={setContent}
          rows={8}
          required
          hint="Use Markdown for formatting, $…$ for inline math, and $$…$$ for display math."
          placeholder="Write the complete statement, including every required hypothesis."
        />
        <MarkdownEditor
          label="Proof / explanation (optional)"
          previewLabel="Proof preview"
          value={proof}
          onChange={setProof}
          rows={5}
          placeholder="A proof, explanation, or key idea…"
        />
        <div className="form-grid">
          <Field label="Source reference">
            <input
              value={source}
              required={verification === 'source_verified'}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Book, chapter, or original link"
            />
          </Field>
          <Field label="Verification status">
            <select value={verification} onChange={(e) => setVerification(e.target.value)}>
              {['unverified', 'user_verified', 'source_verified'].map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <span className="small-text muted">You choose the verification status.</span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save knowledge'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function CardEditor({
  knowledge,
  card,
  guideHint,
  onClose,
  onSaved,
}: {
  knowledge: Knowledge;
  card?: Card;
  guideHint?: ReactNode;
  onClose: () => void;
  onSaved: (card: Card) => void;
}) {
  const [creationId] = useState(uuid);
  const [type, setType] = useState(card?.card_type || 'statement');
  const [prompt, setPrompt] = useState(
    card?.prompt || `State ${knowledge.title}, including all required hypotheses.`,
  );
  const [answer, setAnswer] = useState(card?.answer || knowledge.content);
  const [steps, setSteps] = useState<ProofStep[]>(card?.proof_steps ?? []);
  const action = useAction();
  return (
    <Modal title={card ? 'Edit review card' : 'Create an independent review card'} onClose={onClose}>
      {guideHint}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const proofSteps = steps.map((step) => ({ ...step, hint: step.hint.trim() }));
            if (type === 'proof' && proofSteps.some((step) => !step.hint)) {
              throw new Error('Write a hint for each proof step, or remove the empty steps.');
            }
            const saved = await api<Card>(
              card ? `/review/cards/${card.id}` : `/knowledge-items/${knowledge.id}/cards`,
              {
                method: card ? 'PATCH' : 'POST',
                version: card?.version,
                body: {
                  ...(card ? {} : { id: creationId }),
                  card_type: type,
                  prompt,
                  answer,
                  ...(type === 'proof' ? { proof_steps: proofSteps } : {}),
                },
              },
            );
            onSaved(saved);
          });
        }}
      >
        <Field label="Review focus">
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              if (!card && e.target.value === 'proof') setAnswer(knowledge.proof_content || '');
            }}
          >
            {reviewCardTypes.map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
        </Field>
        <MarkdownEditor label="Prompt" required rows={3} value={prompt} onChange={setPrompt}  />
        <MarkdownEditor label="Reference answer"
            required
            rows={6}
            value={answer}
            onChange={setAnswer}
           />
        {type === 'proof' && <ProofStepEditor steps={steps} onChange={setSteps} />}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            Save card
          </button>
        </div>
      </form>
    </Modal>
  );
}
function HistoryModal({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const h = useResource<Page<ReviewEvent>>(`/review/history?card_id=${cardId}&limit=100`);
  return (
    <Modal title="Review history" onClose={onClose}>
      <ErrorState error={h.error} retry={h.reload} />
      {h.loading ? (
        <Loading />
      ) : h.data?.items.length === 0 ? (
        <Empty title="This card has no reviews yet" />
      ) : (
        <div className="history-list">
          {h.data?.items.map((x) => (
            <section key={x.id}>
              <div>
                <span>{datetime(x.reviewed_at)}</span>
                <Badge tone={x.rating === 'again' ? 'peach' : 'green'}>{x.rating.toUpperCase()}</Badge>
                <span>{Math.round(x.duration_ms / 1000)} sec</span>
              </div>
              {!!x.proof_stuck_steps?.length && (
                <details className={proofStyles.historyDetails}>
                  <summary>
                    Stuck on{' '}
                    {x.proof_stuck_steps.length === 1 ? '1 step' : `${x.proof_stuck_steps.length} steps`}
                  </summary>
                  <ul>
                    {x.proof_stuck_steps.map((step) => (
                      <li key={step.id}>
                        <KnowledgeMarkdown content={step.hint} />
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
function RelationModal({
  sourceId,
  items,
  onClose,
  onSaved,
}: {
  sourceId: string;
  items: Knowledge[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [creationId] = useState(uuid);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('related');
  const a = useAction(onSaved);
  return (
    <Modal title="Related knowledge" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(() =>
            api('/knowledge-relations', {
              method: 'POST',
              body: { id: creationId, source_item_id: sourceId, target_item_id: target, relation_type: type },
            }),
          );
        }}
      >
        <Field label="Target knowledge">
          <select required value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose knowledge</option>
            {items
              .filter((x) => x.id !== sourceId)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Relationship">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {['related', 'depends_on', 'example_of', 'proof_of'].map((x) => (
              <option key={x} value={x}>
                {label(x)}
              </option>
            ))}
          </select>
        </Field>
        {a.error && <Notice tone="error">{a.error}</Notice>}
        <div className="modal-footer">
          <button className="button primary" disabled={a.busy}>
            Save link
          </button>
        </div>
      </form>
    </Modal>
  );
}

const emptyDraft = { text: '', revealed: false, stuck: [] as string[], hintsUsed: 0 };
const ratingLabels = [
  ['again', 'Again', 'Needs relearning'],
  ['hard', 'Hard', 'Recalled with difficulty'],
  ['good', 'Good', 'Recalled correctly'],
  ['easy', 'Easy', 'Effortless and complete'],
] as const;

function newSession(items: Card[], cursor: string | null = null): ReviewSession {
  return {
    id: uuid(),
    updatedAt: Date.now(),
    cards: items.map((card) => ({ id: card.id, lastReviewedAt: card.last_reviewed_at })),
    cursor,
    position: 0,
    reviewed: [],
  };
}

type ReviewCardLookup = { id: string; card: Card | null };
async function lookupReviewCard(path: string, signal: AbortSignal): Promise<ReviewCardLookup> {
  const id = path.split('/').at(-1)!;
  try {
    return { id, card: await api<Card>(path, { signal }) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { id, card: null };
    throw error;
  }
}

export function ReviewPage({
  scope, cardId, userId, active,
}: {
  scope: StudyScope;
  cardId?: string;
  userId: string;
  active: boolean;
}) {
  const router = useRouter();
  const { subject, chapters } = scope;
  const href = cardId ? `/review/session?card=${cardId}` : scopedPath('/review/session', scope);
  const [switchingScope, switchScope] = useTransition();
  const subjects = useResource<SubjectList>(cardId ? null : '/knowledge-subjects');
  const queuePath = scopedPath('/review/queue', scope, { limit: '100' });
  const saved = useReviewSession(userId, href);
  const initialized = useRef(false);
  const [ready, setReady] = useState(false);
  const resumeSaved = !!saved && saved.position < saved.cards.length;
  const queue = useResource<Page<Card>>(!cardId && !initialized.current && !resumeSaved ? queuePath : null);
  const entry = ready ? saved?.cards[saved.position] : undefined;
  const lookupId = entry?.id ?? (!ready && !resumeSaved ? cardId : undefined);
  const lookup = useResource<ReviewCardLookup>(lookupId ? `/review/cards/${lookupId}` : null, lookupReviewCard);
  const current = lookup.data?.id === lookupId ? lookup.data : null;
  const candidate = entry?.id === current?.id ? current?.card : undefined;
  const isEligible = Boolean(candidate && entry && !candidate.suspended &&
    candidate.last_reviewed_at === entry.lastReviewedAt &&
    (!candidate.last_reviewed_at || Date.parse(candidate.due_at) <= Date.now()));
  const batch = useAction();
  const [device, setDevice] = useState('');
  const [deviceError, setDeviceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(0);
  const requestInFlight = useRef(false);
  const session = ready ? saved : undefined;
  const draft = session?.draft ?? emptyDraft;
  const pending = session?.pending;
  const card = pending || isEligible ? candidate : undefined;
  const conflict = session?.conflict;
  const done = Boolean(session && !entry);
  const totalDone = session?.reviewed.length ?? 0;
  const totalCards = session?.cards.length ?? 0;
  const reviewedMinutes = Math.max(1, Math.round(
    (session?.reviewed.reduce((total, item) => total + item.durationMs, 0) ?? 0) / 60_000,
  ));
  const proofSteps =
    card?.card_type === 'proof' && card.proof_steps?.length ? card.proof_steps : undefined;

  useEffect(() => {
    if (!active || initialized.current) return;
    if (!resumeSaved && (cardId ? current?.id !== cardId : !queue.data)) return;
    const items = cardId
      ? current?.card && !current.card.suspended &&
          (!current.card.last_reviewed_at || Date.parse(current.card.due_at) <= Date.now())
        ? [current.card]
        : []
      : queue.data?.items ?? [];
    initialized.current = true;
    updateReviewSession(userId, href, (previous) => previous && previous.position < previous.cards.length
      ? previous
      : newSession(items, queue.data?.next_cursor));
    setReady(true);
  }, [active, resumeSaved, cardId, current, queue.data, userId, href]);

  useEffect(() => {
    if (!active) return;
    updateReviewSession(userId, href, (previous) => previous && previous.position < previous.cards.length
      ? { ...previous }
      : previous);
  }, [active, userId, href]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      let prior: string | null = null;
      try { prior = localStorage.getItem('prism-web-device'); } catch {}
      const devices = await api<Page<Entity & { platform: string }>>('/devices');
      const existing =
        devices.items.find((d) => d.id === prior && d.platform === 'web') ||
        devices.items.find((d) => d.platform === 'web');
      const id = existing?.id || uuid();
      if (!existing)
        await api('/devices', { method: 'POST', body: { id, name: 'PRISM Web', platform: 'web' } });
      try { localStorage.setItem('prism-web-device', id); } catch {}
      if (!cancelled) {
        setDevice(id);
        setDeviceError('');
      }
    })().catch((e) => { if (!cancelled) setDeviceError(e.message); });
    return () => { cancelled = true; };
  }, [active, userId]);
  useEffect(() => {
    if (active && entry?.id) {
      started.current = performance.now();
      setError('');
    }
  }, [active, entry?.id]);

  function changeCard(change: (previous: ReviewSession) => ReviewSession) {
    return updateReviewSession(userId, href, (previous) =>
      previous && session?.id === previous.id && session.position === previous.position
        ? change(previous)
        : previous);
  }
  function updateDraft(change: (previous: typeof emptyDraft) => typeof emptyDraft) {
    changeCard((previous) => previous.pending || previous.conflict
      ? previous
      : { ...previous, draft: change(previous.draft ?? emptyDraft) });
  }
  function advance(previous: ReviewSession) {
    return {
      ...previous,
      position: previous.position + 1,
      draft: undefined,
      pending: undefined,
      conflict: undefined,
    };
  }

  // Refresh the selected card instead of indexing into a due queue that may have changed.
  useEffect(() => {
    if (!active || !entry || current?.id !== entry.id || pending || conflict || isEligible) return;
    updateReviewSession(userId, href, (previous) =>
      previous && previous.id === session?.id && previous.position === session.position &&
        !previous.pending && !previous.conflict ? advance(previous) : previous);
  }, [active, entry, current, pending, conflict, isEligible, userId, href, session]);

  async function rate(rating: PendingReview['rating']) {
    if ((!card && !pending) || (!device && !pending) || switchingScope || requestInFlight.current) return;
    const updated = changeCard((previous) => {
      if (previous.pending || previous.conflict || !card) return previous;
      return {
        ...previous,
        pending: { title: card.prompt.slice(0, 60), command: {
          card_id: card.id,
          device_id: device,
          rating,
          idempotency_key: uuid(),
          reviewed_at: new Date().toISOString(),
          duration_ms: Math.round(performance.now() - started.current),
          base_version: card.version,
          ...((previous.draft?.stuck.length ?? 0) > 0 ? { proof_stuck_step_ids: previous.draft!.stuck } : {}),
        } },
      };
    });
    const operation = updated?.pending;
    if (!operation || updated.id !== session?.id || updated.position !== session.position) return;
    const command = operation.command;
    if (command.rating !== rating) {
      setError('Your previous rating is still unconfirmed. Retry the same rating.');
      return;
    }
    requestInFlight.current = true;
    setBusy(true);
    setError('');
    const finish = (change: (previous: ReviewSession) => ReviewSession) =>
      changeCard((previous) => previous.pending?.command.idempotency_key === command.idempotency_key
        ? change(previous) : previous);
    try {
      const result = await api<{ card: Card }>('/review/events', {
        method: 'POST', key: command.idempotency_key, body: command,
      });
      finish((previous) => ({
        ...advance(previous),
        reviewed: [...previous.reviewed, {
          title: operation.title,
          due: result.card.due_at,
          rating,
          durationMs: command.duration_ms,
        }],
      }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'REVIEW_CONFLICT') {
        finish((previous) => ({
          ...previous,
          pending: undefined,
          conflict: 'Your rating is saved, but a card conflict prevented a schedule update. Continue reviewing and resolve it in Settings.',
        }));
      } else {
        const rejected = e instanceof ApiError && [400, 404, 422].includes(e.status);
        if (rejected) finish((previous) => ({ ...previous, pending: undefined }));
        setError(e instanceof Error ? e.message : 'Submission failed');
      }
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }

  const reviewLocked = switchingScope || busy || Boolean(pending) || Boolean(conflict);
  const filtersLocked = reviewLocked || batch.busy;
  return (
    <>
      <Link className="back-link" href={scopedPath('/knowledge', scope)}>
        ← Back to knowledge
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACTIVE RECALL · FSRS</div>
          <h1>Review session</h1>
        </div>
        <div className="inline-actions">
          <Badge tone="purple">
            {totalDone} / {totalCards} reviewed
          </Badge>
          {entry && (
            <Link href="/today#daily-overview" className="button small">
              Pause review
            </Link>
          )}
        </div>
      </div>
      {!cardId && (
        <div className={`collection-toolbar ${scopeStyles.toolbar}`}>
          <SubjectFilter
            label="Review subject"
            subject={subject}
            subjects={subjects.data?.items ?? []}
            disabled={filtersLocked || subjects.loading}
            onChange={(name) =>
              switchScope(() =>
                router.replace(scopedPath('/review/session', { subject: name }), { scroll: false }),
              )
            }
          />
          <ChapterFilter
            scope={scope}
            disabled={filtersLocked}
            onChange={(range) =>
              switchScope(() =>
                router.replace(scopedPath('/review/session', { subject, chapters: range }), {
                  scroll: false,
                }),
              )
            }
          />
        </div>
      )}
      <ErrorState
        error={lookup.error || queue.error || subjects.error}
        retry={lookup.error ? lookup.reload : queue.error ? queue.reload : subjects.reload}
      />
      {((!ready && !entry) || (entry && !current)) &&
        !lookup.error && !queue.error && !pending && !conflict && <Loading />}
      {cardId && (lookup.error || current?.card === null) && (
        <Link href="/today" className="button">
          Back to Dashboard
        </Link>
      )}
      {batch.error && <Notice tone="error">{batch.error}</Notice>}
      {(error || conflict || (deviceError && !pending)) && (
        <Notice tone={conflict ? 'warning' : 'error'}>
          {conflict || error || deviceError}
          {conflict && (
            <div className="inline-actions">
              <button className="button small" onClick={() => changeCard(advance)}>
                Next card
              </button>
              <Link href="/settings" className="text-link">
                Review conflicts →
              </Link>
            </div>
          )}
        </Notice>
      )}
      {pending && !busy && (
        <Notice tone="warning">
          Your previous rating is unconfirmed. Retry {pending.command.rating.toUpperCase()}; the same operation will be reused to prevent duplicate ratings.
          {!card && (
            <div className="inline-actions">
              <button className="button small" onClick={() => void rate(pending.command.rating)}>
                Retry {pending.command.rating.toUpperCase()}
              </button>
            </div>
          )}
        </Notice>
      )}
      {done && (
        <section className="panel session-summary">
          <span className="summary-check">
            <Icon name="check" size={32} />
          </span>
          <h2>{totalCards ? 'Review complete' : 'No cards due right now'}</h2>
          <p className="muted">
            {totalCards
              ? `Reviewed ${totalDone} cards${totalDone ? ` · ${reviewedMinutes} min` : ''}`
              : chapters
                ? 'No cards in this chapter range are due yet. Choose another chapter or return later.'
                : subject !== undefined
                  ? 'No cards in this subject are due yet. Choose another subject or return later.'
                  : cardId
                    ? 'Return to Dashboard to continue with your checklist.'
                    : 'Add more knowledge, or return when your next cards are due.'}
          </p>
          {totalCards > totalDone && (
            <p className="muted">Other cards in this session are no longer available to review.</p>
          )}
          <div className="rating-summary">
            {ratingLabels.map(([rating, title]) => (
              <div key={rating}>
                <strong>{session?.reviewed.filter((item) => item.rating === rating).length ?? 0}</strong>
                <span>{title.toUpperCase()}</span>
              </div>
            ))}
          </div>
          {!!session?.reviewed.length && (
            <div className="next-reviews">
              <h3>{cardId ? 'Next review' : 'Coming up next'}</h3>
              {session.reviewed.map((r, i) => (
                <div key={i}>
                  <span>{r.title.slice(0, 60)}</span>
                  <span>{datetime(r.due)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="inline-actions centered">
            <Link href="/today" className="button primary">
              Back to Dashboard
              <Icon name="arrow" size={16} />
            </Link>
            <Link href={scopedPath('/knowledge', scope)} className="button">
              Browse knowledge
            </Link>
            {session?.cursor && (
              <button
                className="button"
                disabled={batch.busy || switchingScope}
                onClick={() =>
                  void batch.run(async () => {
                    const cursor = session?.cursor;
                    if (!cursor) return;
                    const nextPage = await api<Page<Card>>(
                      `${queuePath}&cursor=${encodeURIComponent(cursor)}`,
                    );
                    updateReviewSession(userId, href, (previous) => previous?.id === session?.id
                      ? newSession(nextPage.items, nextPage.next_cursor)
                      : previous);
                  })
                }
              >
                Review next batch
              </button>
            )}
          </div>
        </section>
      )}
      {card && (
        <section className="review-session">
          <div className="review-progress" role="progressbar" aria-label="Review cards processed"
            aria-valuemin={0} aria-valuemax={totalCards} aria-valuenow={session?.position ?? 0}>
            <span style={{ width: `${((session?.position ?? 0) / Math.max(1, totalCards)) * 100}%` }} />
          </div>
          <article className="panel recall-card">
            <div className="recall-header">
              <Badge tone="purple">{label(card.card_type)}</Badge>
              <Link href={`/knowledge/${card.knowledge_item_id}`} className="text-link">
                Source knowledge ↗
              </Link>
            </div>
            <div className="recall-prompt">
              <span className="eyebrow">PROMPT</span>
              <KnowledgeMarkdown content={card.prompt} />
            </div>
            <MarkdownEditor
              key={`draft:${card.id}`}
              label={proofSteps ? 'Your proof outline' : 'Your answer'}
              hint="Optional · Markdown and LaTeX supported"
              rows={5}
              disabled={reviewLocked}
              placeholder={
                proofSteps
                  ? 'Try recalling the main argument before opening a hint…'
                  : 'Write what you remember…'
              }
              value={draft.text}
              onChange={(text) => updateDraft((previous) => ({ ...previous, text }))}
            />
            {proofSteps && (
              <ProofRecall
                key={`proof:${card.id}`}
                cardId={card.id}
                steps={proofSteps}
                answerRevealed={draft.revealed}
                stuck={draft.stuck}
                hintsUsed={draft.hintsUsed}
                locked={reviewLocked}
                onRevealHint={() => updateDraft((previous) => ({
                  ...previous, hintsUsed: Math.min(previous.hintsUsed + 1, proofSteps.length),
                }))}
                onToggleStuck={(id) => updateDraft((previous) => ({
                  ...previous,
                  stuck: previous.stuck.includes(id)
                    ? previous.stuck.filter((item) => item !== id)
                    : [...previous.stuck, id],
                }))}
              />
            )}
            {draft.revealed ? (
              <div className="recall-answer">
                <span className="eyebrow">REFERENCE ANSWER</span>
                {card.answer.trim() === card.prompt.trim() ? (
                  <p className="muted">The reference answer matches the prompt above.</p>
                ) : (
                  <KnowledgeMarkdown content={card.answer} />
                )}
              </div>
            ) : (
              <div className="reveal-area">
                <button
                  className="button primary"
                  disabled={switchingScope}
                  onClick={() => updateDraft((previous) => ({ ...previous, revealed: true }))}
                >
                  Reveal answer
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            )}
          </article>
          {draft.revealed && !conflict && (
            <div className="rating-actions">
              {ratingLabels.map(([v, title, hint]) => (
                <button
                  key={v}
                  className={`rating-button ${v}`}
                  disabled={
                    switchingScope || busy || (!device && !pending) || (pending && pending.command.rating !== v)
                  }
                  onClick={() => void rate(v)}
                >
                  <strong>{title}</strong>
                  <span>{hint}</span>
                </button>
              ))}
            </div>
          )}
          <p className="review-bottom-note">
            Rate your actual recall. Each card’s schedule is calculated and saved independently.
          </p>
        </section>
      )}
    </>
  );
}
