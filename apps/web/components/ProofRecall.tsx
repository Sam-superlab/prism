'use client';

import { MarkdownEditor } from './MarkdownEditor';

import { useResource, uuid } from '../lib/api';
import type { Page, ProofStep, ReviewEvent } from '../lib/types';
import { Icon, KnowledgeMarkdown } from './ui';
import styles from './ProofRecall.module.css';

export function ProofStepEditor({
  steps,
  onChange,
}: {
  steps: ProofStep[];
  onChange: (steps: ProofStep[]) => void;
}) {
  return (
    <fieldset className={styles.editor}>
      <legend>Proof Recall hints</legend>
      <p className="muted">Add one hint per step, in proof order. PRISM reveals them one at a time.</p>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step.id} className={styles.editorStep}>
            <MarkdownEditor
                label={`Hint for step ${index + 1}`}
                rows={2}
                required
                maxLength={4000}
                value={step.hint}
                onChange={(hint) =>
                  onChange(
                    steps.map((item) => (item.id === step.id ? { ...item, hint } : item)),
                  )
                }
                placeholder="Markdown and LaTeX supported"
              />
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove step ${index + 1}`}
              onClick={() => onChange(steps.filter((item) => item.id !== step.id))}
            >
              <Icon name="close" size={16} />
            </button>
          </li>
        ))}
      </ol>
      <button
        className="button small"
        type="button"
        disabled={steps.length >= 12}
        onClick={() => onChange([...steps, { id: uuid(), hint: '' }])}
      >
        <Icon name="plus" size={15} />
        Add a proof step
      </button>
    </fieldset>
  );
}

export function ProofRecall({
  cardId,
  steps,
  answerRevealed,
  stuck,
  onToggleStuck,
  hintsUsed,
  onRevealHint,
  locked,
}: {
  cardId: string;
  steps: ProofStep[];
  answerRevealed: boolean;
  stuck: string[];
  onToggleStuck: (id: string) => void;
  hintsUsed: number;
  onRevealHint: () => void;
  locked: boolean;
}) {
  const revealedCount = Math.min(hintsUsed, steps.length);
  const history = useResource<Page<ReviewEvent>>(`/review/history?card_id=${cardId}&limit=1`);
  const lastStuck = history.data?.items[0]?.proof_stuck_steps ?? [];
  const revisit = steps.flatMap((step, index) =>
    lastStuck.some((marked) => marked.id === step.id) ? [index + 1] : [],
  );
  const visibleCount = answerRevealed ? steps.length : revealedCount;

  return (
    <section className={styles.recall} aria-label="Proof Recall">
      <div className={styles.heading}>
        <h2>Proof Recall</h2>
        <span className="muted small-text">
          {revealedCount} / {steps.length} hints used
        </span>
      </div>
      {revisit.length > 0 && (
        <p className={styles.revisit}>
          Last time you got stuck on {revisit.length === 1 ? 'step' : 'steps'} {revisit.join(', ')}.
        </p>
      )}
      {visibleCount > 0 && (
        <ol className={styles.steps} role="list" aria-label="Proof hints">
          {steps.slice(0, visibleCount).map((step, index) => (
            <li key={step.id} className={styles.hint}>
              <span className="eyebrow">STEP {index + 1}</span>
              <KnowledgeMarkdown content={step.hint} />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={stuck.includes(step.id)}
                  disabled={locked}
                  onChange={() => onToggleStuck(step.id)}
                />
                Mark step {index + 1} as stuck
              </label>
            </li>
          ))}
        </ol>
      )}
      {!answerRevealed && revealedCount < steps.length && (
        <button
          className="button small"
          disabled={locked}
          onClick={onRevealHint}
        >
          {revealedCount ? 'Reveal next hint' : 'Reveal first hint'}
        </button>
      )}
    </section>
  );
}
