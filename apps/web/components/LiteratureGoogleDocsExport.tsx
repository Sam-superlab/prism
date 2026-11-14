'use client';

import { useEffect, useRef, useState } from 'react';
import type { BibliographyItem } from '../lib/bibliography';
import type { buildGoogleDocsCitationPacket } from '../lib/literature-google-docs';
import { Field, Notice } from './ui';

export function LiteratureGoogleDocsExport({
  load,
}: {
  load: (signal: AbortSignal) => Promise<readonly BibliographyItem[]>;
}) {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<ReturnType<typeof buildGoogleDocsCitationPacket>>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
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
    if (active.current || !source.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus('');
    setError('');
    setResult(undefined);
    try {
      const [module, items] = await Promise.all([
        import('../lib/literature-google-docs'),
        load(controller.signal),
      ]);
      controller.signal.throwIfAborted();
      setResult(module.buildGoogleDocsCitationPacket(source, items));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Could not prepare this citation packet.');
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  async function copy() {
    if (!result?.count) return;
    try {
      await navigator.clipboard.writeText(result.packet);
      setStatus('Citation packet copied.');
    } catch {
      setStatus('Select the packet text to copy it.');
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
        Prepare a citation packet for the PRISM script in Google Docs. The packet contains only matched keys,
        page locators, and formatted references.
      </p>
      <Field label="Citation markers" hint="Use [[cite:reference-key]] or [[cite:reference-key|12–14]].">
        <textarea
          value={source}
          rows={6}
          maxLength={20_000}
          required
          disabled={busy}
          onChange={(event) => {
            setSource(event.target.value);
            setResult(undefined);
            setStatus('');
            setError('');
          }}
        />
      </Field>
      <button className="button primary" type="submit" disabled={busy || !source.trim()}>
        {busy ? 'Resolving citations…' : 'Prepare citation packet'}
      </button>
      {busy && (
        <button className="button" type="button" onClick={() => active.current?.abort()}>
          Cancel preparation
        </button>
      )}
      {error && (
        <Notice tone="error">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {result && (
        <>
          <p role="status">
            {result.count} {result.count === 1 ? 'marker' : 'markers'} matched.
          </p>
          {!!result.missing.length && <Notice tone="error">Missing keys: {result.missing.join(', ')}</Notice>}
          {!!result.ambiguous.length && (
            <Notice tone="error">Ambiguous keys: {result.ambiguous.join(', ')}</Notice>
          )}
          {!!result.count && (
            <>
              <Field label="Citation packet">
                <textarea readOnly rows={4} value={result.packet} />
              </Field>
              <button className="button" type="button" onClick={() => void copy()}>
                Copy citation packet
              </button>
            </>
          )}
        </>
      )}
      {status && <p role="status">{status}</p>}
      <p className="small-text muted">
        Install the bound script from the <code>apps/google-docs-citations</code> folder in the PRISM
        repository.
      </p>
    </form>
  );
}
