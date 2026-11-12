'use client';

import { useEffect, useRef, useState } from 'react';
import type { Knowledge } from '../lib/types';
import { Modal } from './ui';

type ExportItem = Pick<Knowledge, 'title' | 'subject' | 'content' | 'proof_content' | 'source_reference'>;
type MarkdownFile = { filename: string; text: string };

function headingText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_\[\]<>#]/g, '\\$&');
}

function buildMarkdown(items: readonly ExportItem[], title: string, includeProofs: boolean): MarkdownFile {
  const single = items.length === 1;
  const name = single ? items[0].title : title;
  const sections = single ? [] : [`# ${headingText(name)}`];

  for (const item of items) {
    sections.push(`${single ? '#' : '##'} ${headingText(item.title)}`);
    if (item.subject) sections.push(`Subject: ${headingText(item.subject)}`);
    sections.push(item.content);
    if (includeProofs && item.proof_content) {
      sections.push(`${single ? '##' : '###'} Proof / Explanation`, item.proof_content);
    }
    if (item.source_reference) sections.push(`Source: ${item.source_reference}`);
  }

  const cleanName = name
    .replace(/\s+/g, ' ')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .trim();
  const basename =
    Array.from(cleanName)
      .slice(0, 60)
      .join('')
      .replace(/[. ]+$/, '') || 'PRISM Knowledge';
  return { filename: `${basename}.md`, text: sections.join('\n\n') + '\n' };
}

export function KnowledgeMarkdownActions({
  items,
  title = 'PRISM Knowledge',
  includeProofs = true,
  disabled = false,
}: {
  items: readonly ExportItem[];
  title?: string;
  includeProofs?: boolean;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<MarkdownFile | null>(null);
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={disabled || !items.length}
        onClick={() => setFile(buildMarkdown(items, title, includeProofs))}
      >
        Export Markdown
      </button>
      {file && <MarkdownDialog file={file} onClose={() => setFile(null)} />}
    </>
  );
}

function MarkdownDialog({ file, onClose }: { file: MarkdownFile; onClose: () => void }) {
  const [downloadUrl, setDownloadUrl] = useState('');
  const [status, setStatus] = useState('');
  const source = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/markdown;charset=utf-8' }));
    const onDownload = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail;
      if (typeof message === 'string') setStatus(message);
    };
    setDownloadUrl(url);
    window.addEventListener('prism-markdown-download', onDownload);
    return () => {
      URL.revokeObjectURL(url);
      window.removeEventListener('prism-markdown-download', onDownload);
    };
  }, [file.text]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(file.text);
      setStatus('Markdown copied.');
    } catch {
      source.current?.focus();
      source.current?.select();
      setStatus('Markdown selected. Press Command+C or Ctrl+C to copy.');
    }
  }

  return (
    <Modal title="Export Markdown" onClose={onClose} wide>
      <p className="modal-description">Download the editable source or copy it to your clipboard.</p>
      <textarea
        ref={source}
        className="code-editor"
        aria-label="Markdown source"
        readOnly
        rows={12}
        value={file.text}
      />
      <p className="small-text muted" role="status">
        {status}
      </p>
      <div className="modal-footer">
        <button className="button" type="button" onClick={() => void copy()}>
          Copy Markdown
        </button>
        {downloadUrl && (
          <a className="button primary" href={downloadUrl} download={file.filename}>
            Download Markdown
          </a>
        )}
      </div>
    </Modal>
  );
}
