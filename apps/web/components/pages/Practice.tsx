'use client';

import Link from 'next/link';
import { memo, useEffect, useMemo, useState } from 'react';
import { api, datetime, useAction, useResource, uuid } from '../../lib/api';
import type { GuideLanguage } from '../../lib/getting-started-copy';
import type { Card, Knowledge, Page, ReviewEvent } from '../../lib/types';
import {
  extractTextbookExercises,
  readTextbookHtml,
  readTextbookPdf,
  textbookPdfLimits,
  type ExerciseCandidate,
} from '../../lib/textbook-extraction';
import { convertTextbookMath } from '../../lib/textbook-math';
import {
  exerciseId,
  loadPracticeLibrary,
  loadPracticePdf,
  outcomes,
  readTextbookWebPage,
  recordPracticeAttempt,
  savePracticeExercise,
  savePracticeImport,
  sourceAddress,
  type Outcome,
  type PracticeAttempt,
  type PracticeExercise,
  type PracticeLibrary,
  type PracticePdf,
} from '../../lib/textbook-practice';
import { Empty, ErrorState, Field, Loading, MathContent, Modal, Notice } from '../ui';
import { ModuleGuide, ModuleGuideHint, useModuleGuide, type ModuleGuideState } from '../ModuleGuide';
import { exampleExercisePdf } from '../../lib/practice-guide-sample';
import styles from './Practice.module.css';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function pageReference(fromPage?: number, toPage?: number) {
  if (fromPage === undefined) return '';
  return toPage === undefined || fromPage === toPage
    ? `PDF page ${fromPage}`
    : `PDF pages ${fromPage}–${toPage}`;
}

function useRecentReviewGaps(enabled: boolean) {
  const [gaps, setGaps] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    async function load() {
      const { items } = await api<Page<ReviewEvent>>('/review/history?limit=100', {
        signal: controller.signal,
      });
      const latest = new Map<string, ReviewEvent>();
      for (const event of items) {
        const previous = latest.get(event.card_id);
        if (!previous || previous.reviewed_at < event.reviewed_at) latest.set(event.card_id, event);
      }
      const hardCards = [...latest.values()]
        .filter((event) => event.rating === 'again' || event.rating === 'hard')
        .slice(0, 20);
      const cards = await Promise.allSettled(
        hardCards.map((event) => api<Card>(`/review/cards/${event.card_id}`, { signal: controller.signal })),
      );
      if (!controller.signal.aborted) {
        setGaps(
          new Set(
            cards.flatMap((card) => (card.status === 'fulfilled' ? [card.value.knowledge_item_id] : [])),
          ),
        );
      }
    }
    void load().catch(() => {});
    return () => controller.abort();
  }, [enabled]);
  return gaps;
}

function rankExercise(exercise: PracticeExercise, lastAttempt?: PracticeAttempt, linkedGap = false) {
  const reasons: string[] = [];
  let score = 0;
  if (lastAttempt?.outcome === 'stuck') {
    score = 100;
    reasons.push('Stuck on your last attempt');
  } else if (lastAttempt?.outcome === 'hint') {
    score = 55;
    reasons.push('You used a hint last time');
  } else if (lastAttempt?.outcome === 'solved') {
    score = -30;
    reasons.push('Solved on your last attempt');
  } else {
    score = 15;
    reasons.push('Not attempted yet');
  }
  if (linkedGap && exercise.note) {
    score += 45;
    reasons.push(`Recent review difficulty on ${exercise.note.title}`);
  }
  return { score, reasons };
}

