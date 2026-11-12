'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import {
  guideCopy,
  guideLanguages,
  normalizeGuideLanguage,
  type GuideLanguage,
} from '../lib/getting-started-copy';
import type { Knowledge, Page, ReviewEvent } from '../lib/types';
import { ArxivInterestGuide, readArxivInterestDraft, type ArxivInterestDraft } from './ArxivInterestGuide';
import { Icon, KnowledgeMarkdown, Modal, Notice } from './ui';
import { CardEditor, KnowledgeEditor } from './pages/Knowledge';
import styles from './GettingStarted.module.css';

type Progress = {
  status: 'welcome' | 'active' | 'hidden';
  noteId?: string;
  cardId?: string;
  reviewed?: boolean;
  exampleIds?: { note: string; card: string; language?: GuideLanguage };
  interests?: ArxivInterestDraft;
};

export function useGettingStarted(userId: string | undefined, isToday: boolean) {
  const key = userId && `prism.getting-started.v1.${userId}`;
  const languageKey = userId && `prism.guide-language.v1.${userId}`;
  const [stored, setStored] = useState<{ key: string; progress: Progress | null }>();
  const [languagePreference, setLanguagePreference] = useState<{ key: string; language: GuideLanguage }>();
  const progress = stored?.key === key ? stored?.progress : undefined;
  const language = languagePreference?.key === languageKey ? (languagePreference?.language ?? 'en') : 'en';

  useEffect(() => {
    if (!languageKey) return;
    try {
      const language = normalizeGuideLanguage(localStorage.getItem(languageKey)) ?? 'en';
      setLanguagePreference({ key: languageKey, language });
    } catch {
      // The default language remains available without browser storage.
    }
  }, [languageKey]);

  function changeLanguage(language: GuideLanguage) {
    if (!languageKey) return;
    setLanguagePreference({ key: languageKey, language });
    try {
      localStorage.setItem(languageKey, language);
    } catch {
      // Keep the selection for this visit when browser storage is unavailable.
    }
  }

  const update = useCallback(
    (next: Progress) => {
      if (!key) return;
      setStored({ key, progress: next });
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Keep the guide usable for this visit when browser storage is unavailable.
      }
    },
    [key],
  );

  useEffect(() => {
    if (!key) return;
    let progress: Progress | null = null;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Progress | null;
      if (value && ['welcome', 'active', 'hidden'].includes(value.status)) {
        progress = { ...value, interests: readArxivInterestDraft(value.interests) };
      }
    } catch {
      // Treat unavailable storage as a first visit.
    }
    setStored({ key, progress });
  }, [key]);

  useEffect(() => {
    if (!key || !isToday || progress !== null) return;
    const controller = new AbortController();
    const collections = ['knowledge-items', 'research/projects', 'tasks', 'inbox', 'arxiv/subscriptions'];
    void Promise.all(
      collections.map((path) => api<Page<unknown>>(`/${path}?limit=1`, { signal: controller.signal })),
    )
      .then((pages) => {
        if (!controller.signal.aborted) {
          update({ status: pages.some((page) => page.items.length > 0) ? 'hidden' : 'welcome' });
        }
      })
      .catch(() => {
        // Leave Today usable if onboarding cannot check the workspace.
      });
    return () => controller.abort();
  }, [key, isToday, progress, update]);

  return { progress, update, language, changeLanguage };
}

