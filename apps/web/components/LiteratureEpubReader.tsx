'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { literatureAttachmentDownload, literatureAttachmentPath, type LiteratureAttachment } from '../lib/literature-pdfs';
import { useLiteratureReadingPosition } from '../lib/literature-reading-position';
import type { LiteratureEpub } from '../lib/literature-epub';
import { useLiteratureReaderPreferences } from '../lib/literature-reader-preferences';
import { ErrorState, Loading, Modal, Notice } from './ui';
import { LiteratureIndexButton } from './LiteratureIndexButton';
import { LiteratureReaderAppearance } from './LiteratureReaderAppearance';
import { LiteratureReadAloud } from './LiteratureReadAloud';
import { useLiteratureTextAnnotations } from './LiteratureTextAnnotations';
import styles from './LiteraturePdfReader.module.css';

export function LiteratureEpubReader({ file, onClose, startChapter, annotationId, inline }: {
  file: LiteratureAttachment; onClose: () => void; startChapter?: number; annotationId?: string; inline?: boolean;
}) {
  const [book, setBook] = useState<LiteratureEpub>();
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedChapter, setSelectedChapter] = useState<number>();
  const [query, setQuery] = useState('');
  const [spoken, setSpoken] = useState<number | null>(null);
  const { preferences, updatePreferences } = useLiteratureReaderPreferences();
  const scroll = useRef<HTMLDivElement>(null);
  const position = useLiteratureReadingPosition(`${literatureAttachmentPath(file.id)}/reading-position`,
    `prism.literature.epub-chapter.v2.${file.id}`, startChapter, `prism.literature.epub-chapter.v1.${file.id}`);
  const initialChapter = position.initialPage;
  const index = Math.max(0, Math.min(selectedChapter ?? (initialChapter ?? 1) - 1, (book?.sections.length ?? 1) - 1));

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void (async () => {
      try {
        const [{ parseLiteratureEpub }, response] = await Promise.all([
          import('../lib/literature-epub'),
          fetch(literatureAttachmentDownload(file.id), { signal: controller.signal, cache: 'no-store' }),
        ]);
        if (!response.ok) throw new Error('Could not download this EPUB.');
        const result = await parseLiteratureEpub(await response.arrayBuffer(), controller.signal);
        if (controller.signal.aborted) return;
        setBook(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure : new Error('Could not open this EPUB.'));
      }
    })();
    return () => controller.abort();
  }, [file.id, revision]);

  useEffect(() => { setSelectedChapter(undefined); }, [file.id, startChapter]);
  useEffect(() => {
    if (book && initialChapter !== undefined) position.onPageChange(index + 1);
  }, [book, initialChapter, index]);

  const pages = useMemo(() => book?.sections.map((section) => section.blocks.map((block) => block.text).join('\n\n')) ?? [], [book]);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return book?.sections.flatMap((section, i) => section.blocks.some((block) => block.text.toLowerCase().includes(term))
      ? [i] : []) ?? [];
  }, [book, query]);
  const chapter = initialChapter === undefined ? undefined : book?.sections[index];
  const chapterSections = useMemo(() => chapter?.blocks.map((block, i) => ({ section: index + 1,
    key: chapter.id, block: i + 1, text: block.text })) ?? [], [chapter, index]);
  const annotations = useLiteratureTextAnnotations({ attachmentId: file.id, referenceId: file.reference_id, fileName: file.file_name, sections: chapterSections,
    section: index + 1, root: scroll, annotationId, onJump: (section) => { if (section !== index + 1) go(section - 1); } });
  const paragraphs = useMemo(() => chapter?.blocks.map((block) => block.kind === 'code' ? '' : block.text) ?? [], [chapter]);
  useEffect(() => {
    if (spoken !== null) scroll.current?.querySelector('[data-speaking="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [spoken]);
  function go(next: number) {
    if (!book?.sections[next]) return;
    setSelectedChapter(next);
    scroll.current?.scrollTo({ top: 0 });
  }

  return <Modal title={file.file_name} onClose={onClose} wide inline={inline}>
    <div className={styles.reader}>
      <ErrorState error={error} retry={() => setRevision((value) => value + 1)} />
      {!chapter && !error && <Loading />}
      {book && chapter && <>
        {position.saveError && <Notice tone="error">{position.saveError}{' '}
          <button type="button" className="text-link" onClick={position.retry}>Sync this chapter</button>
          {position.syncConflict && <button type="button" className="text-link" onClick={() => void position.useSyncedPage((page) => go(page - 1))}>
            Open synced chapter
          </button>}
        </Notice>}
        <div className={styles.toolbar} aria-label="EPUB navigation">
          <button type="button" className="button small" disabled={!index} onClick={() => go(index - 1)}>Previous chapter</button>
          <label>Chapter <select value={index} onChange={(event) => go(Number(event.target.value))}>
            {book.sections.map((section, i) => <option key={section.id} value={i}>{section.title}</option>)}
          </select></label>
          <button type="button" className="button small" disabled={index >= book.sections.length - 1}
            onClick={() => go(index + 1)}>Next chapter</button>
        </div>
        <LiteratureReaderAppearance preferences={preferences} update={updatePreferences} />
        <div className={styles.toolbar}>
          <input type="search" aria-label="Find in EPUB" placeholder="Find in EPUB" maxLength={200}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          {query.trim() && (matches.length ? <label>Matching chapters <select
            value={matches.includes(index) ? index : ''} onChange={(event) => go(Number(event.target.value))}>
            <option value="" disabled>Choose a result</option>
            {matches.map((i) => <option key={i} value={i}>{book.sections[i].title}</option>)}
          </select></label> : <span className="muted small-text">No matching chapters</span>)}
          <LiteratureIndexButton id={file.id} pages={pages} />
          {annotations.trigger}
        </div>
        <LiteratureReadAloud key={index} paragraphs={paragraphs} onParagraph={setSpoken} />
        <div className={styles.readingArea} data-side-panel="true">
        <div ref={scroll} className={styles.scroll} role="region" aria-label="EPUB chapter" tabIndex={0} data-reader-theme={preferences.theme}>
          <article className={styles.reflow} lang={book.language ?? undefined}
            style={{ fontFamily: preferences.font, fontSize: preferences.fontSize, lineHeight: preferences.lineHeight }}>
            {chapter.blocks.map((block, i) => {
              const anchor = `${index + 1}:${i + 1}`;
              const text = annotations.paint(index + 1, i + 1, block.text);
              if (block.kind === 'heading') {
                const heading = Math.max(1, Math.min(6, block.level ?? 2));
                return <div role="heading" aria-level={heading} className={styles.epubHeading} key={i}
                  data-text-anchor={anchor} data-speaking={spoken === i || undefined}>{text}</div>;
              }
              if (block.kind === 'quote') return <blockquote key={i} data-text-anchor={anchor} data-speaking={spoken === i || undefined}>{text}</blockquote>;
              if (block.kind === 'code') return <pre key={i} data-text-anchor={anchor}>{text}</pre>;
              return <p key={i} data-speaking={spoken === i || undefined}>{block.kind === 'list-item' && '• '}<span data-text-anchor={anchor}>{text}</span></p>;
            })}
          </article>
        </div>
        <aside className={styles.sidePanel}>{annotations.panel}</aside>
        </div>
      </>}
    </div>
  </Modal>;
}
