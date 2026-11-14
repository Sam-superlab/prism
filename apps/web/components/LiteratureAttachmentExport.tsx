'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiteratureAttachment } from '../lib/literature-pdfs';
import { Notice } from './ui';

export function LiteratureAttachmentExport({
  referenceId,
  attachments,
  disabled,
}: {
  referenceId: string;
  attachments: readonly LiteratureAttachment[];
  disabled?: boolean;
}) {
  return (
    <AttachmentDownload
      key={referenceId}
      referenceId={referenceId}
      attachments={attachments}
      disabled={disabled}
    />
  );
}

function AttachmentDownload({
  referenceId,
  attachments,
  disabled,
}: Parameters<typeof LiteratureAttachmentExport>[0]) {
  const [progress, setProgress] = useState<{ completed: number; total: number }>();
  const [error, setError] = useState('');
  const active = useRef<AbortController>(null);

  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  async function download() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setProgress({ completed: 0, total: attachments.filter((file) => file.status === 'ready').length });
    try {
      const { exportLiteratureAttachments } = await import('../lib/literature-attachment-export');
      const archive = await exportLiteratureAttachments(referenceId, attachments, {
        signal: controller.signal,
        onProgress: (completed, total) => setProgress({ completed, total }),
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'prism-attachments.zip';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        // Give desktop download handlers time to read the Blob after the click.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Could not export these attachments.');
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress(undefined);
      }
    }
  }

  if (!attachments.some((file) => file.status === 'ready') && !progress) return null;
  return (
    <div className="inline-actions">
      <button
        type="button"
        className="button small"
        disabled={disabled || !!progress}
        onClick={() => void download()}
      >
        Download attachments ZIP
      </button>
      {progress && (
        <>
          <progress
            aria-label="Attachment archive progress"
            value={progress.completed}
            max={Math.max(1, progress.total)}
          />
          <span className="small-text muted">
            {progress.completed}/{progress.total} files
          </span>
          <button type="button" className="button small" onClick={() => active.current?.abort()}>
            Cancel download
          </button>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
