import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useAction, useResource } from '../../lib/api';
import { reviewCardTypes } from '../../lib/review-card-markdown';
import { Badge, ErrorState, Field, MathContent, Modal, Notice, label } from '../ui';
import styles from './DailyReviewDrafts.module.css';

type Draft = { id: string; card_type: (typeof reviewCardTypes)[number]; prompt: string; answer: string };
type DraftGroup = { knowledge_id: string; title: string; cards: Draft[] };
type DraftBatch = {
  date: string;
  status: 'disabled' | 'idle' | 'running' | 'ready' | 'paused' | 'failed';
  items: DraftGroup[];
  message?: string;
};

const endpoint = '/today/review-drafts';

export function DailyReviewDrafts({ date }: { date: string }) {
  const [viewDate, setViewDate] = useState(date);

  return (
    <section className="panel content-panel" aria-label="AI review drafts">
      <div className="panel-heading">
        <h2>AI review drafts</h2>
        <div className={styles.dateField}>
          <Field label="Draft date">
            <input
              type="date"
              max={date}
              value={viewDate}
              onChange={(event) => {
                const value = event.target.value;
                if (!value || value <= date) setViewDate(value || date);
              }}
            />
          </Field>
        </div>
      </div>
      <p className="muted small-text">
        When enabled, PRISM sends OpenAI the titles and text of yesterday’s Knowledge notes you marked with
        “Include this note in AI review drafts.” Review and save the drafts you want to study.
      </p>
      <div hidden={viewDate !== date}>
        <DraftBatchPanel date={date} canRun />
      </div>
      {viewDate !== date && <DraftBatchPanel key={viewDate} date={viewDate} canRun={false} />}
    </section>
  );
}

function DraftBatchPanel({ date, canRun }: { date: string; canRun: boolean }) {
  const { data, setData, error, reload } = useResource<DraftBatch>(`${endpoint}?date=${date}`);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [editing, setEditing] = useState<{ group: DraftGroup; draft: Draft } | null>(null);
  const [saved, setSaved] = useState(false);
  const attempted = useRef(false);
  const inFlight = useRef(false);

  const generate = useCallback(
    async (retry: boolean) => {
      if (inFlight.current) return;
      attempted.current = true;
      inFlight.current = true;
      setGenerating(true);
      setGenerateError('');
      try {
        setData(await api<DraftBatch>(endpoint, { method: 'POST', body: { date, retry } }));
      } catch (error) {
        setGenerateError(error instanceof Error ? error.message : 'Could not generate review drafts.');
        reload();
      } finally {
        inFlight.current = false;
        setGenerating(false);
      }
    },
    [date, reload, setData],
  );

  const status = data?.status;
  useEffect(() => {
    if (canRun && status === 'idle' && !attempted.current) void generate(false);
    if (status === 'running') {
      const timer = window.setInterval(reload, 3000);
      return () => window.clearInterval(timer);
    }
  }, [canRun, status, generate, reload]);

  if (!data && !error) return null;
  const working = generating || status === 'running';
  const canGenerate = canRun && (status === 'idle' || status === 'failed' || status === 'paused');
  const groups = data?.items.filter((group) => group.cards.length > 0) ?? [];

  function onSaved(id: string) {
    setEditing(null);
    setSaved(true);
    setData(
      (current) =>
        current && {
          ...current,
          items: current.items.map((group) => ({
            ...group,
            cards: group.cards.filter((card) => card.id !== id),
          })),
        },
    );
  }

  return (
    <>
      <div className={styles.body}>
        {canGenerate && !working && (
          <div className="inline-actions">
            <button className="button small" onClick={() => void generate(status !== 'idle')}>
              {status === 'paused'
                ? 'Retry after checking credits'
                : status === 'failed'
                  ? 'Retry generation'
                  : 'Generate drafts'}
            </button>
          </div>
        )}
        <ErrorState error={error} retry={reload} />
        {generateError && <Notice tone="error">{generateError}</Notice>}
        {working ? (
          <p className="muted" role="status">
            Preparing review drafts…
          </p>
        ) : (
          data?.message && (
            <p className="muted" role="status">
              {data.message}
            </p>
          )
        )}
        {saved && <p role="status">Review card saved.</p>}
        {status === 'disabled' && !data?.message && <p className="muted">Review draft generation is off.</p>}
        {status === 'idle' && !canRun && <p className="muted">No drafts were generated on this date.</p>}
        {status === 'ready' && !groups.length && !data?.message && (
          <p className="muted">There are no drafts waiting for review.</p>
        )}
        {groups.map((group) => (
          <section className={styles.group} key={group.knowledge_id}>
            <h3>
              <Link href={`/knowledge/${group.knowledge_id}`}>{group.title}</Link>
            </h3>
            {group.cards.map((draft) => (
              <article className={styles.card} key={draft.id}>
                <div className={styles.cardHeading}>
                  <Badge>{label(draft.card_type)}</Badge>
                  <button className="button small" onClick={() => setEditing({ group, draft })}>
                    Review draft
                  </button>
                </div>
                <MathContent content={draft.prompt} />
              </article>
            ))}
          </section>
        ))}
      </div>
      {editing && (
        <DraftEditor
          key={editing.draft.id}
          {...editing}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
          reload={reload}
        />
      )}
    </>
  );
}

function DraftEditor({
  group,
  draft,
  onClose,
  onSaved,
  reload,
}: {
  group: DraftGroup;
  draft: Draft;
  onClose: () => void;
  onSaved: (id: string) => void;
  reload: () => void;
}) {
  const [card, setCard] = useState(draft);
  const action = useAction(() => onSaved(card.id));
  const inputLimit = 200_000;

  return (
    <Modal title="Review AI draft" wide onClose={() => !action.busy && onClose()}>
      <p className="muted">From {group.title}. Check the math before adding this to your study queue.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (action.busy || !card.prompt.trim() || !card.answer.trim()) return;
          void action.run(async () => {
            try {
              await api(`/knowledge-items/${group.knowledge_id}/cards/batch`, {
                method: 'POST',
                key: card.id,
                body: { cards: [{ ...card, prompt: card.prompt.trim(), answer: card.answer.trim() }] },
              });
            } catch (error) {
              reload();
              throw error;
            }
          });
        }}
      >
        <Field label="Card type">
          <select
            value={card.card_type}
            disabled={action.busy}
            onChange={(event) => setCard({ ...card, card_type: event.target.value as Draft['card_type'] })}
          >
            {reviewCardTypes.map((type) => (
              <option key={type} value={type}>
                {label(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prompt">
          <textarea
            value={card.prompt}
            rows={3}
            required
            maxLength={inputLimit}
            disabled={action.busy}
            onChange={(event) => setCard({ ...card, prompt: event.target.value })}
          />
        </Field>
        <Field label="Answer">
          <textarea
            value={card.answer}
            rows={5}
            required
            maxLength={inputLimit}
            disabled={action.busy}
            onChange={(event) => setCard({ ...card, answer: event.target.value })}
          />
        </Field>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div className="modal-footer">
          <button className="button" type="button" disabled={action.busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={action.busy || !card.prompt.trim() || !card.answer.trim()}
          >
            {action.busy ? 'Saving…' : 'Add to review queue'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
