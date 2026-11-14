'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { literatureAttachmentDownload, type LiteratureAttachment } from '../lib/literature-pdfs';
import { useLiteratureReaderPreferences } from '../lib/literature-reader-preferences';
import { ErrorState, Loading, Modal } from './ui';
import { LiteratureIndexButton } from './LiteratureIndexButton';
import { LiteratureReaderAppearance } from './LiteratureReaderAppearance';
import { LiteratureReadAloud } from './LiteratureReadAloud';
import { useLiteratureTextAnnotations } from './LiteratureTextAnnotations';
import styles from './LiteraturePdfReader.module.css';

export function LiteratureWebpageReader({ file, onClose, startParagraph, annotationId, inline }: {
  file: LiteratureAttachment; onClose: () => void; startParagraph?: number; annotationId?: string; inline?: boolean;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(0);
  const [spoken, setSpoken] = useState<number | null>(null);
  const { preferences, updatePreferences } = useLiteratureReaderPreferences();
  const scroll = useRef<HTMLDivElement>(null);
  const paragraphs = useMemo(() => content?.split(/\n{2,}/u) ?? [], [content]);
  const sections = useMemo(() => paragraphs.map((text, index) => ({ section: index + 1, block: 1, key: null, text })), [paragraphs]);
  const annotations = useLiteratureTextAnnotations({ attachmentId: file.id, referenceId: file.reference_id, fileName: file.file_name, sections, root: scroll, annotationId,
    onJump: (section) => scroll.current?.querySelector(`[data-text-anchor="${section}:1"]`)?.scrollIntoView({ block: 'center' }) });
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? paragraphs.flatMap((paragraph, i) => paragraph.toLowerCase().includes(term) ? [i] : []) : [];
  }, [paragraphs, search]);
  const current = search.trim() ? matches[selected] : startParagraph === undefined ? undefined : startParagraph - 1;
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetch(literatureAttachmentDownload(file.id), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/plain'))
          throw new Error('Could not open the saved page text.');
        const text = await response.text();
        if (!controller.signal.aborted) setContent(text);
      })
      .catch((error) => { if (!controller.signal.aborted) setError(error); });
    return () => controller.abort();
  }, [file.id, revision]);
  useEffect(() => {
    if (current !== undefined) scroll.current?.querySelector('[data-current-match]')?.scrollIntoView({ block: 'nearest' });
  }, [current, content]);
  useEffect(() => {
    if (spoken !== null) scroll.current?.querySelector('[data-speaking="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [spoken]);

  return <Modal title={file.file_name} onClose={onClose} wide inline={inline}>
    <div className={styles.reader}>
      <ErrorState error={error} retry={() => setRevision((value) => value + 1)} />
      {content === undefined && !error && <Loading />}
      {content !== undefined && <>
        <LiteratureReaderAppearance preferences={preferences} update={updatePreferences} />
        <div className={styles.toolbar}>
          <input type="search" aria-label="Find in page snapshot" placeholder="Find in page snapshot" maxLength={200}
            value={search} onChange={(event) => { setSearch(event.target.value); setSelected(0); }} />
          {search.trim() && <span className="muted small-text" aria-live="polite">
            {matches.length ? `${selected + 1} of ${matches.length}` : 'No matches'}
          </span>}
          {matches.length > 1 && <>
            <button type="button" className="button small" disabled={selected <= 0} onClick={() => setSelected(selected - 1)}>Previous match</button>
            <button type="button" className="button small" disabled={selected >= matches.length - 1} onClick={() => setSelected(selected + 1)}>Next match</button>
          </>}
          <LiteratureIndexButton id={file.id} pages={paragraphs} />
          {annotations.trigger}
        </div>
        <LiteratureReadAloud paragraphs={paragraphs} onParagraph={setSpoken} />
        <div className={styles.readingArea} data-side-panel="true">
        <div ref={scroll} className={styles.scroll} role="region" aria-label="Saved page text" tabIndex={0} data-reader-theme={preferences.theme}>
          <article className={styles.reflow}
            style={{ fontFamily: preferences.font, fontSize: preferences.fontSize, lineHeight: preferences.lineHeight }}>
            {paragraphs.map((paragraph, i) => <p key={i} data-current-match={current === i || undefined}
              data-text-anchor={`${i + 1}:1`} data-speaking={spoken === i || undefined}>{annotations.paint(i + 1, 1, paragraph)}</p>)}
          </article>
        </div>
        <aside className={styles.sidePanel}>{annotations.panel}</aside>
        </div>
      </>}
    </div>
  </Modal>;
}
