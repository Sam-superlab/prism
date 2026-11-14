'use client';

import { useRef, useState } from 'react';
import { api, useAction, uuid } from '../lib/api';
import type { LookupReference } from './LiteratureIdentifierLookup';
import { maxLiteraturePdfBytes, uploadLiteraturePdf, type LiteraturePdfUpload } from '../lib/literature-pdfs';
import { Field, Modal, Notice } from './ui';

type PdfDraft = { title: string; authors: string[]; doi: string | null; year: number | null };

export function LiteraturePdfImport({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState<PdfDraft>();
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(0);
  const [selectedDoi, setSelectedDoi] = useState('');
  const [found, setFound] = useState<LookupReference>();
  const [applied, setApplied] = useState<LookupReference>();
  const [metadataRevision, setMetadataRevision] = useState(0);
  const task = useRef<{ referenceId: string; created: boolean; upload: LiteraturePdfUpload }>(null);
  const epoch = useRef(0);
  const inspection = useRef<AbortController>(null);
  const action = useAction();
  const lookup = useAction();
  const current = task.current;

  async function prepare(file?: File) {
    const token = ++epoch.current;
    inspection.current?.abort();
    const controller = new AbortController();
    inspection.current = controller;
    task.current = null;
    setDraft(undefined);
    setNote('');
    setProgress(0);
    setFound(undefined);
    setApplied(undefined);
    setSelectedDoi('');
    lookup.setError(null);
    setLoading(false);
    action.setError(null);
    if (!file) return;
    if (file.size < 8 || file.size > maxLiteraturePdfBytes) {
      action.setError('Choose a PDF no larger than 32 MiB.');
      return;
    }
    setLoading(true);
    const fallback = file.name.replace(/\.pdf$/i, '').slice(0, 500).trim();
    try {
      const header = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
      if (!header.startsWith('%PDF-')) throw new Error('This file does not have a PDF header.');
      const { extractLiteraturePdfMetadata } = await import('../lib/literature-pdf-metadata');
      let metadata: PdfDraft;
      try {
        metadata = await extractLiteraturePdfMetadata(file, controller.signal);
      } catch {
        metadata = { title: fallback, authors: [], doi: null, year: null };
        if (epoch.current === token) setNote('Metadata could not be read. Fill in the details before saving.');
      }
      if (epoch.current !== token) return;
      task.current = {
        referenceId: uuid(), created: false,
        upload: { id: uuid(), initKey: uuid(), completeKey: uuid(), chunkKeys: new Map(), file },
      };
      setDraft({ ...metadata, title: metadata.title || fallback });
      setSelectedDoi(metadata.doi ?? '');
    } catch (cause) {
      if (epoch.current === token) action.setError(cause instanceof Error ? cause.message : 'Could not read the PDF.');
    } finally {
      if (epoch.current === token) setLoading(false);
    }
  }

  return (
    <Modal title="Import PDF as reference" onClose={() => { if (!action.busy) { inspection.current?.abort(); epoch.current++; onClose(); } }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const job = task.current;
        if (!job || action.busy || lookup.busy) return;
        const data = new FormData(event.currentTarget);
        const value = (field: string) => String(data.get(field) ?? '').trim();
        void action.run(async () => {
          if (!job.created) {
            const useLookup = applied && applied.doi?.toLowerCase() === value('doi').toLowerCase();
            await api('/research/references', {
              method: 'POST',
              key: job.referenceId,
              body: {
                id: job.referenceId,
                title: value('title'),
                authors: value('authors').split(';').map((author) => author.trim()).filter(Boolean),
                doi: value('doi') || null,
                year: value('year') ? Number(value('year')) : null,
                ...(useLookup && { url: applied.url, publication: applied.publication }),
              },
            });
            job.created = true;
          }
          await uploadLiteraturePdf(job.referenceId, job.upload, setProgress);
          onSaved(job.referenceId);
        });
      }}>
        <Field label="Choose a PDF" hint="Up to 32 MiB per file.">
          <input type="file" accept=".pdf,application/pdf" disabled={action.busy || lookup.busy || current?.created}
            onChange={(event) => void prepare(event.target.files?.[0])} />
        </Field>
        {loading && <p role="status">Reading PDF metadata…</p>}
        {note && <p className="muted">{note}</p>}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {draft && (
          <fieldset key={metadataRevision} disabled={action.busy || lookup.busy || current?.created}>
            <Field label="Title"><input name="title" required maxLength={500} defaultValue={draft.title} /></Field>
            <Field label="Authors" hint="Separate authors with semicolons.">
              <input name="authors" maxLength={4000} defaultValue={draft.authors.join('; ')} />
            </Field>
            <div className="form-grid">
              <Field label="DOI"><input name="doi" maxLength={250} value={selectedDoi} onChange={(event) => setSelectedDoi(event.target.value)} /></Field>
              <Field label="Year"><input name="year" type="number" min={1} max={9999} defaultValue={draft.year ?? ''} /></Field>
            </div>
          </fieldset>
        )}
        {draft && !!selectedDoi.trim() && !current?.created && <div className="inline-actions">
          <button className="button small" type="button" disabled={action.busy || lookup.busy} onClick={() => {
            setFound(undefined);
            const params = new URLSearchParams({ kind: 'doi', value: selectedDoi.trim() });
            void lookup.run(async () => {
              const data = await api<{ reference: LookupReference }>(`/research/library/lookup?${params}`);
              setFound(data.reference);
            });
          }}>{lookup.busy ? 'Looking up…' : 'Find DOI details'}</button>
          <span className="small-text muted">Search Crossref using this DOI.</span>
        </div>}
        {lookup.error && <Notice tone="error">{lookup.error}</Notice>}
        {found && found.doi?.toLowerCase() === selectedDoi.trim().toLowerCase() && !current?.created && <div className="inline-actions">
          <span>{[found.title, found.authors.join(', '), found.year].filter(Boolean).join(' · ')}</span>
          <button className="button small" type="button" disabled={action.busy || lookup.busy} onClick={() => {
            setDraft({ title: found.title, authors: found.authors, year: found.year, doi: found.doi });
            setApplied(found);
            setMetadataRevision((value) => value + 1);
            setNote('Crossref metadata loaded. Review the fields before saving.');
          }}>Use these details</button>
        </div>}
        {action.busy && current && <progress aria-label="PDF upload progress" max={current.upload.file.size} value={progress} />}
        {current?.created && !action.busy && <p className="muted">The reference is saved. Retry to finish adding its PDF.</p>}
        <div className="modal-footer">
          <button className="button primary" type="submit" disabled={!draft || loading || action.busy || lookup.busy}>
            {action.busy ? 'Saving…' : current?.created ? 'Retry PDF upload' : 'Save reference and PDF'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
