'use client';

import { useEffect, useRef, useState } from 'react';
import type { BibliographyItem } from '../lib/bibliography';
import type { buildWriterCitationPacket } from '../lib/literature-writer-packet';
import { Field, Notice } from './ui';

export function LiteratureWriterAddon({
  load,
  target,
}: {
  load: (signal: AbortSignal) => Promise<readonly BibliographyItem[]>;
  target: 'writer' | 'word';
}) {
  const editor = target === 'word' ? 'Word' : 'Writer';
  const [keys, setKeys] = useState('');
  const [result, setResult] = useState<ReturnType<typeof buildWriterCitationPacket>>();
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
    if (active.current || !keys.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const [module, items] = await Promise.all([
        import('../lib/literature-writer-packet'),
        load(controller.signal),
      ]);
      controller.signal.throwIfAborted();
      setResult(module.buildWriterCitationPacket(keys, items));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : `Could not prepare this ${editor} packet.`);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function download() {
    if (!result?.entries.length) return;
    const url = URL.createObjectURL(new Blob([result.packet], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'prism-citations.txt';
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
        Save selected citation metadata to a local file. In {editor}, use the PRISM extension to insert a
        citation at the cursor and build its bibliography.
      </p>
      <Field
        label="Citation keys"
        hint="Copy keys from References. Separate multiple keys with a new line or comma."
      >
        <textarea
          value={keys}
          rows={5}
          maxLength={20_000}
          required
          disabled={busy}
          onChange={(event) => {
            setKeys(event.target.value);
            setResult(undefined);
            setError('');
          }}
        />
      </Field>
      <button className="button primary" type="submit" disabled={busy || !keys.trim()}>
        {busy ? 'Resolving references…' : `Prepare ${editor} packet`}
      </button>
      {error && (
        <Notice tone="error">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {result && (
        <>
          {!!result.missing.length && <Notice tone="error">Missing keys: {result.missing.join(', ')}</Notice>}
          {!!result.ambiguous.length && (
            <Notice tone="error">Ambiguous keys: {result.ambiguous.join(', ')}</Notice>
          )}
          {!!result.entries.length && (
            <>
              <ul aria-label="Selected references">
                {result.entries.map((entry) => (
                  <li key={entry.key}>
                    {entry.title} <code>{entry.key}</code>
                  </li>
                ))}
              </ul>
              <button className="button" type="button" onClick={download}>
                Download {editor} packet
              </button>
            </>
          )}
        </>
      )}
      <p className="small-text muted">
        {target === 'word' && 'The pilot requires recent desktop Word and local setup. '}
        Installation instructions are in{' '}
        <code>apps/{target === 'word' ? 'word' : 'libreoffice'}-citations</code> in the PRISM repository.
      </p>
    </form>
  );
}
