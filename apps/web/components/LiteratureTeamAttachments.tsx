'use client';

import { useRef, useState } from 'react';
import { api, useAction, useResource, uuid } from '../lib/api';
import type { BibliographyItem } from '../lib/bibliography';
import type { LiteraturePdf } from '../lib/literature-pdfs';
import type { Page } from '../lib/types';
import { ErrorState, Field, Loading, Notice } from './ui';
import styles from './ResearchReferences.module.css';

type TeamAttachment = { id: string; file_name: string; size_bytes: number; created_by_name: string; version: string };

export function LiteratureTeamAttachments({ referencePath, canEdit, onRead }: {
  referencePath: string; canEdit: boolean; onRead: (attachmentPath: string, fileName: string) => void;
}) {
  const path = `${referencePath}/attachments`;
  const files = useResource<{ items: TeamAttachment[] }>(path);
  const action = useAction(files.reload);
  const [copy, setCopy] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [referenceId, setReferenceId] = useState('');
  const [attachmentId, setAttachmentId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [remove, setRemove] = useState<TeamAttachment>();
  const attempt = useRef<{ attachmentId: string; id: string }>(null);
  const library = useResource<Page<BibliographyItem>>(copy ? `/research/library?native=true&limit=25&q=${encodeURIComponent(query)}` : null);
  const source = useResource<{ items: LiteraturePdf[] }>(copy && referenceId ? `/research/references/${referenceId}/pdfs` : null);
  function closeCopy() {
    setCopy(false);
    setSearch(''); setQuery(''); setReferenceId(''); setAttachmentId(''); setConfirmed(false);
    attempt.current = null;
  }
  return <section aria-label="Shared PDFs" className={styles.referenceNotes}>
    <h4>Shared PDFs</h4>
    <ErrorState error={files.error} retry={files.reload} />
    {files.loading && <Loading />}
    {!files.loading && files.data?.items.length === 0 && <p className="muted small-text">No PDFs shared for this reference.</p>}
    <ul className={styles.rows}>{files.data?.items.map((file) => <li key={file.id} className={styles.row}>
      <div><span>{file.file_name}</span><p className="muted small-text">Added by {file.created_by_name}</p></div>
      <div className={styles.inlineActions}>
        <button className="button small" type="button" onClick={() => onRead(`${path}/${file.id}`, file.file_name)}>Read shared PDF</button>
        <a className="button small" href={`/api/v1${path}/${file.id}/download`} download={file.file_name}>Download PDF</a>
        {canEdit && <button className="button small" type="button" disabled={action.busy} aria-label={`Remove shared PDF ${file.file_name}`}
          onClick={() => setRemove(file)}>Remove</button>}
      </div>
    </li>)}</ul>
    {remove && <div className={styles.inlineActions}>
      <span className="small-text">Remove the shared copy of {remove.file_name}?</span>
      <button className="button small" type="button" disabled={action.busy} onClick={() => setRemove(undefined)}>Cancel</button>
      <button className="button small danger" type="button" disabled={action.busy} onClick={() => void action.run(async () => {
        await api(`${path}/${remove.id}`, { method: 'DELETE', version: remove.version });
        setRemove(undefined);
      })}>Remove shared copy</button>
    </div>}
    {canEdit && !copy && <button className="button small" type="button" disabled={action.busy} onClick={() => setCopy(true)}>Copy a PDF from my library</button>}
    {copy && canEdit && <form onSubmit={(event) => {
      event.preventDefault();
      if (!attachmentId || !confirmed || action.busy) return;
      if (attempt.current?.attachmentId !== attachmentId) attempt.current = { attachmentId, id: uuid() };
      const id = attempt.current.id;
      void action.run(async () => {
        await api(path, { method: 'POST', body: { id, attachment_id: attachmentId } });
        closeCopy();
      });
    }}>
      <div className={styles.inlineActions}>
        <input type="search" aria-label="Find personal reference for PDF" value={search} maxLength={300} onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setQuery(search.trim()); } }} />
        <button className="button small" type="button" onClick={() => setQuery(search.trim())}>Find reference</button>
      </div>
      <ErrorState error={library.error} retry={library.reload} />
      <Field label="PDF source reference"><select value={referenceId} disabled={library.loading || action.busy} onChange={(event) => {
        setReferenceId(event.target.value); setAttachmentId(''); setConfirmed(false);
      }}>
        <option value="">Choose a reference</option>
        {library.data?.items.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></Field>
      {referenceId && <Field label="PDF to share"><select value={attachmentId} disabled={source.loading || action.busy}
        onChange={(event) => { setAttachmentId(event.target.value); setConfirmed(false); }}>
        <option value="">Choose a PDF</option>
        {source.data?.items.map((item) => <option key={item.id} value={item.id}>{item.file_name}</option>)}
      </select></Field>}
      <ErrorState error={source.error} retry={source.reload} />
      {attachmentId && <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        {' '}Share a copy of this PDF with the library’s members.</label>}
      <div className={styles.inlineActions}>
        <button className="button small" type="button" disabled={action.busy} onClick={closeCopy}>Cancel</button>
        <button className="button small primary" type="submit" disabled={!attachmentId || !confirmed || action.busy}>Share PDF</button>
      </div>
    </form>}
    {action.error && <Notice tone="error">{action.error}</Notice>}
  </section>;
}
