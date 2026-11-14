'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { buildLiteratureAttachmentIndex, withLiteratureIndexLock, type LiteratureIndexCandidate } from '../lib/literature-attachment-index';
import { Notice } from './ui';

type Result = { indexed: number; existing: number; manual: number; failed: number };

export function LiteratureBulkTextIndex() {
  const active = useRef<AbortController>(null);
  const [progress, setProgress] = useState('');
  const [report, setReport] = useState<Result>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => active.current?.abort(), []);

  async function run() {
    if (active.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller;
    setError('');
    setReport(undefined);
    setBusy(true);
    setProgress('Finding attachments…');
    const result: Result = { indexed: 0, existing: 0, manual: 0, failed: 0 };
    try {
      const completed = await withLiteratureIndexLock(async () => {
        const query = new URLSearchParams({ limit: '50' });
        let cursor: string | null = null;
        do {
          if (cursor) query.set('cursor', cursor);
          const list: { items: LiteratureIndexCandidate[]; next_cursor: string | null } =
            await api(`/research/library/attachments?${query}`, { signal });
          cursor = list.next_cursor;
          for (const item of list.items) {
            signal.throwIfAborted();
            const ordinal = result.indexed + result.existing + result.manual + result.failed + 1;
            setProgress(`Checking attachment ${ordinal}…`);
            try {
              const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
              result[await buildLiteratureAttachmentIndex(item, itemSignal, (count, total) =>
                setProgress(`Attachment ${ordinal} · ${count}/${total} sections`))]++;
            } catch (cause) {
              signal.throwIfAborted();
              if (cause instanceof ApiError && [401, 403, 429, 0].includes(cause.status)) throw cause;
              result.failed++;
            }
          }
        } while (cursor);
        return true;
      });
      if (!completed) setError('Attachment indexing is already running in another workspace tab.');
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not index the library.');
    } finally {
      if (active.current === controller) {
        active.current = null;
        setReport(result);
        setBusy(false);
        setProgress('');
      }
    }
  }

  return <>
    <div className="inline-actions">
      <button className="button small" type="button" disabled={busy} onClick={() => void run()}>Index library attachments</button>
      {busy && <button className="button small" type="button" onClick={() => active.current?.abort()}>Stop indexing</button>}
    </div>
    {progress && <p className="muted small-text" role="status">{progress}</p>}
    {report && <p className="muted small-text" role="status">Indexed {report.indexed} · Already indexed {report.existing}
      {report.manual > 0 && ` · Resume in the PDF reader ${report.manual}`}
      {report.failed > 0 && ` · Could not index ${report.failed}`}
    </p>}
    {error && <Notice tone="error">{error}</Notice>}
  </>;
}
