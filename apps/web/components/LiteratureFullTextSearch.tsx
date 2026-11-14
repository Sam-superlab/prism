'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useResource } from '../lib/api';
import { literaturePdfHref } from '../lib/literature-pdf-notes';
import type { LiteratureAttachmentFormat } from '../lib/literature-pdfs';
import type { Page } from '../lib/types';
import { ErrorState, Loading, Modal } from './ui';
import { LiteratureBulkTextIndex } from './LiteratureBulkTextIndex';
import styles from './ResearchReferences.module.css';

type Match = {
  pdf_id: string; reference_id: string; title: string; file_name: string;
  page: number; format: LiteratureAttachmentFormat; kind: 'page' | 'annotation'; snippet: string; annotation_id: string | null;
};
const locations = { pdf: 'Page', epub: 'Chapter', webpage: 'Paragraph' } as const;
const textKinds = { pdf: 'PDF text', epub: 'EPUB text', webpage: 'Page snapshot' } as const;

export function LiteratureFullTextSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({ q: query, limit: '25' });
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const matches = useResource<Page<Match>>(query ? `/research/library/full-text?${params}` : null);
  const next = matches.data?.next_cursor;

  return (
    <Modal title="Search attachment text and annotations" onClose={onClose} wide>
      <form className={styles.toolbar} onSubmit={(event) => {
        event.preventDefault();
        setQuery(String(new FormData(event.currentTarget).get('query') ?? '').trim());
        setCursors([]);
        matches.reload();
      }}>
        <input type="search" name="query" className={styles.search} aria-label="Search attachment text"
          placeholder="Find a phrase in attachments or annotations" required maxLength={200} />
        <button className="button primary" type="submit">Search</button>
      </form>
      {!query && <p className="muted">Index attached PDFs, EPUBs, and snapshots in one pass. Use the PDF reader for scan recognition.</p>}
      <LiteratureBulkTextIndex />
      <ErrorState error={matches.error} retry={matches.reload} />
      {matches.loading && <Loading />}
      {!matches.loading && !matches.error && matches.data && (
        <>
          {matches.data.items.length === 0 && <p className="muted">No matching text or annotations.</p>}
          <ul className={styles.rows}>
            {matches.data.items.map((item) => (
              <li className={styles.row} key={`${item.pdf_id}:${item.page}:${item.annotation_id ?? 'text'}`}>
                <div>
                  <Link className={`text-link ${styles.rowTitle}`} onClick={onClose}
                    href={literaturePdfHref(item.reference_id, item.pdf_id, item.page, item.annotation_id)}>
                    {item.title} · {locations[item.format ?? 'pdf']} {item.page}
                  </Link>
                  <small className="muted">{item.file_name} · {item.kind === 'annotation' ? 'Annotation' : textKinds[item.format ?? 'pdf']}</small>
                  <p>{item.snippet}</p>
                </div>
              </li>
            ))}
          </ul>
          {(cursors.length > 0 || next) && (
            <div className={styles.pagination}>
              <button type="button" className="button small" disabled={!cursors.length}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}>Previous page</button>
              <button type="button" className="button small" disabled={!next}
                onClick={() => { if (next) setCursors((previous) => [...previous, next]); }}>Next page</button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
