'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api, useAction } from '../lib/api';
import type { EmbeddedPdfPreview } from '../lib/literature-embedded-pdf-annotations';
import { Notice } from './ui';
import styles from './LiteraturePdfReader.module.css';

const kindLabels = {
  highlight: 'Highlight', underline: 'Underline', note: 'Note', area: 'Marked area', ink: 'Ink stroke',
};

export function LiteratureEmbeddedPdfAnnotations({ pdf, pdfId, path, existing, showOriginal, onShowOriginal, onImported, onPage }: {
  pdf: PDFDocumentProxy;
  pdfId: string;
  path: string;
  existing: ReadonlySet<string>;
  showOriginal: boolean;
  onShowOriginal: (show: boolean) => void;
  onImported: () => void;
  onPage: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<EmbeddedPdfPreview>();
  const [selected, setSelected] = useState(new Set<string>());
  const [finished, setFinished] = useState(new Set<string>());
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<{ imported: number; skipped: number }>();
  const scan = useAction();
  const save = useAction();
  const scanController = useRef<AbortController>(null);
  useEffect(() => () => scanController.current?.abort(), []);

  const eligible = (preview?.candidates ?? []).filter(({ id }) => !existing.has(id) && !finished.has(id));
  const chosen = eligible.filter(({ id }) => selected.has(id));

  async function scanMarks() {
    setOpen(true);
    setProgress('');
    const controller = new AbortController();
    scanController.current = controller;
    try {
      const { previewEmbeddedPdfAnnotations } = await import('../lib/literature-embedded-pdf-annotations');
      const next = await previewEmbeddedPdfAnnotations(pdf, pdfId, controller.signal,
        (page, total) => setProgress(`Scanning page ${page} of ${total}…`));
      setPreview(next);
      setSelected(new Set(next.candidates.map(({ id }) => id)));
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      scanController.current = null;
    }
  }

  async function importSelection() {
    const completed: string[] = [];
    const outcome = { imported: 0, skipped: 0 };
    const encoder = new TextEncoder();
    setResult(undefined);
    try {
      let start = 0;
      while (start < chosen.length) {
        let batch = chosen.slice(start, start + 25);
        while (encoder.encode(JSON.stringify({ annotations: batch })).length > 900_000 && batch.length > 1)
          batch = batch.slice(0, Math.ceil(batch.length / 2));
        const response = await api<{ imported: string[]; skipped: string[] }>(`${path}/import`, {
          method: 'POST', body: { annotations: batch },
        });
        completed.push(...response.imported, ...response.skipped);
        outcome.imported += response.imported.length;
        outcome.skipped += response.skipped.length;
        start += batch.length;
      }
    } finally {
      if (completed.length) {
        setFinished((previous) => new Set([...previous, ...completed]));
        setResult(outcome);
        if (outcome.imported) onImported();
      }
    }
  }

  return <div className={styles.embeddedImport}>
    <button type="button" className="button small" aria-expanded={open} disabled={save.busy}
      onClick={() => {
        if (open) {
          scanController.current?.abort();
          setOpen(false);
        } else if (preview) setOpen(true);
        else void scan.run(scanMarks);
      }}>{open ? 'Close PDF mark preview' : 'Import marks from this PDF'}</button>
    {open && <section aria-label="Embedded PDF mark preview">
      <p className="muted small-text">Choose the embedded marks to copy as editable PRISM annotations. The original PDF stays intact.</p>
      {scan.busy && <p role="status" className="muted small-text">{progress || 'Opening PDF marks…'}</p>}
      {scan.error && <Notice tone="error">{scan.error}{' '}
        <button type="button" className="text-link" onClick={() => void scan.run(scanMarks)}>Try again</button>
      </Notice>}
      {preview && <>
        <label className="small-text">
          <input type="checkbox" checked={showOriginal} onChange={(event) => onShowOriginal(event.target.checked)} />{' '}
          Show original PDF marks
        </label>
        {!!preview.candidates.length && <p className="muted small-text">Colors use the PRISM palette. A drawing with several strokes becomes separate ink marks.</p>}
        {!preview.candidates.length && <p className="muted small-text">No supported marks found.</p>}
        {!!preview.skipped.length && <details className="small-text">
          <summary>{preview.skipped.length} {preview.skipped.length === 1 ? 'mark needs' : 'marks need'} manual review</summary>
          <ul>{preview.skipped.map(({ page, reason }, index) => <li key={index}>Page {page} · {reason}</li>)}</ul>
        </details>}
        {preview.limited && <p className="muted small-text">The preview reached its limit. Some marks may be absent.</p>}
        {!!eligible.length && <div className="inline-actions">
          <button className="text-link" type="button" disabled={save.busy}
            onClick={() => setSelected(new Set(eligible.map(({ id }) => id)))}>Select all</button>
          <button className="text-link" type="button" disabled={save.busy} onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>}
        {!!eligible.length && <ul className={styles.embeddedMarks}>
          {eligible.map(({ id, kind, page, comment, text }) => <li key={id}>
            <label><input type="checkbox" disabled={save.busy} checked={selected.has(id)} onChange={(event) => {
              const checked = event.target.checked;
              setSelected((previous) => {
                const next = new Set(previous);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              });
            }} />{' '}{kindLabels[kind]}{(text || comment) && ` · ${(text || comment)!.slice(0, 140)}`}</label>{' '}
            <button type="button" className="text-link" onClick={() => onPage(page)}>Page {page}</button>
          </li>)}
        </ul>}
        {eligible.length < preview.candidates.length && <p className="muted small-text">
          {preview.candidates.length - eligible.length} already handled.
        </p>}
        {!!eligible.length && <button type="button" className="button primary small" disabled={!chosen.length || save.busy}
          onClick={() => void save.run(importSelection)}>{save.busy ? 'Importing…' : `Import ${chosen.length} selected`}</button>}
        {result && <p role="status" className="small-text">Imported {result.imported}.
          {result.skipped > 0 && ` Skipped ${result.skipped} previously handled.`}
        </p>}
        {save.error && <Notice tone="error">{save.error} You can retry the remaining selection.</Notice>}
      </>}
    </section>}
  </div>;
}
