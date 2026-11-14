'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useResource } from '../lib/api';
import { literatureAttachmentPath } from '../lib/literature-pdfs';
import type { LiteraturePdfIndex } from '../lib/literature-pdf-index';
import { indexLiteratureText } from '../lib/literature-text-index';
import { withLiteratureIndexLock } from '../lib/literature-attachment-index';

export function LiteratureIndexButton({ id, pages }: { id: string; pages: readonly string[] }) {
  const path = `${literatureAttachmentPath(id)}/text-index`;
  const index = useResource<LiteraturePdfIndex>(path);
  const action = useAction(index.reload);
  const [progress, setProgress] = useState('');
  const active = useRef<AbortController>(null);
  useEffect(() => () => active.current?.abort(), []);
  const ready = index.data?.status === 'ready';

  async function build() {
    const controller = new AbortController();
    active.current = controller;
    const signal = controller.signal;
    try {
      const indexed = await withLiteratureIndexLock(async () => {
        await indexLiteratureText(id, pages, signal, (count, total) => setProgress(`${count}/${total}`));
        return true;
      });
      if (!indexed) throw new Error('Another attachment is being indexed. Try again after it finishes.');
    } finally {
      active.current = null;
      setProgress('');
    }
  }

  return <>
    <button className="button small" type="button" disabled={index.loading || action.busy || ready || !pages.length}
      onClick={() => void action.run(build)}>{action.busy ? progress || 'Indexing…' : ready ? 'Indexed'
        : index.data?.status === 'indexing' ? 'Resume text index' : 'Index text'}</button>
    {action.error && <span role="alert" className="small-text">{action.error}</span>}
  </>;
}
