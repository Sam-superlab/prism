'use client';

import { useEffect, useRef, useState } from 'react';
import type { BibliographyItem } from '../lib/bibliography';
import type { buildLiteratureDocxExport } from '../lib/literature-docx';
import { Field, Notice } from './ui';

const wordFile = {
  extension: 'docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  label: 'Word',
  field: 'Word citation fields',
};
const odtFile = {
  extension: 'odt',
  mime: 'application/vnd.oasis.opendocument.text',
  label: 'LibreOffice',
  field: 'LibreOffice bibliography fields',
};

export function LiteratureWordExport({
  load,
  format = 'docx',
}: {
  load: (signal: AbortSignal) => Promise<readonly BibliographyItem[]>;
  format?: 'docx' | 'odt';
}) {
  const variant = format === 'odt' ? odtFile : wordFile;
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<ReturnType<typeof buildLiteratureDocxExport>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  async function prepare() {
    if (!file || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setResult(undefined);
    setError('');
    try {
      const processor =
        format === 'odt'
          ? await import('../lib/literature-odt').then((module) => ({
              build: module.buildLiteratureOdtExport,
              limit: module.maxLiteratureOdtBytes,
            }))
          : await import('../lib/literature-docx').then((module) => ({
              build: module.buildLiteratureDocxExport,
              limit: module.maxLiteratureDocxBytes,
            }));
      if (file.size > processor.limit)
        throw new Error(`Choose an unsigned .${variant.extension} file no larger than 24 MiB.`);
      const items = await load(controller.signal);
      const bytes = await file.arrayBuffer();
      controller.signal.throwIfAborted();
      setResult(processor.build(bytes, items));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : `Could not prepare the ${variant.label} document.`);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function download() {
    if (!result?.bytes) return;
    const blob = new Blob([Uint8Array.from(result.bytes)], {
      type: variant.mime,
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      (file?.name.replace(/\.(?:docx|odt)$/i, '').slice(0, 80) || 'manuscript') +
      '-prism.' +
      variant.extension;
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void prepare();
      }}
    >
      <p className="muted">
        Type <code>[[cite:reference-key]]</code> in {variant.label}, or{' '}
        <code>[[cite:reference-key|12–14]]</code> to add pages. Put <code>[[bibliography]]</code> on a line by
        itself. PRISM creates a local copy with {variant.field}
        {format === 'odt' ? '.' : ' and APA previews.'}
        {format === 'odt' && ' Writer displays its native citation labels. Page locators stay in the text.'}
      </p>
      <Field
        label={`Open ${variant.label} document`}
        hint={`Choose an unsigned .${variant.extension} up to 24 MiB.`}
      >
        <input
          type="file"
          accept={`.${variant.extension},${variant.mime}`}
          disabled={busy}
          onChange={(event) => {
            const selection = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            setResult(undefined);
            setError('');
            if (selection && !selection.name.toLowerCase().endsWith('.' + variant.extension)) {
              setError(`Choose a .${variant.extension} document.`);
              setFile(undefined);
            } else setFile(selection);
          }}
        />
      </Field>
      {file && <p className="small-text muted">{file.name}</p>}
      <div className="inline-actions">
        <button className="button primary" type="submit" disabled={!file || busy}>
          {busy ? 'Resolving citations…' : `Prepare ${variant.label} copy`}
        </button>
        {busy && (
          <button className="button" type="button" onClick={() => active.current?.abort()}>
            Cancel preparation
          </button>
        )}
      </div>
      {error && (
        <Notice tone="error">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {result && (
        <>
          <p role="status">
            {result.citations} {result.citations === 1 ? 'citation' : 'citations'} added
            {result.bibliography ? ' with a bibliography.' : '.'}
          </p>
          {!!result.missing.length && <Notice tone="error">Missing keys: {result.missing.join(', ')}</Notice>}
          {!!result.ambiguous.length && (
            <Notice tone="error">Ambiguous keys: {result.ambiguous.join(', ')}</Notice>
          )}
          {!!result.skipped && (
            <Notice>
              {result.skipped} {result.skipped === 1 ? 'marker was' : 'markers were'} left in place.
            </Notice>
          )}
          {result.bytes && (
            <button type="button" className="button primary" onClick={download}>
              Download {variant.label} copy
            </button>
          )}
        </>
      )}
    </form>
  );
}