export function GuideLanguageSelect({
  language,
  onChange,
  disabled,
}: {
  language: GuideLanguage;
  onChange: (language: GuideLanguage) => void;
  disabled?: boolean;
}) {
  return (
    <label className={styles.language} lang={language}>
      <span>{guideCopy[language].language}</span>
      <select
        value={language}
        disabled={disabled}
        onChange={(event) => {
          const next = normalizeGuideLanguage(event.target.value);
          if (next) onChange(next);
        }}
      >
        {guideLanguages.map(({ value, label }) => (
          <option key={value} value={value} lang={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GettingStarted({
  progress,
  update,
  language,
  onLanguageChange,
  onCardSaved,
  onDiscover,
}: {
  progress: Progress;
  update: (progress: Progress) => void;
  language: GuideLanguage;
  onLanguageChange: (language: GuideLanguage) => void;
  onCardSaved: () => void;
  onDiscover: (jobId?: string) => void;
}) {
  const copy = guideCopy[language];
  const [panel, setPanel] = useState<'note' | 'card' | 'example'>();
  const note = useResource<Knowledge>(
    panel === 'card' && progress.noteId ? `/knowledge-items/${progress.noteId}` : null,
  );
  const cardHistory = useResource<Page<ReviewEvent>>(
    progress.status === 'active' && progress.cardId && !progress.reviewed
      ? `/review/history?card_id=${progress.cardId}&limit=1`
      : null,
  );
  const reviewed =
    progress.reviewed || cardHistory.data?.items.some((event) => event.card_id === progress.cardId) === true;
  const complete = Boolean(progress.noteId && progress.cardId && reviewed);
  const active = { ...progress, status: 'active' as const };
  const hide = () => update({ ...progress, status: 'hidden' });

  useEffect(() => {
    if (reviewed && !progress.reviewed) update({ ...progress, reviewed: true });
  }, [reviewed, progress, update]);

  if (progress.status === 'hidden') return null;

  return (
    <>
      {progress.status === 'welcome' ? (
        <ArxivInterestGuide
          language={language}
          languageControl={<GuideLanguageSelect language={language} onChange={onLanguageChange} />}
          draft={progress.interests}
          onChange={(interests) => update({ ...progress, interests })}
          onSkip={hide}
          onFinish={(jobId) => {
            update({ ...progress, status: 'hidden', interests: undefined });
            onDiscover(jobId);
          }}
        />
      ) : (
        <section
          className={`panel content-panel ${styles.checklist}`}
          aria-label={copy.gettingStarted}
          lang={language}
        >
          <div className="panel-heading">
            <h2>{complete ? copy.firstReviewDone : copy.gettingStarted}</h2>
            <button className="button small" onClick={hide}>
              {complete ? copy.done : copy.skip}
            </button>
          </div>
          <GuideLanguageSelect language={language} onChange={onLanguageChange} />
          <ol className={styles.steps}>
            <li>
              <Step
                done={Boolean(progress.noteId)}
                title={copy.createNoteTitle}
                detail={copy.createNoteDetail}
                status={progress.noteId ? copy.complete : copy.todo}
              />
              {progress.noteId ? (
                <Link href={`/knowledge/${progress.noteId}`} className="button small">
                  {copy.openNote}
                </Link>
              ) : (
                <button className="button primary small" onClick={() => setPanel('note')}>
                  {copy.createNote}
                </button>
              )}
            </li>
            <li>
              <Step
                done={Boolean(progress.cardId)}
                title={copy.makeCardTitle}
                detail={copy.makeCardDetail}
                status={progress.cardId ? copy.complete : copy.todo}
              />
              {progress.noteId && !progress.cardId && (
                <button className="button primary small" onClick={() => setPanel('card')}>
                  {copy.makeCard}
                </button>
              )}
            </li>
            <li>
              <Step
                done={reviewed}
                title={copy.reviewTitle}
                detail={copy.reviewDetail}
                status={reviewed ? copy.complete : copy.todo}
              />
              {progress.cardId && !reviewed && (
                <Link href={`/review/session?card=${progress.cardId}`} className="button primary small">
                  {copy.startReview}
                </Link>
              )}
            </li>
          </ol>
          {!complete && !progress.noteId && (
            <button className={`button small ${styles.exampleLink}`} onClick={() => setPanel('example')}>
              {copy.tryExample}
            </button>
          )}
          <div className={styles.topics}>
            <h3>{copy.optionalTopics}</h3>
            <ul>
              <li>
                <h4>{copy.practiceTitle}</h4>
                <p className="muted">{copy.practiceDetail}</p>
                <Link className="text-link" href="/practice">
                  {copy.practiceLink}
                </Link>
              </li>
              <li>
                <h4>{copy.appearanceTitle}</h4>
                <p className="muted">{copy.appearanceDetail}</p>
                <Link className="text-link" href="/settings#appearance-heading">
                  {copy.appearanceLink}
                </Link>
              </li>
            </ul>
          </div>
        </section>
      )}
      {panel === 'note' && (
        <KnowledgeEditor
          initialType="note"
          onClose={() => setPanel(undefined)}
          onSaved={(item) => {
            update({ ...active, noteId: item.id, cardId: undefined, reviewed: false });
            setPanel(undefined);
          }}
        />
      )}
      {panel === 'card' &&
        (note.data ? (
          <CardEditor
            knowledge={note.data}
            onClose={() => setPanel(undefined)}
            onSaved={(card) => {
              update({ ...active, cardId: card.id });
              onCardSaved();
              setPanel(undefined);
            }}
          />
        ) : (
          <Modal
            title={copy.makeCardTitle}
            lang={language}
            closeLabel={copy.close}
            onClose={() => setPanel(undefined)}
          >
            {note.error ? (
              <>
                <Notice tone="error">{note.error.message}</Notice>
                <div className={`modal-footer ${styles.actions}`}>
                  <button className="button" onClick={note.reload}>
                    {copy.retry}
                  </button>
                  <button className="button" onClick={() => setPanel('note')}>
                    {copy.newNote}
                  </button>
                </div>
              </>
            ) : (
              <p role="status">{copy.openingNote}</p>
            )}
          </Modal>
        ))}
      {panel === 'example' && (
        <Example
          language={
            progress.exampleIds ? (normalizeGuideLanguage(progress.exampleIds.language) ?? 'en') : language
          }
          onClose={() => setPanel(undefined)}
          onKeep={async (exampleLanguage) => {
            const ids = progress.exampleIds ?? { note: uuid(), card: uuid(), language: exampleLanguage };
            const { example } = guideCopy[exampleLanguage];
            update({ ...active, exampleIds: ids });
            await api('/knowledge-items', {
              method: 'POST',
              body: { id: ids.note, title: example.title, type: 'definition', content: example.content },
            });
            await api(`/knowledge-items/${ids.note}/cards`, {
              method: 'POST',
              body: { id: ids.card, card_type: 'statement', prompt: example.prompt, answer: example.content },
            });
            update({ status: 'active', noteId: ids.note, cardId: ids.card });
            onCardSaved();
            setPanel(undefined);
          }}
        />
      )}
    </>
  );
}

function Step({
  done,
  title,
  detail,
  status,
}: {
  done?: boolean;
  title: string;
  detail: string;
  status: string;
}) {
  return (
    <div className={styles.step}>
      <span className={`${styles.marker} ${done ? styles.done : ''}`} aria-hidden="true">
        {done && <Icon name="check" size={13} />}
      </span>
      <div>
        <strong>{title}</strong>
        <span className={styles.status}> {status}</span>
        <p className="muted">{detail}</p>
      </div>
    </div>
  );
}

function Example({
  language,
  onClose,
  onKeep,
}: {
  language: GuideLanguage;
  onClose: () => void;
  onKeep: (language: GuideLanguage) => Promise<void>;
}) {
  const copy = guideCopy[language];
  const { example } = copy;
  const [step, setStep] = useState<'note' | 'card' | 'answer' | 'rated'>('note');
  const action = useAction();
  return (
    <Modal
      title={copy.tryExample}
      lang={language}
      closeLabel={copy.close}
      onClose={() => {
        if (!action.busy) onClose();
      }}
    >
      <p className="modal-description">{copy.exampleDetail}</p>
      <div className={styles.sample}>
        <span className="eyebrow">{step === 'note' ? copy.sampleNote : copy.sampleCard}</span>
        <h3>{step === 'note' ? example.title : example.prompt}</h3>
        {step === 'card' ? (
          <p className="muted">{copy.sampleRecall}</p>
        ) : (
          <KnowledgeMarkdown content={example.content} />
        )}
        {step === 'answer' && (
          <div className="inline-actions">
            {copy.ratings.map((rating) => (
              <button key={rating} className="button small" onClick={() => setStep('rated')}>
                {rating}
              </button>
            ))}
          </div>
        )}
        {step === 'rated' && <p>{copy.sampleRated}</p>}
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <div className={`modal-footer ${styles.actions}`}>
        <button className="button" disabled={action.busy} onClick={onClose}>
          {copy.backToChecklist}
        </button>
        {step === 'note' && (
          <button className="button primary" onClick={() => setStep('card')}>
            {copy.seeReviewCard}
          </button>
        )}
        {step === 'card' && (
          <button className="button primary" onClick={() => setStep('answer')}>
            {copy.revealAnswer}
          </button>
        )}
        <button
          className={`button ${step === 'rated' || step === 'answer' ? 'primary' : ''}`}
          disabled={action.busy}
          onClick={() => void action.run(() => onKeep(language))}
        >
          {action.busy ? copy.saving : copy.keepExample}
        </button>
      </div>
    </Modal>
  );
}
