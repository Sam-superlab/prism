'use client';

import { useEffect, useRef, useState } from 'react';
import type { BibliographyItem } from '../lib/bibliography';
import {
  buildLiteratureWritingExport,
  literatureWritingDocumentStem,
  maxLiteratureWritingBytes,
  type LiteratureWritingFormat,
} from '../lib/literature-writing-export';
import { Field, Modal, Notice } from './ui';
import { LiteratureWordExport } from './LiteratureWordExport';
import { LiteratureGoogleDocsExport } from './LiteratureGoogleDocsExport';
import { LiteratureWriterAddon } from './LiteratureWriterAddon';

function downloadFile(filename: string, file: Blob) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function LiteratureWritingExport({
  load,
  onClose,
}: {
  load: (signal: AbortSignal) => Promise<readonly BibliographyItem[]>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<
    'markdown' | 'word' | 'odt' | 'google-docs' | 'writer-addon' | 'word-addon'
  >('markdown');
  return (
    <Modal title="Export writing project" onClose={onClose} wide>
      <Field label="Writing format">
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="markdown">Markdown or Quarto</option>
          <option value="word">Word document (.docx)</option>
          <option value="word-addon">Word extension (pilot)</option>
          <option value="odt">LibreOffice Writer (.odt)</option>
          <option value="writer-addon">LibreOffice Writer extension</option>
          <option value="google-docs">Google Docs</option>
        </select>
      </Field>
      {mode === 'markdown' ? (
        <LiteratureMarkdownWritingExport load={load} />
      ) : mode === 'google-docs' ? (
        <LiteratureGoogleDocsExport load={load} />
      ) : mode === 'writer-addon' || mode === 'word-addon' ? (
        <LiteratureWriterAddon key={mode} load={load} target={mode === 'word-addon' ? 'word' : 'writer'} />
      ) : (
        <LiteratureWordExport key={mode} load={load} format={mode === 'word' ? 'docx' : 'odt'} />
      )}
    </Modal>
  );
}

function LiteratureMarkdownWritingExport({
  load,
}: Pick<Parameters<typeof LiteratureWritingExport>[0], 'load'>) {
  const [source, setSource] = useState('');
  const [filename, setFilename] = useState('manuscript');
  const [quarto, setQuarto] = useState(true);
  const [format, setFormat] = useState<LiteratureWritingFormat>('csl-json');
  const [result, setResult] = useState<ReturnType<typeof buildLiteratureWritingExport>>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [readingFile, setReadingFile] = useState(false);
  const active = useRef<AbortController>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  const documentName = filename + (quarto ? '.qmd' : '.md');

  function clearResult() {
    setResult(undefined);
    setStatus('');
    setError('');
  }

  async function readFile(file: File) {
    clearResult();
    if (file.size > maxLiteratureWritingBytes) {
      setError('Choose a Markdown or Quarto document no larger than 512 KiB.');
      return;
    }
    const suffix = /\.(md|markdown|qmd)$/i.exec(file.name);
    if (!suffix) {
      setError('Choose a Markdown or Quarto document.');
      return;
    }
    setReadingFile(true);
    try {
      const text = await file.text();
      if (mounted.current) {
        setSource(text);
        setQuarto(suffix[1].toLowerCase() === 'qmd');
        setFilename(literatureWritingDocumentStem(file.name));
      }
    } catch {
      if (mounted.current) setError('Could not read this document.');
    } finally {
      if (mounted.current) setReadingFile(false);
    }
  }

  async function prepare() {
    if (active.current) return;
    clearResult();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      if (
        source.length > maxLiteratureWritingBytes ||
        new TextEncoder().encode(source).byteLength > maxLiteratureWritingBytes
      )
        throw new Error('Choose a Markdown or Quarto document no larger than 512 KiB.');
      const library = await load(controller.signal);
      controller.signal.throwIfAborted();
      setResult(buildLiteratureWritingExport(source, library, format, quarto));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Could not prepare this writing project.');
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(label + ' copied.');
    } catch {
      setStatus('Clipboard unavailable. Download the file instead.');
    }
  }

  async function downloadProject() {
    if (!result) return;
    setError('');
    try {
      const { strToU8, zipSync } = await import('fflate');
      if (!mounted.current) return;
      const bytes = zipSync(
        {
          [documentName]: strToU8(result.document),
          [result.bibliography.filename]: strToU8(result.bibliography.content),
        },
        { level: 0 },
      );
      downloadFile(filename + '-prism.zip', new Blob([Uint8Array.from(bytes)], { type: 'application/zip' }));
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not download the project.');
    }
  }

  return (
    <>
      <p className="muted">
        Resolve @citation keys against the references in this view. The document is processed on this device.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void prepare();
        }}
      >
        <div className="form-grid">
          <Field label="Open Markdown or Quarto document">
            <input
              type="file"
              accept=".md,.markdown,.qmd,text/markdown"
              disabled={busy || readingFile}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void readFile(file);
              }}
            />
          </Field>
          <Field label="Document format">
            <select
              value={quarto ? 'qmd' : 'md'}
              disabled={busy || readingFile}
              onChange={(event) => {
                setQuarto(event.target.value === 'qmd');
                clearResult();
              }}
            >
              <option value="qmd">Quarto (.qmd)</option>
              <option value="md">Pandoc Markdown (.md)</option>
            </select>
          </Field>
          <Field label="Bibliography format">
            <select
              value={format}
              disabled={busy || readingFile}
              onChange={(event) => {
                setFormat(event.target.value as LiteratureWritingFormat);
                clearResult();
              }}
            >
              <option value="csl-json">CSL JSON (.json)</option>
              <option value="biblatex">BibLaTeX (.bib)</option>
            </select>
          </Field>
        </div>
        <Field
          label="Document Markdown"
          hint="Paste text with citations such as [@smith2024, p. 12; @lee2020]."
        >
          <textarea
            rows={8}
            required
            maxLength={maxLiteratureWritingBytes}
            value={source}
            disabled={busy || readingFile}
            onChange={(event) => {
              setSource(event.target.value);
              clearResult();
            }}
          />
        </Field>
        <div className="inline-actions">
          <button type="submit" className="button primary" disabled={busy || readingFile || !source.trim()}>
            {busy ? 'Resolving citations…' : 'Prepare export'}
          </button>
          {busy && (
            <button type="button" className="button" onClick={() => active.current?.abort()}>
              Cancel preparation
            </button>
          )}
        </div>
      </form>
      {error && (
        <Notice tone="error">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {result && (
        <section aria-label="Writing export result">
          <p role="status">
            {result.resolved} {result.resolved === 1 ? 'reference' : 'references'} matched.
          </p>
          {!!result.missing.length && <Notice tone="error">Missing keys: {result.missing.join(', ')}</Notice>}
          {!!result.ambiguous.length && (
            <Notice tone="error">Ambiguous keys: {result.ambiguous.join(', ')}</Notice>
          )}
          {!!result.aliases.length && (
            <details>
              <summary>
                {result.aliases.length} {result.aliases.length === 1 ? 'alias' : 'aliases'} updated
              </summary>
              <ul>
                {result.aliases.map(({ from, to }) => (
                  <li key={from}>
                    <code>{from}</code> → <code>{to}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {result.metadataWarning && <Notice>{result.metadataWarning}</Notice>}
          {!!result.resolved && (
            <div className="inline-actions">
              <button type="button" className="button primary" onClick={() => void downloadProject()}>
                Download writing project ZIP
              </button>
              <button
                type="button"
                className="button"
                onClick={() =>
                  downloadFile(
                    documentName,
                    new Blob([result.document], { type: 'text/markdown;charset=utf-8' }),
                  )
                }
              >
                Download document
              </button>
              <button
                type="button"
                className="button"
                onClick={() =>
                  downloadFile(
                    result.bibliography.filename,
                    new Blob([result.bibliography.content], { type: result.bibliography.mimeType }),
                  )
                }
              >
                Download bibliography
              </button>
              <button type="button" className="button" onClick={() => void copy(result.document, 'Document')}>
                Copy document
              </button>
              <button
                type="button"
                className="button"
                onClick={() => void copy(result.bibliography.content, 'Bibliography')}
              >
                Copy bibliography
              </button>
            </div>
          )}
        </section>
      )}
      {status && <p role="status">{status}</p>}
    </>
  );
}
