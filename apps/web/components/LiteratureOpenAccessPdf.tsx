'use client';

import { useEffect, useRef, useState } from 'react';
import { api, uuid } from '../lib/api';
import {
  literatureAttachmentPath,
  maxLiteraturePdfBytes,
  uploadLiteratureAttachment,
  type LiteraturePdfUpload,
} from '../lib/literature-pdfs';
import { Notice } from './ui';

type Candidate = {
  provider: 'arxiv' | 'pmc';
  identifier: string;
  title: string | null;
  source_url: string;
  license: string | null;
};
const providerLabels = { arxiv: 'arXiv preprint', pmc: 'PubMed Central' };

export function LiteratureOpenAccessPdf({
  referenceId,
  disabled,
  onSaved,
}: {
  referenceId: string;
  disabled?: boolean;
  onSaved: () => void;
}) {
  const endpoint = `/research/references/${referenceId}/open-access`;
  const [items, setItems] = useState<Candidate[]>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Candidate>();
  const active = useRef<AbortController>(null);
  const upload = useRef<LiteraturePdfUpload>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setStatus('');
    setBusy(true);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not open this PDF source.');
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  function discover() {
    void run(async (signal) => {
      const result = await api<{ items: Candidate[] }>(endpoint, { signal });
      if (!signal.aborted) setItems(result.items);
    });
  }

  function attach(candidate: Candidate) {
    void run(async (signal) => {
      if (!upload.current) {
        const response = await fetch(`/api/v1${endpoint}/pdf`, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': uuid(),
            Accept: 'application/pdf',
          },
          body: JSON.stringify({ provider: candidate.provider, identifier: candidate.identifier }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error?.message ?? 'Could not download this PDF.');
        }
        if (!response.headers.get('content-type')?.startsWith('application/pdf'))
          throw new Error('The source did not return a PDF.');
        const blob = await response.blob();
        signal.throwIfAborted();
        if (!blob.size || blob.size > maxLiteraturePdfBytes)
          throw new Error('Choose a PDF no larger than 32 MiB.');
        const id = candidate.identifier.replace(/[^a-z0-9.-]/gi, '-');
        const fileName = `${candidate.provider === 'arxiv' ? 'arxiv-' : ''}${id}.pdf`;
        upload.current = {
          file: new File([blob], fileName, { type: 'application/pdf' }),
          id: uuid(),
          initKey: uuid(),
          completeKey: uuid(),
          chunkKeys: new Map(),
        };
        setPending(candidate);
        setStatus('Saving PDF…');
      }
      const job = upload.current;
      await uploadLiteratureAttachment(
        referenceId,
        job,
        (bytes) => {
          if (mounted.current) setStatus(`Saving PDF… ${Math.round((bytes / job.file.size) * 100)}%`);
        },
        'pdf',
      );
      upload.current = null;
      if (mounted.current) {
        setPending(undefined);
        setStatus('PDF saved to this reference.');
        onSaved();
      }
    });
  }

  function discard() {
    void run(async () => {
      const job = upload.current;
      if (!job) return;
      // All upload retries keep the same ID. Check ready records before removal
      // in case the completion response was lost after the server saved the file.
      const list = await api<{ items: { id: string }[] }>(`/research/references/${referenceId}/attachments`);
      const saved = list.items.some((file) => file.id === job.id);
      if (!saved)
        await api(literatureAttachmentPath(job.id), { method: 'DELETE', version: '1' }).catch(
          (cause: unknown) => {
            if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 404) return;
            throw cause;
          },
        );
      upload.current = null;
      if (mounted.current) {
        setPending(undefined);
        if (saved) onSaved();
      }
    });
  }

  return (
    <section aria-label="Open-access PDF">
      <div className="inline-actions">
        <button
          type="button"
          className="button small"
          onClick={discover}
          disabled={disabled || busy || !!pending}
        >
          Find open-access PDF
        </button>
        {busy && !pending && (
          <button type="button" className="button small" onClick={() => active.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <Notice tone="error">
          <span role="alert">{error}</span>
        </Notice>
      )}
      {items?.length === 0 && (
        <p className="small-text muted">No open-access PDF was found for this reference.</p>
      )}
      {!!items?.length && (
        <ul>
          {items.map((candidate) => (
            <li key={candidate.provider + ':' + candidate.identifier}>
              <p>
                {[
                  providerLabels[candidate.provider],
                  candidate.identifier,
                  candidate.title,
                  candidate.license,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="inline-actions">
                <a className="text-link" href={candidate.source_url} target="_blank" rel="noreferrer">
                  Open source
                </a>
                <button
                  type="button"
                  className="button small"
                  disabled={disabled || busy || !!pending}
                  onClick={() => attach(candidate)}
                >
                  Attach this PDF
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {pending && !busy && (
        <div className="inline-actions">
          <button
            type="button"
            className="button small primary"
            disabled={disabled}
            onClick={() => attach(pending)}
          >
            Resume attachment
          </button>
          <button type="button" className="button small" disabled={disabled} onClick={discard}>
            Discard attachment
          </button>
        </div>
      )}
      {(busy || status) && (
        <p className="small-text muted" role="status">
          {status || 'Checking source…'}
        </p>
      )}
    </section>
  );
}
