'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, useAction, useResource, uuid } from '../lib/api';
import { literaturePdfHref } from '../lib/literature-pdf-notes';
import {
  literatureAttachmentDownload, literatureAttachmentExtension, literatureAttachmentLabel,
  literatureAttachmentPath, maxLiteraturePdfBytes, uploadLiteratureAttachment,
  type LiteratureAttachment, type LiteratureAttachmentFormat, type LiteraturePdfUpload,
} from '../lib/literature-pdfs';
import { ErrorState, Field, Icon, Loading, Modal, Notice } from './ui';
import styles from './ResearchReferences.module.css';

const LiteraturePdfAnnotations = dynamic(() => import('./LiteraturePdfAnnotations').then((module) => module.LiteraturePdfAnnotations),
  { loading: Loading, ssr: false });
const LiteratureEpubReader = dynamic(() => import('./LiteratureEpubReader').then((module) => module.LiteratureEpubReader),
  { loading: Loading, ssr: false });
const LiteratureWebpageReader = dynamic(() => import('./LiteratureWebpageReader').then((module) => module.LiteratureWebpageReader),
  { loading: Loading, ssr: false });
const LiteratureAttachmentExport = dynamic(() => import('./LiteratureAttachmentExport').then((module) => module.LiteratureAttachmentExport),
  { ssr: false });
const LiteratureOpenAccessPdf = dynamic(() => import('./LiteratureOpenAccessPdf').then((module) => module.LiteratureOpenAccessPdf),
  { ssr: false });

function webDavAttachmentBridge() {
  const host = window as Window & { webkit?: { messageHandlers?: { prismWebDAVAttachment?: {
    postMessage: (attachment: { referenceId: string; attachmentId: string }) => void;
  } } } };
  return host.webkit?.messageHandlers?.prismWebDAVAttachment;
}

