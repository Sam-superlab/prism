'use client';

import { useMemo, useRef, useState } from 'react';
import { api, useAction, uuid } from '../lib/api';
import { API_BODY_LIMIT } from '../lib/request-body';
import { parseReviewCards, reviewCardTemplate } from '../lib/review-card-markdown';
import { Field, KnowledgeMarkdown, Modal, Notice, label } from './ui';

export function ReviewCardImport({
  knowledgeId,
  onClose,
  onSaved,
}: {
  knowledgeId: string;
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const [source, setSource] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const action = useAction();
  const parsed = useMemo(() => {
    try {
      if (source.length > API_BODY_LIMIT)
        throw new Error('This import is too large. Split it into smaller batches.');
      return { cards: parseReviewCards(source), error: '' };
    } catch (error) {
      return { cards: [], error: error instanceof Error ? error.message : 'Could not read the Markdown.' };
    }
  }, [source]);
  const attempt = useRef<{
    draft: string;
    key: string;
    cards: ((typeof parsed.cards)[number] & { id: string })[];
  }>(null);
  const count = parsed.cards.length;

  return (
    <Modal title="Import review cards from Markdown" onClose={() => !action.busy && onClose()} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!count || action.busy) return;
          void action.run(async () => {
            const draft = JSON.stringify(parsed.cards);
            if (attempt.current?.draft !== draft) {
              attempt.current = {
                draft,
                key: uuid(),
                cards: parsed.cards.map((card) => ({ ...card, id: uuid() })),
              };
            }
            const { key, cards } = attempt.current;
            const body = { cards };
            if (new TextEncoder().encode(JSON.stringify(body)).length > API_BODY_LIMIT) {
              throw new Error('This import is too large. Split it into smaller batches.');
            }
            const result = await api<{ items: { id: string }[] }>(
              `/knowledge-items/${knowledgeId}/cards/batch`,
              {
                method: 'POST',
                key,
                body,
              },
            );
            onSaved(result.items.length);
          });
        }}
      >
        <p className="panel-description">
          Paste up to 50 cards. Markdown and LaTeX are preserved in prompts and answers.
        </p>
        <details>
          <summary>Show Markdown template</summary>
          <KnowledgeMarkdown content={'```markdown\n' + reviewCardTemplate + '\n```'} />
        </details>
        <Field label="Review card Markdown">
          <textarea
            autoFocus
            rows={9}
            className="code-editor"
            value={source}
            placeholder={'## Card: statement\n### Prompt\nYour question\n\n### Answer\nYour answer'}
            onChange={(event) => {
              setSource(event.target.value);
              action.setError(null);
            }}
            disabled={action.busy}
          />
        </Field>
        {parsed.error && <Notice tone="error">{parsed.error}</Notice>}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {count > 0 && (
          <details onToggle={(event) => setShowPreview(event.currentTarget.open)}>
            <summary>
              Preview {count} {count === 1 ? 'card' : 'cards'}
            </summary>
            {showPreview && (
              <ol>
                {parsed.cards.map((card, index) => (
                  <li key={index}>
                    <span className="eyebrow">{label(card.card_type)}</span>
                    <KnowledgeMarkdown content={card.prompt} />
                    <KnowledgeMarkdown content={card.answer} />
                  </li>
                ))}
              </ol>
            )}
          </details>
        )}
        <div className="modal-footer">
          <button className="button" type="button" onClick={onClose} disabled={action.busy}>
            Cancel
          </button>
          <button className="button primary" disabled={!count || action.busy}>
            {action.busy
              ? 'Creating cards…'
              : count
                ? `Create ${count} ${count === 1 ? 'card' : 'cards'}`
                : 'Create cards'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
