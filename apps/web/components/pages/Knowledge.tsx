'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, datetime, useAction, useResource, uuid } from '../../lib/api';
import type { Card, Entity, Knowledge, Page, ReviewEvent } from '../../lib/types';
import {
  Badge,
  Empty,
  ErrorState,
  Field,
  Icon,
  Loading,
  MathContent,
  Modal,
  Notice,
  knowledgeTypes,
  label,
} from '../ui';

export function KnowledgePage({ id }: { id?: string }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [editor, setEditor] = useState(false);
  const items = useResource<Page<Knowledge>>(
    `/knowledge-items?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}${type ? `&type=${type}` : ''}`,
  );
  if (id) return <KnowledgeDetail id={id} />;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE & RETENTION</div>
          <h1>Make understanding last.</h1>
          <p>Keep precise notes. Review statements, proofs, and applications independently.</p>
        </div>
        <div className="heading-actions">
          <Link href="/review/session" className="button">
            Start review
            <Icon name="arrow" size={16} />
          </Link>
          <button className="button primary" onClick={() => setEditor(true)}>
            <Icon name="plus" size={17} />
            New knowledge
          </button>
        </div>
      </div>
      <div className="collection-toolbar">
        <label className="filter-search">
          <Icon name="search" size={18} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search knowledge titles or content…"
          />
        </label>
        <select aria-label="Knowledge type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {knowledgeTypes.map((t) => (
            <option key={t} value={t}>
              {label(t)}
            </option>
          ))}
        </select>
        <span className="muted small-text">{items.data?.items.length ?? '—'} knowledge items</span>
      </div>
      <ErrorState error={items.error} retry={items.reload} />
      {items.loading && !items.data && <Loading />}
      {items.data?.items.length === 0 && (
        <div className="panel">
          <Empty
            title={q ? 'No matching knowledge' : 'Start with a definition worth remembering'}
            action={
              <button className="button primary" onClick={() => setEditor(true)}>
                Create your first knowledge item
              </button>
            }
          >
            Definitions, theorems, proofs, and counterexamples all belong here.
          </Empty>
        </div>
      )}
      <div className="knowledge-grid">
        {items.data?.items.map((item, i) => (
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
                {item.tags.length ? ` · ${item.tags[0]}` : ''}
              </span>
              <span className={`verification ${item.verification_status !== 'unverified' ? 'verified' : ''}`}>
                <span />
                {label(item.verification_status)}
              </span>
            </div>
            <Icon name="arrow" className="knowledge-arrow" size={18} />
          </Link>
        ))}
      </div>
      {items.data?.next_cursor && (
        <button
          className="button"
          onClick={async () => {
            const next = await api<Page<Knowledge>>(
              `/knowledge-items?limit=100&cursor=${encodeURIComponent(items.data!.next_cursor!)}${q ? `&q=${encodeURIComponent(q)}` : ''}${type ? `&type=${type}` : ''}`,
            );
            items.setData({ ...next, items: [...items.data!.items, ...next.items] });
          }}
        >
          Load more
        </button>
      )}
      {editor && (
        <KnowledgeEditor
          onClose={() => setEditor(false)}
          onSaved={(item) => {
            setEditor(false);
            window.location.href = `/knowledge/${item.id}`;
          }}
        />
      )}
    </>
  );
}
function KnowledgeDetail({ id }: { id: string }) {
  const item = useResource<Knowledge>(`/knowledge-items/${id}`);
  const cards = useResource<Page<Card>>(`/knowledge-items/${id}/cards`);
  const [edit, setEdit] = useState(false);
  const [cardEdit, setCardEdit] = useState<Card | 'new' | null>(null);
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
  return (
    <>
      <Link className="back-link" href="/knowledge">
        ← All knowledge
      </Link>
      <div className="page-heading detail-heading">
        <div>
          <div className="eyebrow">
            {label(k.type).toUpperCase()} · {k.subject || 'KNOWLEDGE'}
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
          <button
            className="icon-button danger"
            aria-label="Archive knowledge"
            onClick={() => {
              if (confirm('Archive this knowledge item and its cards? Review history will be preserved.'))
                void action.run(async () => {
                  await api(`/knowledge-items/${id}`, { method: 'DELETE', version: k.version });
                  window.location.href = '/knowledge';
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
            <MathContent content={k.content} />
            {k.proof_content && (
              <>
                <div className="content-divider" />
                <h3 className="section-small-title">Proof / Explanation</h3>
                <MathContent content={k.proof_content} />
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
              <button className="button small" onClick={() => setCardEdit('new')}>
                <Icon name="plus" size={15} />
                Add card
              </button>
            </div>
            <p className="panel-description">
              Knowing a statement is different from knowing its proof. Each card has its own FSRS schedule.
            </p>
            <ErrorState error={cards.error} retry={cards.reload} />
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
            <Link href="/review/session" className="text-link">
              Start reviewing →
            </Link>
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
          onClose={() => setCardEdit(null)}
          onSaved={() => {
            setCardEdit(null);
            cards.reload();
          }}
        />
      )}{' '}
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
export function KnowledgeEditor({
  item,
  initialType = 'theorem',
  onClose,
  onSaved,
}: {
  item?: Knowledge;
  initialType?: Knowledge['type'];
  onClose: () => void;
  onSaved: (item: Knowledge) => void;
}) {
  const [creationId] = useState(uuid);
  const [title, setTitle] = useState(item?.title || '');
  const [type, setType] = useState(item?.type || initialType);
  const [subject, setSubject] = useState(item?.subject || '');
  const [tags, setTags] = useState(item?.tags.join(', ') || '');
  const [content, setContent] = useState(item?.content || '');
  const [proof, setProof] = useState(item?.proof_content || '');
  const [source, setSource] = useState(item?.source_reference || '');
  const [verification, setVerification] = useState(item?.verification_status || 'unverified');
  const [preview, setPreview] = useState(false);
  const action = useAction();
  return (
    <Modal title={item ? 'Edit knowledge item' : 'New knowledge item'} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const body = {
              title,
              type,
              subject,
              tags: tags
                .split(/[,，]/)
                .map((x) => x.trim())
                .filter(Boolean),
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
          <Field label="Subject / course">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Commutative Algebra"
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="modules, local rings"
            />
          </Field>
        </div>
        <div className="editor-toolbar">
          <span>MATHEMATICAL CONTENT</span>
          <button type="button" className="text-link" onClick={() => setPreview(!preview)}>
            {preview ? 'Back to editor' : 'Preview rendering'}
          </button>
        </div>
        {preview ? (
          <div className="math-preview">
            <MathContent content={content || 'Your preview will appear here.'} />
          </div>
        ) : (
          <Field label="Mathematical content" hint="Use $...$ for inline math and $$...$$ for display math.">
            <textarea
              className="code-editor"
              required
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write the complete statement, including every required hypothesis."
            />
          </Field>
        )}
        <Field label="Proof / explanation (optional)">
          <textarea
            className="code-editor"
            rows={5}
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            placeholder="A proof, explanation, or key idea…"
          />
        </Field>
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
  onClose,
  onSaved,
}: {
  knowledge: Knowledge;
  card?: Card;
  onClose: () => void;
  onSaved: (saved: Card) => void;
}) {
  const [creationId] = useState(uuid);
  const [type, setType] = useState(card?.card_type || 'statement');
  const [prompt, setPrompt] = useState(
    card?.prompt || `State ${knowledge.title}, including all required hypotheses.`,
  );
  const [answer, setAnswer] = useState(card?.answer || knowledge.content);
  const action = useAction();
  return (
    <Modal title={card ? 'Edit review card' : 'Create an independent review card'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const saved = await api<Card>(
              card ? `/review/cards/${card.id}` : `/knowledge-items/${knowledge.id}/cards`,
              {
                method: card ? 'PATCH' : 'POST',
                version: card?.version,
                body: { ...(card ? {} : { id: creationId }), card_type: type, prompt, answer },
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
            {['statement', 'hypotheses', 'proof', 'example', 'counterexample', 'application', 'custom'].map(
              (x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ),
            )}
          </select>
        </Field>
        <Field label="Prompt">
          <textarea required rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <Field label="Reference answer">
          <textarea
            required
            rows={6}
            className="code-editor"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </Field>
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
            <div key={x.id}>
              <span>{datetime(x.reviewed_at)}</span>
              <Badge tone={x.rating === 'again' ? 'peach' : 'green'}>{x.rating.toUpperCase()}</Badge>
              <span>{Math.round(x.duration_ms / 1000)} sec</span>
            </div>
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

export function ReviewPage({ cardId }: { cardId?: string }) {
  const queue = useResource<Page<Card>>(cardId ? null : '/review/queue?limit=100');
  const selectedCard = useResource<Card>(cardId ? `/review/cards/${cardId}` : null);
  const [device, setDevice] = useState('');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [ratings, setRatings] = useState<Record<string, number>>({ again: 0, hard: 0, good: 0, easy: 0 });
  const [reviewed, setReviewed] = useState<{ title: string; due: string }[]>([]);
  const started = useRef(0);
  const sessionStart = useRef(0);
  const pendingReview = useRef<{
    cardId: string;
    rating: string;
    key: string;
    reviewedAt: string;
    durationMs: number;
  } | null>(null);
  const requestInFlight = useRef(false);
  const [pendingRating, setPendingRating] = useState<string | null>(null);
  useEffect(() => {
    started.current = performance.now();
    sessionStart.current = performance.now();
    let cancelled = false;
    void (async () => {
      const saved = localStorage.getItem('prism-web-device');
      const devices = await api<Page<Entity & { platform: string }>>('/devices');
      const existing =
        devices.items.find((d) => d.id === saved && d.platform === 'web') ||
        devices.items.find((d) => d.platform === 'web');
      const id = existing?.id || uuid();
      if (!existing)
        await api('/devices', { method: 'POST', body: { id, name: 'PRISM Web', platform: 'web' } });
      localStorage.setItem('prism-web-device', id);
      if (!cancelled) setDevice(id);
    })().catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);
  const focused = selectedCard.data;
  const cards = cardId ? (focused ? [focused] : []) : queue.data?.items || [];
  const card = cards[index];
  const done = Boolean((cardId ? focused : queue.data) && !card);
  const totalDone = Object.values(ratings).reduce((a, b) => a + b, 0);
  function next() {
    pendingReview.current = null;
    setPendingRating(null);
    setIndex((i) => i + 1);
    setRevealed(false);
    setConflict(false);
    setError('');
    started.current = performance.now();
  }
  async function rate(rating: string) {
    if (!card || !device || requestInFlight.current) return;
    if (pendingReview.current && pendingReview.current.rating !== rating) {
      setError('Your previous rating is still unconfirmed. Retry the same rating.');
      return;
    }
    requestInFlight.current = true;
    setBusy(true);
    setError('');
    const pending = (pendingReview.current ||= {
      cardId: card.id,
      rating,
      key: uuid(),
      reviewedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started.current),
    });
    setPendingRating(rating);
    try {
      const result = await api<{ card: Card }>('/review/events', {
        method: 'POST',
        key: pending.key,
        body: {
          card_id: pending.cardId,
          device_id: device,
          rating: pending.rating,
          reviewed_at: pending.reviewedAt,
          duration_ms: pending.durationMs,
          base_version: card.version,
          idempotency_key: pending.key,
        },
      });
      setRatings((x) => ({ ...x, [rating]: x[rating] + 1 }));
      setReviewed((x) => [...x, { title: card.prompt, due: result.card.due_at }]);
      next();
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        pendingReview.current = null;
        setPendingRating(null);
      }
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setError(
          'Your rating is saved, but a card conflict prevented a schedule update. Continue reviewing and resolve it in Settings.',
        );
      } else
        setError(
          `${e instanceof Error ? e.message : 'Submission failed'}${pendingReview.current ? ` Retry ${rating.toUpperCase()}; the same operation will be reused to prevent duplicate ratings.` : ''}`,
        );
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Link className="back-link" href="/knowledge">
        ← Back to knowledge
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACTIVE RECALL · FSRS</div>
          <h1>{done ? 'Keep today’s understanding with you.' : 'One card. Your full attention.'}</h1>
          <p>
            {done
              ? 'An honest attempt at recall builds lasting understanding.'
              : 'Recall it on your own. Reveal the reference answer when you are ready.'}
          </p>
        </div>
        <Badge tone="purple">
          {totalDone} / {cards.length} reviewed
        </Badge>
      </div>
      <ErrorState
        error={cardId ? selectedCard.error : queue.error}
        retry={cardId ? selectedCard.reload : queue.reload}
      />
      {(cardId ? selectedCard.loading && !focused : queue.loading && !queue.data) && <Loading />}
      {cardId && selectedCard.error && (
        <Link href="/today" className="button">
          Back to Today
        </Link>
      )}
      {error && (
        <Notice tone={conflict ? 'warning' : 'error'}>
          {error}
          {conflict && (
            <div className="inline-actions">
              <button className="button small" onClick={next}>
                Next card
              </button>
              <Link href="/settings" className="text-link">
                Review conflicts →
              </Link>
            </div>
          )}
        </Notice>
      )}
      {done && (
        <section className="panel session-summary">
          <span className="summary-check">
            <Icon name="check" size={32} />
          </span>
          <h2>{cards.length ? 'Review complete' : 'No cards due right now'}</h2>
          <p className="muted">
            {cards.length
              ? `Reviewed ${totalDone} cards · ${Math.max(1, Math.round((performance.now() - sessionStart.current) / 60000))} min`
              : 'Add more knowledge, or return when your next cards are due.'}
          </p>
          <div className="rating-summary">
            {Object.entries(ratings).map(([r, n]) => (
              <div key={r}>
                <strong>{n}</strong>
                <span>{r.toUpperCase()}</span>
              </div>
            ))}
          </div>
          {reviewed.length > 0 && (
            <div className="next-reviews">
              <h3>{cardId ? 'Next review' : 'Coming up next'}</h3>
              {reviewed.map((r, i) => (
                <div key={i}>
                  <span>{r.title.slice(0, 60)}</span>
                  <span>{datetime(r.due)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="inline-actions centered">
            <Link href="/today" className="button primary">
              Back to Today
              <Icon name="arrow" size={16} />
            </Link>
            <Link href="/knowledge" className="button">
              Browse knowledge
            </Link>
            {queue.data?.next_cursor && (
              <button
                className="button"
                onClick={async () => {
                  const nextPage = await api<Page<Card>>(
                    `/review/queue?limit=100&cursor=${encodeURIComponent(queue.data!.next_cursor!)}`,
                  );
                  queue.setData(nextPage);
                  setIndex(0);
                }}
              >
                Review next batch
              </button>
            )}
          </div>
        </section>
      )}
      {card && (
        <section className="review-session">
          <div className="review-progress">
            <span style={{ width: `${(index / Math.max(1, cards.length)) * 100}%` }} />
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
              <MathContent content={card.prompt} />
            </div>
            {revealed ? (
              <div className="recall-answer">
                <span className="eyebrow">REFERENCE ANSWER</span>
                <MathContent content={card.answer} />
              </div>
            ) : (
              <div className="reveal-area">
                <span className="muted">Try a complete answer in your head or on paper.</span>
                <button className="button primary" onClick={() => setRevealed(true)}>
                  Reveal answer
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            )}
          </article>
          {revealed && !conflict && (
            <div className="rating-actions">
              {[
                ['again', 'Again', 'Needs relearning'],
                ['hard', 'Hard', 'Recalled with difficulty'],
                ['good', 'Good', 'Recalled correctly'],
                ['easy', 'Easy', 'Effortless and complete'],
              ].map(([v, title, hint]) => (
                <button
                  key={v}
                  className={`rating-button ${v}`}
                  disabled={busy || !device || (pendingRating !== null && pendingRating !== v)}
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