export function LiteraturePdfAttachments({ referenceId, title, openPdfId, openPage, openAnnotationId, onClose, inline, embedded }: {
  referenceId: string;
  title: string;
  openPdfId?: string;
  openPage?: number;
  openAnnotationId?: string;
  onClose?: () => void;
  inline?: boolean;
  embedded?: boolean;
}) {
  const list = useResource<{ items: LiteratureAttachment[] }>(`/research/references/${referenceId}/attachments`);
  const [reading, setReading] = useState<LiteratureAttachment>();
  const [remove, setRemove] = useState<LiteratureAttachment>();
  const [renaming, setRenaming] = useState<LiteratureAttachment>();
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<File>();
  const format: LiteratureAttachmentFormat = /\.epub$/i.test(selection?.name ?? '') ? 'epub' : 'pdf';
  const [progress, setProgress] = useState(0);
  const [webDav, setWebDav] = useState(false);
  const upload = useRef<LiteraturePdfUpload>(null);
  const picker = useRef<HTMLInputElement>(null);
  const action = useAction(list.reload);
  const autoOpened = useRef(false);
  useEffect(() => { setWebDav(!!webDavAttachmentBridge()); }, []);
  useEffect(() => {
    if (!openPdfId || !list.data || autoOpened.current) return;
    autoOpened.current = true;
    setReading(list.data.items.find((file) => file.id === openPdfId));
  }, [openPdfId, list.data]);
  async function discardUpload() {
    const current = upload.current;
    if (!current) return;
    try {
      await api(literatureAttachmentPath(current.id), { method: 'DELETE', version: '1' });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
    }
    upload.current = null;
    setSelection(undefined);
    setProgress(0);
    if (picker.current) picker.current.value = '';
  }

  const readingClose = () => openPdfId ? onClose?.() : setReading(undefined);
  if (reading?.format === 'epub') return <LiteratureEpubReader file={reading} onClose={readingClose}
    startChapter={reading.id === openPdfId ? openPage : undefined} annotationId={reading.id === openPdfId ? openAnnotationId : undefined} inline={inline} />;
  if (reading?.format === 'webpage') return <LiteratureWebpageReader file={reading} onClose={readingClose}
    startParagraph={reading.id === openPdfId ? openPage : undefined} annotationId={reading.id === openPdfId ? openAnnotationId : undefined} inline={inline} />;
  if (reading) return <LiteraturePdfAnnotations file={reading} referenceTitle={title}
    startPage={reading.id === openPdfId ? openPage : undefined}
    annotationId={reading.id === openPdfId ? openAnnotationId : undefined}
    onClose={readingClose} inline={inline} />;
  const removal = remove && (
    <Modal title={`Remove ${literatureAttachmentLabel[remove.format]}`} onClose={() => { if (!action.busy) setRemove(undefined); }}>
      <p>Remove “{remove.file_name}” from this reference?</p>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <div className="modal-footer">
        <button className="button" type="button" disabled={action.busy} onClick={() => setRemove(undefined)}>Cancel</button>
        <button className="button primary" type="button" disabled={action.busy} onClick={() => {
          void action.run(async () => {
            await api(literatureAttachmentPath(remove.id), { method: 'DELETE', version: remove.version });
            setRemove(undefined);
          });
        }}>Remove {literatureAttachmentLabel[remove.format]}</button>
      </div>
    </Modal>
  );
  const attachmentList = <>
      {!!list.data?.items.length && <LiteratureAttachmentExport referenceId={referenceId} attachments={list.data.items}
        disabled={action.busy} />}
      <ErrorState error={list.error} retry={list.reload} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {list.loading && <Loading />}
      {!list.loading && !list.error && list.data?.items.length === 0 && <p className="muted">No attachments.</p>}
      <ul className={`${styles.rows}${embedded ? ` ${styles.inspectorFiles}` : ''}`}>
        {list.data?.items.map((item) => (
          <li className={styles.row} key={item.id}>
            {renaming?.id === item.id ? (
              <form
                className={styles.renamePdfForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = String(new FormData(event.currentTarget).get('file_name') ?? '').trim();
                  if (!name || action.busy) return;
                  const extension = `.${literatureAttachmentExtension[item.format]}`;
                  const fileName = name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
                  void action.run(async () => {
                    const updated = await api<LiteratureAttachment>(literatureAttachmentPath(item.id), {
                      method: 'PATCH', version: renaming.version, body: { file_name: fileName },
                    });
                    list.setData((current) => current && {
                      items: current.items.map((file) => file.id === updated.id ? updated : file),
                    });
                    setRenaming(undefined);
                  });
                }}
              >
                <Field label="Attachment filename">
                  <input name="file_name" defaultValue={renaming.file_name} required maxLength={200}
                    disabled={action.busy} autoFocus />
                </Field>
                <div className={styles.inlineActions}>
                  <button className="button small" type="button" disabled={action.busy}
                    onClick={() => { action.setError(null); setRenaming(undefined); }}>Cancel</button>
                  <button className="button small primary" type="submit" disabled={action.busy}>Save name</button>
                </div>
              </form>
            ) : (
              <>
                <div>
                  <button className={`text-link ${styles.rowTitle}`} type="button" onClick={() => setReading(item)} disabled={action.busy}>
                    {item.file_name}
                  </button>
                  <span className={`muted small-text ${styles.rowMeta}`}>{formatPdfSize(item.size_bytes)}</span>
                </div>
                <div className={styles.inlineActions}>
                  {webDav && item.status === 'ready' && <button className="button small" type="button" disabled={action.busy}
                    aria-label={`WebDAV copy for ${item.file_name}`} onClick={() =>
                      webDavAttachmentBridge()?.postMessage({ referenceId: item.reference_id, attachmentId: item.id })}>WebDAV…</button>}
                  <Link className="button small" aria-label={`Open ${item.file_name} in a workspace tab`}
                    prefetch={false} data-workspace-tab={item.file_name}
                    href={`${literaturePdfHref(item.reference_id, item.id)}&view=reader`}>Open in tab</Link>
                  <a className="button small" href={literatureAttachmentDownload(item.id)} download={item.file_name}>Download</a>
                  <button className="icon-button" type="button" disabled={action.busy}
                    aria-label={`Rename ${item.file_name}`} onClick={() => { action.setError(null); setRenaming(item); }}>
                    <Icon name="edit" size={15} />
                  </button>
                  <button className="icon-button" type="button" disabled={action.busy}
                    aria-label={`Remove ${item.file_name}`} onClick={() => { action.setError(null); setRemove(item); }}>
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
  </>;
  const findOpenAccess = !inline && <LiteratureOpenAccessPdf referenceId={referenceId}
    disabled={action.busy || !!upload.current} onSaved={list.reload} />;
  const uploadForm = <>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!selection || action.busy) return;
        upload.current ??= {
          id: uuid(), initKey: uuid(), completeKey: uuid(), chunkKeys: new Map(), file: selection,
        };
        const current = upload.current;
        void action.run(async () => {
          await uploadLiteratureAttachment(referenceId, current, setProgress, format);
          upload.current = null;
          setSelection(undefined);
          setProgress(0);
          if (picker.current) picker.current.value = '';
          setAdding(false);
        });
      }}>
        <Field label="Choose a PDF or EPUB" hint="Up to 32 MiB per file.">
          <input ref={picker} type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" disabled={action.busy || !!upload.current}
            onChange={(event) => {
              action.setError(null);
              const file = event.currentTarget.files?.[0];
              setProgress(0);
              if (file && (file.size > maxLiteraturePdfBytes || !/\.(?:pdf|epub)$/i.test(file.name))) {
                action.setError('Choose a PDF or EPUB no larger than 32 MiB.');
                event.currentTarget.value = '';
                setSelection(undefined);
                return;
              }
              setSelection(file);
            }} />
        </Field>
        {action.busy && selection && <progress aria-label="Attachment upload progress" max={selection.size || 1} value={progress} />}
        <div className="modal-footer">
          {upload.current && !action.busy && (
            <button className="button" type="button" onClick={() => void action.run(discardUpload)}>Discard upload</button>
          )}
          <button className="button primary" type="submit" disabled={!selection || action.busy}>
            {action.busy ? 'Saving…' : upload.current ? 'Retry upload' : 'Attach file'}
          </button>
        </div>
      </form>
  </>;
  if (embedded) return (
    <section className={styles.inspectorSection} aria-label="Attachments">
      <div className={styles.inspectorSectionHeader}>
        <h3>Attachments</h3>
        <button type="button" className="button small" onClick={() => { action.setError(null); setAdding(true); }}>
          <Icon name="plus" size={14} /> Add attachment
        </button>
      </div>
      {attachmentList}
      {findOpenAccess}
      {removal}
      {adding && <Modal title="Add attachment" onClose={() => {
        if (action.busy || upload.current) return;
        setAdding(false);
        setSelection(undefined);
        setProgress(0);
        action.setError(null);
      }} dismissOnBackdrop={false}>
        {action.error && <Notice tone="error">{action.error}</Notice>}
        {uploadForm}
      </Modal>}
    </section>
  );
  if (removal) return removal;
  return (
    <Modal title="Attachments" onClose={() => { if (!action.busy) onClose?.(); }} wide inline={inline}>
      <p>{title}</p>
      {findOpenAccess}
      {attachmentList}
      {uploadForm}
    </Modal>
  );
}

function formatPdfSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
