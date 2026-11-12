'use client';

import { knowledgeChapter, knowledgeChapterTitle } from '@prism/shared-utils';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KnowledgeMarkdownActions } from '../../../components/KnowledgeMarkdownActions';
import { ErrorState, Field, KnowledgeMarkdown, Loading, Notice, label } from '../../../components/ui';
import { api } from '../../../lib/api';
import { chapterName } from '../../../lib/knowledge-scope';
import type { Knowledge, Page } from '../../../lib/types';
import styles from './export.module.css';

type Chapter = { number: number; title?: string; items: Knowledge[] };
type Collection = { subject: string; chapters: Chapter[] };
type Scope = 'chapters' | 'entries' | 'items';

function tagValue(item: Knowledge, prefix: string) {
  return item.tags
    .find((tag) => tag.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function chapterNumber(item: Knowledge) {
  return knowledgeChapter(item.tags);
}

const order = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function subjectName(item: Knowledge) {
  return item.subject.trim() || 'Uncategorized';
}

function compareEntries(a: Knowledge, b: Knowledge) {
  const chapter =
    (chapterNumber(a) ?? Number.MAX_SAFE_INTEGER) - (chapterNumber(b) ?? Number.MAX_SAFE_INTEGER);
  const aNumber = tagValue(a, 'entry:');
  const bNumber = tagValue(b, 'entry:');
  return (
    order.compare(a.subject, b.subject) ||
    chapter ||
    (aNumber && bNumber ? order.compare(aNumber, bNumber) : Number(!aNumber) - Number(!bNumber)) ||
    order.compare(a.title, b.title)
  );
}

function chapterCollections(items: Knowledge[]): Collection[] {
  const bySubject = new Map<string, Map<number, Chapter>>();
  for (const item of items) {
    const number = chapterNumber(item);
    if (number === null) continue;
    const subject = subjectName(item);
    let chapters = bySubject.get(subject);
    if (!chapters) bySubject.set(subject, (chapters = new Map()));
    let chapter = chapters.get(number);
    if (!chapter) chapters.set(number, (chapter = { number, items: [] }));
    chapter.title ||= knowledgeChapterTitle(item.tags);
    chapter.items.push(item);
  }
  return [...bySubject].map(([subject, chapters]) => ({
    subject,
    chapters: [...chapters.values()].sort((a, b) => a.number - b.number),
  }));
}

function numberedCollections(items: Knowledge[]) {
  const subjects = new Map<string, Knowledge[]>();
  for (const item of items) {
    if (!tagValue(item, 'entry:')) continue;
    const subject = subjectName(item);
    let entries = subjects.get(subject);
    if (!entries) subjects.set(subject, (entries = []));
    entries.push(item);
  }
  for (const entries of subjects.values()) {
    entries.sort(
      (a, b) =>
        order.compare(tagValue(a, 'entry:')!, tagValue(b, 'entry:')!) || order.compare(a.title, b.title),
    );
  }
  return subjects;
}

function entryLabel(item: Knowledge) {
  const number = tagValue(item, 'entry:');
  return tagValue(item, 'entry-label:') || `${label(item.type)}${number ? ` ${number}` : ''}`;
}

function topicTitle(item: Knowledge) {
  const prefix = entryLabel(item);
  return item.title.startsWith(`${prefix} · `) ? item.title.slice(prefix.length + 3) : item.title;
}

function textbookPage(item: Knowledge) {
  return tagValue(item, 'textbook-pages:');
}

function sourceLabel(item: Knowledge) {
  const page = textbookPage(item);
  return page ? `Textbook ${/^\d+$/.test(page) ? 'p.' : 'pp.'} ${page}` : item.source_reference;
}

function fitPrintedEquations(sheet: HTMLElement) {
  // The A4 page has 16.5 mm side margins. Measure the math after its fonts load.
  const printWidth = (177 * 96) / 25.4 - 2;
  const range = document.createRange();
  for (const equation of sheet.querySelectorAll<HTMLElement>('.katex-display > .katex')) {
    const line = equation.querySelector('.katex-html');
    if (!line) continue;
    equation.style.removeProperty('--pdf-math-scale');
    range.selectNodeContents(line);
    const width = range.getBoundingClientRect().width;
    if (width > printWidth) equation.style.setProperty('--pdf-math-scale', String(printWidth / width));
  }
}

export default function KnowledgeExport({ initialItemId }: { initialItemId?: string }) {
  const [items, setItems] = useState<Knowledge[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    async function load() {
      const all: Knowledge[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<Knowledge> = await api(
          `/knowledge-items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          {
            signal: controller.signal,
          },
        );
        all.push(...page.items);
        cursor = page.next_cursor;
      } while (cursor);
      if (!controller.signal.aborted) setItems(all.sort(compareEntries));
    }
    void load().catch((reason: unknown) => {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason : new Error('Could not load knowledge.'));
    });
    return () => controller.abort();
  }, [attempt]);

  return (
    <main className={styles.page}>
      <header className={styles.toolbar}>
        <Link
          href={initialItemId ? `/knowledge/${encodeURIComponent(initialItemId)}` : '/knowledge'}
          className="back-link"
        >
          ← Back to knowledge
        </Link>
        <span>PRISM / KNOWLEDGE</span>
      </header>
      {error && <ErrorState error={error} retry={() => setAttempt((n) => n + 1)} />}
      {!items && !error && <Loading />}
      {items && (
        <ExportSelection key={initialItemId ?? 'collection'} items={items} initialItemId={initialItemId} />
      )}
    </main>
  );
}

function ExportSelection({ items, initialItemId }: { items: Knowledge[]; initialItemId?: string }) {
  const collections = useMemo(() => chapterCollections(items), [items]);
  const numbered = useMemo(() => numberedCollections(items), [items]);
  const initialItem = items.find((item) => item.id === initialItemId);
  const [scope, setScope] = useState<Scope>(
    initialItemId ? 'items' : collections.length ? 'chapters' : numbered.size ? 'entries' : 'items',
  );
  const [subject, setSubject] = useState(collections[0]?.subject ?? '');
  const [firstChapter, setFirstChapter] = useState(collections[0]?.chapters[0]?.number ?? 1);
  const [lastChapter, setLastChapter] = useState(firstChapter);
  const [entryRange, setEntryRange] = useState({
    subject: numbered.keys().next().value ?? '',
    from: 0,
    through: 0,
  });
  const [selected, setSelected] = useState(() => new Set(initialItem ? [initialItem.id] : []));
  const [search, setSearch] = useState('');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeProofs, setIncludeProofs] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const sheet = useRef<HTMLElement>(null);

  const collection = collections.find((entry) => entry.subject === subject);
  const chapterOptions = collection?.chapters ?? [];
  const entryOptions = numbered.get(entryRange.subject) ?? [];
  const entrySelection = entryOptions.slice(entryRange.from, entryRange.through + 1);
  const included = (item: Knowledge) => includeNotes || item.type !== 'note';
  const chapters =
    scope === 'chapters'
      ? chapterOptions
          .filter((chapter) => chapter.number >= firstChapter && chapter.number <= lastChapter)
          .map((chapter) => ({
            ...chapter,
            items: chapter.items.filter(included),
          }))
          .filter((chapter) => chapter.items.length)
      : [];
  const chosen =
    scope === 'chapters'
      ? chapters.flatMap((chapter) => chapter.items)
      : scope === 'entries'
        ? entrySelection.filter(included)
        : items.filter((item) => selected.has(item.id));
  const textbooks = [
    ...new Set(
      chosen.flatMap((item) => {
        const textbook = item.source_reference?.match(/^(.+?),\s+textbook pp?\./i)?.[1];
        return textbook ? [textbook] : [];
      }),
    ),
  ];
  const query = search.trim().toLowerCase();
  const choices = items.filter((item) =>
    [item.title, item.subject, entryLabel(item)].some((value) => value.toLowerCase().includes(query)),
  );
  const title =
    scope === 'chapters'
      ? 'Definitions and Theorems'
      : chosen.length === 1
        ? topicTitle(chosen[0])
        : scope === 'entries'
          ? 'Definitions and Theorems'
          : 'Knowledge Reference';
  const subtitle =
    scope === 'chapters'
      ? firstChapter === lastChapter
        ? `Chapter ${firstChapter}`
        : `Chapters ${firstChapter}-${lastChapter}`
      : chosen.length === 1
        ? chosen[0].subject
        : scope === 'entries' && entrySelection.length
          ? `${entryLabel(entrySelection[0])} to ${entryLabel(entrySelection.at(-1)!)}`
          : '';

  useEffect(() => {
    const previous = document.title;
    document.title = [title, subtitle, 'PRISM'].filter(Boolean).join(' · ');
    return () => {
      document.title = previous;
    };
  }, [title, subtitle]);

  async function print() {
    const preview = sheet.current;
    if (!preview) return;
    setPreparing(true);
    setPrintError(null);
    try {
      await Promise.all([
        document.fonts.ready,
        ...Array.from(preview.querySelectorAll('img'), (image) => {
          image.loading = 'eager';
          return image.decode();
        }),
      ]);
      fitPrintedEquations(preview);
      const nativePrint = (
        window as Window & {
          webkit?: {
            messageHandlers?: { prismPrint?: { postMessage: (message: Record<string, never>) => void } };
          };
        }
      ).webkit?.messageHandlers?.prismPrint;
      if (nativePrint) nativePrint.postMessage({});
      else window.print();
    } catch {
      setPrintError('Could not prepare the PDF. Check that source images loaded and try again.');
    } finally {
      setPreparing(false);
    }
  }

  if (!items.length) return <p className={styles.empty}>Create a knowledge item to export it as a PDF.</p>;

  return (
    <div className={styles.layout}>
      <aside className={styles.controls} aria-labelledby="export-heading">
        <header className={styles.controlsHeader}>
          <h1 id="export-heading">Export knowledge</h1>
          <p>Choose chapters, numbered entries, or individual items.</p>
        </header>
        {!collections.length && (
          <p className={styles.controlNote}>
            Add a tag like <code>chapter:1</code> to group items by chapter.
          </p>
        )}
        {initialItemId && !initialItem && <Notice>This knowledge item is no longer available.</Notice>}
        <fieldset disabled={preparing}>
          <Field label="Selection">
            <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="chapters" disabled={!collections.length}>
                Chapter range
              </option>
              <option value="entries" disabled={!numbered.size}>
                Entry range
              </option>
              <option value="items">Individual items</option>
            </select>
          </Field>
          {scope === 'chapters' ? (
            <>
              <Field label="Subject">
                <select
                  value={subject}
                  onChange={(e) => {
                    const next = collections.find((entry) => entry.subject === e.target.value);
                    if (!next) return;
                    setSubject(next.subject);
                    setFirstChapter(next.chapters[0].number);
                    setLastChapter(next.chapters[0].number);
                  }}
                >
                  {collections.map((entry) => (
                    <option key={entry.subject} value={entry.subject}>
                      {entry.subject}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From chapter">
                <select
                  value={firstChapter}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setFirstChapter(next);
                    if (next > lastChapter) setLastChapter(next);
                  }}
                >
                  {chapterOptions.map((chapter) => (
                    <option key={chapter.number} value={chapter.number}>
                      {chapterName(chapter)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Through chapter">
                <select value={lastChapter} onChange={(e) => setLastChapter(Number(e.target.value))}>
                  {chapterOptions
                    .filter((chapter) => chapter.number >= firstChapter)
                    .map((chapter) => (
                      <option key={chapter.number} value={chapter.number}>
                        {chapterName(chapter)}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          ) : scope === 'entries' ? (
            <>
              <Field label="Subject">
                <select
                  value={entryRange.subject}
                  onChange={(e) => setEntryRange({ subject: e.target.value, from: 0, through: 0 })}
                >
                  {[...numbered.keys()].map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From entry">
                <select
                  value={entryRange.from}
                  onChange={(e) => {
                    const from = Number(e.target.value);
                    setEntryRange({ ...entryRange, from, through: Math.max(from, entryRange.through) });
                  }}
                >
                  {entryOptions.map((item, i) => (
                    <option key={item.id} value={i}>
                      {entryLabel(item)} · {topicTitle(item)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Through entry">
                <select
                  value={entryRange.through}
                  onChange={(e) => setEntryRange({ ...entryRange, through: Number(e.target.value) })}
                >
                  {entryOptions.slice(entryRange.from).map((item, i) => (
                    <option key={item.id} value={entryRange.from + i}>
                      {entryLabel(item)} · {topicTitle(item)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label="Find an item">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Title, subject, or number"
                />
              </Field>
              <div className={styles.choices} role="group" aria-label="Knowledge items">
                {choices.length === 0 && <p className="muted">No matching items.</p>}
                {choices.map((item) => (
                  <label className={styles.check} key={item.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        });
                      }}
                    />
                    <span>
                      {item.title}
                      <small>{item.subject || label(item.type)}</small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {scope !== 'items' && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
              />
              <span>Include study notes</span>
            </label>
          )}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={includeProofs}
              onChange={(e) => setIncludeProofs(e.target.checked)}
            />
            <span>Include proofs and explanations</span>
          </label>
        </fieldset>
        <button
          className="button primary"
          disabled={!chosen.length || preparing}
          onClick={() => void print()}
        >
          {preparing ? 'Preparing preview…' : 'Save as PDF'}
        </button>
        <KnowledgeMarkdownActions
          items={chosen}
          title={[title, subtitle].filter(Boolean).join(' - ')}
          includeProofs={includeProofs}
          disabled={preparing}
        />
        <div className={styles.exportNotes}>
          <p role="status">
            {chosen.length} {chosen.length === 1 ? 'item' : 'items'} · A4
          </p>
          <p>In the print dialog, choose “Save as PDF”.</p>
        </div>
        {printError && <Notice tone="error">{printError}</Notice>}
      </aside>
      {chosen.length ? (
        <article ref={sheet} className={styles.sheet} aria-label="PDF preview">
          <div className={styles.running}>
            <span>PRISM / KNOWLEDGE REFERENCE</span>
            <span>{subtitle}</span>
          </div>
          {chapters.length ? (
            <>
              <header className={styles.cover}>
                <div className={styles.kicker}>{subject}</div>
                <h2>{title}</h2>
                <p className={styles.subtitle}>{subtitle}</p>
                <p className={styles.intro}>
                  {chosen.length} {chosen.length === 1 ? 'entry' : 'entries'} from your knowledge collection.
                </p>
                <div className={styles.contents}>
                  <div className={styles.contentsHeader}>
                    <span>Chapter</span>
                    <span>Entries</span>
                  </div>
                  {chapters.map((chapter) => (
                    <a
                      className={styles.contentsRow}
                      href={`#chapter-${chapter.number}`}
                      key={chapter.number}
                    >
                      <span>{String(chapter.number).padStart(2, '0')}</span>
                      <span>{chapter.title || chapterName(chapter)}</span>
                      <span>{chapter.items.length}</span>
                    </a>
                  ))}
                  <a className={styles.indexLink} href="#statement-index">
                    Open the linked statement index
                  </a>
                </div>
                {textbooks.map((textbook) => (
                  <p className={styles.coverSource} key={textbook}>
                    Source: {textbook}
                  </p>
                ))}
              </header>
              <section className={styles.index} id="statement-index">
                <h2>Statement index</h2>
                <p className={styles.caption}>
                  Select an entry to jump to its statement. Asterisks mark study notes.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Entry</th>
                      <th scope="col">Topic</th>
                      <th scope="col">Textbook page</th>
                    </tr>
                  </thead>
                  {chapters.map((chapter) => (
                    <tbody key={chapter.number}>
                      <tr className={styles.indexGroup}>
                        <th colSpan={3}>
                          <a href={`#chapter-${chapter.number}`}>{chapterName(chapter)}</a>
                        </th>
                      </tr>
                      {chapter.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <a href={`#entry-${item.id}`}>
                              {entryLabel(item)}
                              {item.type === 'note' ? ' *' : ''}
                            </a>
                          </td>
                          <td>
                            <a href={`#entry-${item.id}`}>{topicTitle(item)}</a>
                          </td>
                          <td>{textbookPage(item) ?? '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </section>
              {chapters.map((chapter) => (
                <section className={styles.chapter} id={`chapter-${chapter.number}`} key={chapter.number}>
                  <header>
                    <div className={styles.kicker}>Chapter {String(chapter.number).padStart(2, '0')}</div>
                    <h2>{chapter.title || chapterName(chapter)}</h2>
                    <a className={styles.indexLink} href="#statement-index">
                      Statement index
                    </a>
                  </header>
                  {chapter.items.map((item) => (
                    <Statement item={item} includeProofs={includeProofs} key={item.id} />
                  ))}
                </section>
              ))}
            </>
          ) : (
            <>
              <header className={styles.singleHeader}>
                <div className={styles.kicker}>
                  {chosen.length === 1
                    ? entryLabel(chosen[0])
                    : scope === 'entries'
                      ? entryRange.subject
                      : 'Selected statements'}
                </div>
                <h2>{title}</h2>
              </header>
              {chosen.map((item) => (
                <Statement
                  item={item}
                  includeProofs={includeProofs}
                  key={item.id}
                  hideTitle={chosen.length === 1}
                />
              ))}
            </>
          )}
        </article>
      ) : (
        <div className={styles.empty}>Select an item or a range to see the PDF preview.</div>
      )}
    </div>
  );
}

function Statement({
  item,
  includeProofs,
  hideTitle = false,
}: {
  item: Knowledge;
  includeProofs: boolean;
  hideTitle?: boolean;
}) {
  const source = hideTitle ? item.source_reference || sourceLabel(item) : sourceLabel(item);
  const content = item.tags.includes('cag-ch1-7')
    ? item.content.replace(
        /^The source excerpt below preserves the original wording, formulas, and diagrams\.\n\n(?=!\[Source excerpt for )/,
        '',
      )
    : item.content;
  return (
    <section className={styles.statement} id={`entry-${item.id}`}>
      <header className={styles.statementHeading}>
        {!hideTitle && (
          <h3>
            <span>{entryLabel(item)}</span> {topicTitle(item)}
          </h3>
        )}
        {source && (
          <span className={styles.reference} title={item.source_reference ?? undefined}>
            {source}
          </span>
        )}
      </header>
      <KnowledgeMarkdown content={content} className={styles.statementBody} />
      {includeProofs && item.proof_content && (
        <div className={styles.proof}>
          <h4>Proof / Explanation</h4>
          <KnowledgeMarkdown content={item.proof_content} className={styles.statementBody} />
        </div>
      )}
    </section>
  );
}