export function PracticePage({ userId, guideLanguage }: { userId: string; guideLanguage?: GuideLanguage }) {
  const [library, setLibrary] = useState<PracticeLibrary | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [book, setBook] = useState('');
  const [chapter, setChapter] = useState('');
  const [topic, setTopic] = useState('');
  const [queue, setQueue] = useState<string[]>([]);
  const guide = useModuleGuide('practice', userId, guideLanguage);
  const reviewGaps = useRecentReviewGaps(Boolean(library?.exercises.some((exercise) => exercise.note)));

  async function refresh() {
    try {
      setLibrary(await loadPracticeLibrary(userId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error('Could not load local practice data.'));
    }
  }
  useEffect(() => {
    void refresh();
  }, [userId]);

  const latest = useMemo(() => {
    const results = new Map<string, PracticeAttempt>();
    for (const attempt of library?.attempts ?? []) {
      const prior = results.get(attempt.exerciseId);
      if (!prior || prior.at <= attempt.at) results.set(attempt.exerciseId, attempt);
    }
    return results;
  }, [library]);

  const all = library?.exercises ?? [];
  const bookNames = [...new Set(all.map((exercise) => exercise.book))].sort();
  const chapterNames = [
    ...new Set(all.filter((exercise) => !book || exercise.book === book).map((exercise) => exercise.chapter)),
  ].sort((first, second) => first.localeCompare(second, undefined, { numeric: true }));
  const topics = [...new Set(all.flatMap((exercise) => exercise.topics))].sort();
  const ranked = all
    .filter(
      (exercise) =>
        (!book || exercise.book === book) &&
        (!chapter || exercise.chapter === chapter) &&
        (!topic || exercise.topics.includes(topic)),
    )
    .map((exercise) => ({
      exercise,
      ...rankExercise(
        exercise,
        latest.get(exercise.id),
        Boolean(exercise.note && reviewGaps.has(exercise.note.id)),
      ),
    }))
    .sort(
      (first, second) =>
        second.score - first.score ||
        first.exercise.book.localeCompare(second.exercise.book) ||
        first.exercise.chapter.localeCompare(second.exercise.chapter, undefined, { numeric: true }) ||
        first.exercise.number.localeCompare(second.exercise.number, undefined, { numeric: true }),
    );
  const current = ranked.find(({ exercise }) => exercise.id === selected) ?? ranked[0];
  const queueIndex = queue.indexOf(current?.exercise.id ?? '');
  const suggested = ranked.filter(({ score }) => score >= 0).slice(0, 3);

  function resetSelection() {
    setSelected(null);
    setQueue([]);
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Textbook Practice</h1>
          <p>Import exercises and build a practice set from your attempts and linked reviews.</p>
        </div>
        <div className={styles.headingActions}>
          {!!all.length && (
            <button
              className="button"
              onClick={() =>
                download(
                  new Blob([JSON.stringify({ version: 1, ...library }, null, 2)], {
                    type: 'application/json',
                  }),
                  'prism-textbook-practice.json',
                )
              }
            >
              Export practice JSON
            </button>
          )}
          <button className="button primary" disabled={!library} onClick={() => setImporting(true)}>
            Import exercises
          </button>
        </div>
      </header>
      <ModuleGuide guide={guide} action={() => setImporting(true)} actionDisabled={!library} />
      <p className={`muted small-text ${styles.localNotice}`}>
        Exercises, attempts, and PDFs stay in this browser or desktop profile. Export practice JSON for the
        text and history. Download PDFs separately.
      </p>
      {message && (
        <div role="status">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      {loadError && <ErrorState error={loadError} retry={() => void refresh()} />}
      {!library && !loadError && <Loading />}
      {library && !all.length && (
        <section className="panel">
          <Empty title="No saved exercises" icon="knowledge">
            Import an exercise section from a selectable-text PDF, pasted text, or HTML.
          </Empty>
        </section>
      )}
      {!!all.length && (
        <>
          <div className={styles.filters}>
            <Field label="Filter by book">
              <select
                value={book}
                onChange={(event) => {
                  setBook(event.target.value);
                  setChapter('');
                  resetSelection();
                }}
              >
                <option value="">All books</option>
                {bookNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Filter by chapter">
              <select
                value={chapter}
                onChange={(event) => {
                  setChapter(event.target.value);
                  resetSelection();
                }}
              >
                <option value="">All chapters</option>
                {chapterNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Filter by topic">
              <select
                value={topic}
                onChange={(event) => {
                  setTopic(event.target.value);
                  resetSelection();
                }}
              >
                <option value="">All topics</option>
                {topics.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <button
              className="button primary"
              disabled={!suggested.length}
              onClick={() => {
                setQueue(suggested.map(({ exercise }) => exercise.id));
                setSelected(suggested[0].exercise.id);
              }}
            >
              Start practice set
            </button>
          </div>
          {!current ? (
            <section className="panel">
              <Empty title="No exercises match these filters" />
            </section>
          ) : (
            <div className={styles.layout}>
              <section className="panel content-panel" aria-label="Saved exercises">
                <div className="panel-heading">
                  <h2>Exercises</h2>
                </div>
                <ul className={styles.list}>
                  {ranked.map(({ exercise, reasons }) => (
                    <li key={exercise.id}>
                      <button
                        aria-label={`Exercise ${exercise.number}`}
                        aria-current={current.exercise.id === exercise.id ? 'true' : undefined}
                        onClick={() => {
                          setQueue([]);
                          setSelected(exercise.id);
                        }}
                      >
                        <strong>Exercise {exercise.number}</strong>
                        <small>
                          {exercise.book} · Chapter {exercise.chapter}
                        </small>
                        <small className="muted">{reasons[0]}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <div>
                {queueIndex >= 0 && (
                  <div className={styles.actions}>
                    <strong>
                      Practice set · {queueIndex + 1} of {queue.length}
                    </strong>
                    <button
                      className="button small"
                      disabled={queueIndex === 0}
                      onClick={() => setSelected(queue[queueIndex - 1])}
                    >
                      Previous exercise
                    </button>
                    <button
                      className="button small"
                      disabled={queueIndex === queue.length - 1}
                      onClick={() => setSelected(queue[queueIndex + 1])}
                    >
                      Next exercise
                    </button>
                    <button className="button small" onClick={() => setQueue([])}>
                      End set
                    </button>
                  </div>
                )}
                <PracticeDetail
                  key={current.exercise.id}
                  userId={userId}
                  exercise={current.exercise}
                  reasons={current.reasons}
                  attempts={(library?.attempts ?? [])
                    .filter((attempt) => attempt.exerciseId === current.exercise.id)
                    .sort((first, second) => second.at.localeCompare(first.at))}
                  onSaved={async () => {
                    setSelected(current.exercise.id);
                    await refresh();
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
      {importing && (
        <ImportExercises
          userId={userId}
          guide={guide}
          onClose={() => setImporting(false)}
          onSaved={async ({ saved, skipped }) => {
            if (saved || skipped) guide.finish();
            setImporting(false);
            setMessage(
              `Saved ${saved} exercise${saved === 1 ? '' : 's'}.${skipped ? ` Skipped ${skipped} already saved.` : ''}`,
            );
            setBook('');
            setChapter('');
            setTopic('');
            resetSelection();
            await refresh();
          }}
        />
      )}
    </>
  );
}

function PracticeDetail({
  userId,
  exercise,
  reasons,
  attempts,
  onSaved,
}: {
  userId: string;
  exercise: PracticeExercise;
  reasons: string[];
  attempts: PracticeAttempt[];
  onSaved: () => Promise<void>;
}) {
  const [work, setWork] = useState('');
  const [editing, setEditing] = useState(false);
  const [recorded, setRecorded] = useState('');
  const action = useAction();
  const reference = pageReference(exercise.fromPage, exercise.toPage);

  async function record(outcome: Outcome) {
    await action.run(async () => {
      await recordPracticeAttempt(userId, {
        id: uuid(),
        exerciseId: exercise.id,
        outcome,
        notes: work.trim(),
        at: new Date().toISOString(),
      });
      setRecorded(`Recorded: ${outcomes[outcome]}`);
      setWork('');
      await onSaved();
    });
  }

  return (
    <article
      className={`panel content-panel ${styles.details}`}
      aria-label={`Practice exercise ${exercise.number}`}
    >
      <div className={styles.candidateHeader}>
        <div>
          <h2>Exercise {exercise.number}</h2>
          <p className="muted">
            {exercise.book} · Chapter {exercise.chapter}
            {reference && ` · ${reference}`}
          </p>
        </div>
        <button className="button small" onClick={() => setEditing(true)}>
          Edit exercise
        </button>
      </div>
      <MathContent content={exercise.statement} className={styles.statement} />
      {!!exercise.topics.length && (
        <p>
          <strong>Topics</strong> {exercise.topics.join(', ')}
        </p>
      )}
      {exercise.note && (
        <p>
          <strong>Linked note</strong>{' '}
          <Link className="text-link" href={`/knowledge/${exercise.note.id}`}>
            {exercise.note.title}
          </Link>
        </p>
      )}
      <p className="muted">
        <strong>Why this exercise</strong> {reasons.join(' · ')}
      </p>
      <details>
        <summary>Original extracted text</summary>
        <pre className={styles.excerpt}>{exercise.original}</pre>
        <div className={styles.actions}>
          {exercise.sourceUrl && (
            <a className="text-link" href={exercise.sourceUrl} target="_blank" rel="noreferrer">
              Open textbook source
            </a>
          )}
          {exercise.pdfId && (
            <button
              className="button small"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const file = await loadPracticePdf(userId, exercise.pdfId!);
                  if (!file) throw new Error('This source PDF is unavailable in the current profile.');
                  download(file, exercise.pdfName || 'textbook.pdf');
                })
              }
            >
              Download original PDF
            </button>
          )}
        </div>
      </details>
      <Field label="Work for this attempt (optional)">
        <textarea
          className={styles.work}
          value={work}
          onChange={(event) => setWork(event.target.value)}
          rows={5}
          maxLength={50_000}
        />
      </Field>
      <div className={styles.actions} aria-label="Record attempt outcome">
        {(Object.keys(outcomes) as Outcome[]).map((outcome) => (
          <button
            key={outcome}
            className={outcome === 'solved' ? 'button primary' : 'button'}
            disabled={action.busy}
            onClick={() => void record(outcome)}
          >
            {outcomes[outcome]}
          </button>
        ))}
      </div>
      {recorded && <p role="status">{recorded}</p>}
      {action.error && (
        <div role="alert">
          <Notice tone="error">{action.error}</Notice>
        </div>
      )}
      {!!attempts.length && (
        <details>
          <summary>Attempt history ({attempts.length})</summary>
          <ol className={styles.history}>
            {attempts.map((attempt) => (
              <li key={attempt.id}>
                <strong>{outcomes[attempt.outcome]}</strong>{' '}
                <span className="muted">{datetime(attempt.at)}</span>
                {attempt.notes && <p>{attempt.notes}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {editing && (
        <EditExercise
          userId={userId}
          exercise={exercise}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onSaved();
          }}
        />
      )}
    </article>
  );
}

function topicList(value: string) {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

const ExerciseStatementPreview = memo(function ExerciseStatementPreview({
  statement,
}: {
  statement: string;
}) {
  return (
    <section className={styles.mathPreview} aria-label="Rendered preview">
      <strong>Rendered preview</strong>
      <MathContent content={statement} className={styles.statement} />
    </section>
  );
});

function EditExercise({
  userId,
  exercise,
  onClose,
  onSaved,
}: {
  userId: string;
  exercise: PracticeExercise;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [statement, setStatement] = useState(exercise.statement);
  const [topics, setTopics] = useState(exercise.topics.join(', '));
  const [note, setNote] = useState(exercise.note?.id ?? '');
  const notes = useResource<Page<Knowledge>>('/knowledge-items?limit=500');
  const action = useAction();
  const convertedStatement = convertTextbookMath(statement);
  const linked =
    notes.data?.items.find((item) => item.id === note) ??
    (exercise.note?.id === note ? exercise.note : undefined);
  return (
    <Modal title={`Edit exercise ${exercise.number}`} onClose={action.busy ? () => {} : onClose} wide>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            if (!statement.trim()) throw new Error('Enter the exercise statement.');
            await savePracticeExercise(userId, {
              ...exercise,
              statement: statement.trim(),
              topics: topicList(topics),
              note: linked ? { id: linked.id, title: linked.title } : undefined,
            });
            await onSaved();
          });
        }}
      >
        <Field label="Exercise statement" hint="Use $…$ or $$…$$ for LaTeX.">
          <textarea
            className={styles.latexEditor}
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            rows={8}
            required
            maxLength={100_000}
          />
        </Field>
        {convertedStatement !== statement && (
          <button
            type="button"
            className="button small"
            disabled={action.busy}
            onClick={() => setStatement(convertedStatement)}
          >
            Convert symbols to LaTeX
          </button>
        )}
        <ExerciseStatementPreview statement={statement} />
        <Field label="Topics (optional)" hint="Separate topics with commas.">
          <input value={topics} onChange={(event) => setTopics(event.target.value)} maxLength={500} />
        </Field>
        <Field
          label="Linked knowledge note (optional)"
          hint="A recent Hard or Again review can move this exercise up the practice list."
        >
          <select value={note} onChange={(event) => setNote(event.target.value)}>
            <option value="">No linked note</option>
            {exercise.note && !notes.data?.items.some((item) => item.id === exercise.note?.id) && (
              <option value={exercise.note.id}>{exercise.note.title}</option>
            )}
            {notes.data?.items.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </Field>
        {notes.error && <ErrorState error={notes.error} retry={notes.reload} />}
        {action.error && (
          <div role="alert">
            <Notice tone="error">{action.error}</Notice>
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="button" disabled={action.busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            Save exercise
          </button>
        </div>
      </form>
    </Modal>
  );
}

type SourceFormat = 'pdf' | 'text' | 'html' | 'url';
type Candidate = ExerciseCandidate & { include: boolean };
function ImportExercises({
  userId,
  guide,
  onClose,
  onSaved,
}: {
  userId: string;
  guide: ModuleGuideState;
  onClose: () => void;
  onSaved: (result: { saved: number; skipped: number }) => Promise<void>;
}) {
  const [format, setFormat] = useState<SourceFormat>('pdf');
  const [book, setBook] = useState('');
  const [chapter, setChapter] = useState('');
  const [url, setUrl] = useState('');
  const [topics, setTopics] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | undefined>();
  const [sample, setSample] = useState(false);
  const [pdf, setPdf] = useState<PracticePdf>();
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('1');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const action = useAction();

  async function preview() {
    if (!book.trim() || !chapter.trim()) throw new Error('Enter a book title and chapter.');
    const address = sourceAddress(url);
    let source = text;
    if (format === 'url') {
      if (!address) throw new Error('Enter the textbook chapter URL.');
      source = await readTextbookWebPage(address);
    } else if (format === 'html' && file) {
      if (file.size > 4_000_000) throw new Error('Choose a saved HTML chapter under 4 MB.');
      source = await file.text();
    }
    if (source.length > 4_000_000) throw new Error('Import an exercise section under 4 MB.');
    let originalPdf = pdf;
    if (format === 'pdf' && !originalPdf) {
      if (!file) throw new Error('Select the textbook PDF first.');
      if (file.size > textbookPdfLimits.fileBytes) throw new Error('Select a PDF under 64 MB.');
      // Read the File while its input is still mounted; retain independent bytes for saving.
      originalPdf = { name: file.name, bytes: await file.arrayBuffer() };
      setPdf(originalPdf);
    }
    const pages = originalPdf
      ? await readTextbookPdf(originalPdf.bytes, { from: Number(from), to: Number(to) })
      : [{ page: 1, text: format === 'text' ? source : readTextbookHtml(source) }];
    const extracted = extractTextbookExercises(pages);
    if (extracted.exercises.length > 200)
      throw new Error('More than 200 exercises found. Select a smaller section.');
    setWarnings(extracted.warnings);
    setCandidates(
      extracted.exercises.map((exercise) => ({
        ...exercise,
        text: convertTextbookMath(exercise.text),
        include: !exercise.uncertain,
      })),
    );
  }

  async function save() {
    const included = (candidates ?? []).filter((exercise) => exercise.include);
    const ids = new Set<string>();
    const exercises = included.map((candidate) => {
      const number = candidate.number.trim();
      if (!number || !candidate.text.trim())
        throw new Error('Each selected exercise needs a number and statement.');
      const id = exerciseId(book, chapter, number);
      if (ids.has(id))
        throw new Error(`Exercise ${number} appears twice. Change its number or exclude one copy.`);
      ids.add(id);
      return {
        id,
        book: book.trim(),
        chapter: chapter.trim(),
        number,
        statement: candidate.text.trim(),
        original: candidate.original,
        sourceUrl: sourceAddress(url),
        topics: topicList(topics),
        ...(format === 'pdf' ? { fromPage: candidate.fromPage, toPage: candidate.toPage } : {}),
      };
    });
    await onSaved(await savePracticeImport(userId, exercises, pdf));
  }

  function changeCandidate(index: number, patch: Partial<Candidate>) {
    setCandidates(
      (current) =>
        current?.map((candidate, position) =>
          position === index ? { ...candidate, ...patch } : candidate,
        ) ?? null,
    );
  }

  return (
    <Modal title="Import exercises" onClose={action.busy ? () => {} : onClose} wide>
      <ModuleGuideHint guide={guide}>
        {candidates ? guide.copy.review : guide.copy.editor.practice}
      </ModuleGuideHint>
      <form
        className={styles.importBody}
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(candidates ? save : preview);
        }}
      >
        {!candidates ? (
          <>
            {guide.active && !file && (
              <button
                className="button small"
                type="button"
                lang={guide.language}
                disabled={action.busy}
                onClick={() => {
                  setBook(guide.copy.sampleBook);
                  setChapter(guide.copy.sampleChapter);
                  setFormat('pdf');
                  setUrl('');
                  setFrom('1');
                  setTo('1');
                  setPdf(undefined);
                  setFile(exampleExercisePdf());
                  setSample(true);
                }}
              >
                {guide.copy.sample}
              </button>
            )}
            <div className={styles.pageGrid}>
              <Field label="Book title">
                <input
                  value={book}
                  onChange={(event) => setBook(event.target.value)}
                  required
                  maxLength={180}
                />
              </Field>
              <Field label="Chapter">
                <input
                  value={chapter}
                  onChange={(event) => setChapter(event.target.value)}
                  required
                  maxLength={100}
                />
              </Field>
            </div>
            <Field label="Source format">
              <select
                value={format}
                disabled={action.busy}
                onChange={(event) => {
                  setFormat(event.target.value as SourceFormat);
                  setFile(undefined);
                  setPdf(undefined);
                  setSample(false);
                }}
              >
                <option value="pdf">Selectable-text PDF</option>
                <option value="text">Pasted text</option>
                <option value="html">Pasted or saved HTML</option>
                <option value="url">Public HTML page</option>
              </select>
            </Field>
            <Field label={format === 'url' ? 'Textbook chapter URL' : 'Source URL (optional)'}>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required={format === 'url'}
                maxLength={2000}
              />
            </Field>
            {format === 'pdf' ? (
              <>
                <Field label="Textbook PDF" hint="Select a PDF under 64 MB with selectable text.">
                  <input
                    key={format}
                    type="file"
                    accept=".pdf,application/pdf"
                    disabled={action.busy}
                    onChange={(event) => {
                      setFile(event.target.files?.[0]);
                      setPdf(undefined);
                      setSample(false);
                    }}
                  />
                </Field>
                {file && <p className="muted">{file.name}</p>}
                <div className={styles.pageGrid}>
                  <Field label="First PDF page">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={from}
                      onChange={(event) => setFrom(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Last PDF page" hint="Use page positions in the PDF, up to 40 per import.">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={to}
                      onChange={(event) => setTo(event.target.value)}
                      required
                    />
                  </Field>
                </div>
              </>
            ) : format !== 'url' ? (
              <>
                {format === 'html' && (
                  <Field label="Saved HTML file (optional)">
                    <input
                      key={format}
                      type="file"
                      accept=".html,.htm,text/html"
                      onChange={(event) => setFile(event.target.files?.[0])}
                    />
                  </Field>
                )}
                {file && <p className="muted">{file.name}</p>}
                {!file && (
                  <Field
                    label={format === 'html' ? 'Chapter HTML' : 'Exercise text'}
                    hint="Include the numbered exercises and any subparts."
                  >
                    <textarea
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      required
                      rows={8}
                      maxLength={4_000_000}
                    />
                  </Field>
                )}
              </>
            ) : (
              <p className="muted">
                PRISM reads this page directly from your browser. If the site blocks access, paste the
                exercises or import a saved file.
              </p>
            )}
            <Field
              label="Topics for this import (optional)"
              hint="Separate topics with commas. You can edit them for each saved exercise."
            >
              <input value={topics} onChange={(event) => setTopics(event.target.value)} maxLength={500} />
            </Field>
          </>
        ) : (
          <>
            <p>
              {book} · Chapter {chapter} · {candidates.filter((exercise) => exercise.include).length} selected
            </p>
            {warnings.map((warning) => (
              <Notice key={warning} tone="warning">
                {warning}
              </Notice>
            ))}
            {format === 'pdf' && (
              <div className={styles.actions}>
                <p className="muted">Check formulas and diagrams against the PDF.</p>
                {pdf && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => download(new Blob([pdf.bytes], { type: 'application/pdf' }), pdf.name)}
                  >
                    Download original PDF
                  </button>
                )}
              </div>
            )}
            <div className={styles.candidates}>
              {candidates.map((candidate, index) => (
                <section
                  key={index}
                  className={styles.candidate}
                  aria-label={`Extracted exercise ${candidate.number}`}
                >
                  <div className={styles.candidateHeader}>
                    <label className={styles.include}>
                      <input
                        type="checkbox"
                        checked={candidate.include}
                        onChange={(event) => changeCandidate(index, { include: event.target.checked })}
                      />
                      Include exercise {candidate.number}
                    </label>
                    <span className="muted">
                      {(candidate.uncertain || !!candidate.mathWarnings?.length) &&
                        (format === 'pdf' ? 'Needs checking · ' : 'Needs checking')}
                      {format === 'pdf' && pageReference(candidate.fromPage, candidate.toPage)}
                    </span>
                  </div>
                  <div className={styles.comparison}>
                    <div>
                      <strong>Original extracted text</strong>
                      <pre className={styles.excerpt}>{candidate.original}</pre>
                    </div>
                    <div>
                      <Field label={`Exercise ${candidate.number} number`}>
                        <input
                          value={candidate.number}
                          onChange={(event) => changeCandidate(index, { number: event.target.value })}
                          maxLength={40}
                        />
                      </Field>
                      <Field
                        label={`Exercise ${candidate.number} statement`}
                        hint="Use $…$ or $$…$$ for LaTeX."
                      >
                        <textarea
                          className={styles.latexEditor}
                          rows={5}
                          value={candidate.text}
                          onChange={(event) => changeCandidate(index, { text: event.target.value })}
                          maxLength={100_000}
                        />
                      </Field>
                    </div>
                  </div>
                  {!!candidate.mathWarnings?.length && (
                    <section className={styles.formulaReview} aria-label="Check PDF formulas">
                      <strong>Check PDF formulas</strong>
                      <ul>
                        {candidate.mathWarnings.map((warning, index) => (
                          <li key={index}>
                            <mark>{warning.snippet}</mark> {warning.reason}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <ExerciseStatementPreview statement={candidate.text} />
                </section>
              ))}
            </div>
          </>
        )}
        {action.error && (
          <div role="alert">
            <Notice tone="error">{action.error}</Notice>
          </div>
        )}
        <div className="modal-footer">
          {candidates && (
            <button
              type="button"
              className="button"
              disabled={action.busy}
              onClick={() => {
                setCandidates(null);
                action.setError(null);
              }}
            >
              Back to source
            </button>
          )}
          <button
            className="button primary"
            lang={sample && candidates ? guide.language : undefined}
            disabled={action.busy || Boolean(candidates && !candidates.some((exercise) => exercise.include))}
          >
            {candidates
              ? action.busy
                ? 'Saving…'
                : sample
                  ? guide.copy.keep
                  : 'Save selected exercises'
              : action.busy
                ? 'Reading section…'
                : 'Preview exercises'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
