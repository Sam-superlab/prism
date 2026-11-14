'use client';

import { useRef, useState } from 'react';
import { ApiError, api, uuid } from '../lib/api';
import { prepareLiteratureAttachment, uploadLiteratureAttachment } from '../lib/literature-pdfs';
import { matchZoteroAttachmentFolder, maxZoteroAttachmentBatch, type ZoteroAttachmentMatch } from '../lib/zotero-rdf-attachments';
import type { ZoteroRdfImport } from '../lib/zotero-rdf-import';
import { Field, Notice } from './ui';

export type ZoteroReferenceMatch = { id: string; status: 'imported' | 'skipped'; reference_id: string };
type Destination = { id: string; title: string; independent: boolean };
type CanonicalReference = { id: string; title: string; import_source?: ZoteroRdfImport['records'][number]['importSource'] };
type Resume = { id: string; digest: string; referenceId: string; savedAt: number };
const resumeLifetime = 24 * 60 * 60 * 1000;
const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function loadResume(key: string, digest: string, referenceId: string) {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return undefined;
    const resume = JSON.parse(stored) as Resume;
    if (isUuid.test(resume.id) && resume.digest === digest && resume.referenceId === referenceId &&
        typeof resume.savedAt === 'number' && Date.now() - resume.savedAt < resumeLifetime) return resume;
  } catch { /* Resuming works in memory when browser storage is unavailable. */ }
}

const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;

export function ZoteroAttachmentImport({ rdf, rdfName, userId, references, onBusy }: {
  rdf: ZoteroRdfImport;
  rdfName: string;
  userId: string;
  references: ZoteroReferenceMatch[];
  onBusy: (busy: boolean) => void;
}) {
  const [matches, setMatches] = useState<ZoteroAttachmentMatch[]>();
  const [destinations, setDestinations] = useState(new Map<string, Destination>());
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [saved, setSaved] = useState(new Set<string>());
  const [failures, setFailures] = useState(new Map<string, string>());
  const [progress, setProgress] = useState<{ id: string; bytes: number }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resumes = useRef(new Map<string, Resume>());

  function work(active: boolean) {
    setBusy(active);
    onBusy(active);
  }

  async function inspect(selection: FileList) {
    if (!selection.length || busy) return;
    setMatches(undefined);
    setSelected(new Set());
    setSaved(new Set());
    setIncludeDuplicates(false);
    setFailures(new Map());
    setError('');
    work(true);
    try {
      const result = await matchZoteroAttachmentFolder(rdf, rdfName, selection);
      const sources = new Map(rdf.records.map((record) => [record.importId, record.importSource]));
      const imported = new Map(references.map((reference) => [reference.id, reference]));
      const found = new Map<string, Destination>();
      const canonical = new Map<string, CanonicalReference>();
      const ids = new Set(result.filter((entry) => entry.file).map((entry) => entry.referenceId));
      for (const id of ids) {
        const report = imported.get(id);
        if (!report) continue;
        const reference = canonical.get(report.reference_id) ?? await api<CanonicalReference>(
          `/research/references/${report.reference_id}`,
        ).catch((cause) => { if (!(cause instanceof ApiError) || cause.status !== 404) throw cause; });
        if (!reference) continue;
        canonical.set(report.reference_id, reference);
        const source = sources.get(id);
        const independent = reference.id !== id || reference.import_source?.format !== 'zotero-rdf' ||
          reference.import_source.file_sha256 !== source?.file_sha256 || reference.import_source.resource_sha256 !== source?.resource_sha256;
        found.set(id, { id: reference.id, title: reference.title, independent });
      }
      setDestinations(found);
      setMatches(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not inspect this export folder.');
    } finally { work(false); }
  }

  const queue = matches?.filter((match) => match.file && selected.has(match.id) && !saved.has(match.id)) ?? [];
  const selectedBytes = queue.reduce((size, entry) => size + (entry.file?.size ?? 0), 0);

  async function save() {
    if (busy || !queue.length || selectedBytes > maxZoteroAttachmentBatch) return;
    work(true);
    setError('');
    const done = new Set(saved);
    const errors = new Map(failures);
    try {
      for (const match of queue) {
        const destination = destinations.get(match.referenceId);
        if (!match.file || !destination || (destination.independent && !includeDuplicates)) continue;
        const key = `prism.zotero-upload.v1.${userId}.${rdf.fileHash}.${match.id}`;
        const remember = (resume?: Resume) => {
          if (resume) resumes.current.set(key, resume); else resumes.current.delete(key);
          try {
            if (resume) localStorage.setItem(key, JSON.stringify(resume)); else localStorage.removeItem(key);
          } catch { /* The current dialog can still retry. */ }
        };
        try {
          setProgress({ id: match.id, bytes: 0 });
          const digest = await prepareLiteratureAttachment(match.file, match.format);
          const memory = resumes.current.get(key);
          const previous = memory?.digest === digest && memory.referenceId === destination.id ? memory : loadResume(key, digest, destination.id);
          const resume = { id: previous?.id ?? uuid(), digest, referenceId: destination.id, savedAt: Date.now() };
          remember(resume);
          await uploadLiteratureAttachment(destination.id, { id: resume.id, file: match.file, digest,
            initKey: uuid(), completeKey: uuid(), chunkKeys: new Map() }, (bytes) => setProgress({ id: match.id, bytes }), match.format);
          remember();
          done.add(match.id);
          errors.delete(match.id);
        } catch (cause) {
          const unavailable = cause instanceof ApiError && (cause.status === 410 || cause.message === 'This upload ID is already in use. Start a new upload.');
          if (unavailable) remember();
          errors.set(match.id, unavailable ? 'The earlier upload is unavailable. Retry to start a new copy.' :
            cause instanceof Error ? cause.message : 'Could not copy this attachment.');
          if (cause instanceof ApiError && (cause.status === 0 || cause.status === 429 || cause.status >= 500)) break;
        }
        setSaved(new Set(done));
        setFailures(new Map(errors));
      }
    } finally {
      setSaved(done);
      setFailures(errors);
      setProgress(undefined);
      work(false);
    }
  }

  return <section className="stack" aria-label="Zotero export attachments">
    <Field label="Zotero export folder" hint="Choose the folder containing this RDF export and its files folder. PRISM previews matched PDFs, EPUBs, and HTML page text before copying your selection.">
      <input type="file" ref={(input) => { input?.setAttribute('webkitdirectory', ''); }} disabled={busy}
        onChange={(event) => {
          const input = event.currentTarget;
          if (input.files?.length) void inspect(input.files).finally(() => { input.value = ''; });
        }} />
    </Field>
    {error && <Notice tone="error">{error}</Notice>}
    {matches && <>
      {destinations.size > 0 && [...destinations.values()].some((destination) => destination.independent) &&
        <label><input type="checkbox" disabled={busy} checked={includeDuplicates}
          onChange={(event) => {
            setIncludeDuplicates(event.target.checked);
            if (!event.target.checked) setSelected(new Set(matches.filter((entry) => !destinations.get(entry.referenceId)?.independent && selected.has(entry.id)).map((entry) => entry.id)));
          }} /> Allow attachments on existing references matched by identifier</label>}
      <ul>
        {matches.map((match) => {
          const destination = destinations.get(match.referenceId);
          const sourceTitle = rdf.records.find((record) => record.importId === match.referenceId)?.fields.title;
          const ready = saved.has(match.id);
          return <li key={match.id}>
            <label><input type="checkbox" disabled={busy || !match.file || !destination || ready || (destination.independent && !includeDuplicates)}
              checked={selected.has(match.id) || ready} onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(match.id); else next.delete(match.id);
                setSelected(next);
              }} /> {match.snapshot ? match.fileName : match.file?.name ?? match.fileName} → {destination?.title ?? sourceTitle}</label>
            {match.file && <span className="muted"> · {fileSize(match.file.size)}</span>}
            {match.snapshot && <details>
              <summary>Preview page text{match.snapshot.truncated ? ' (truncated)' : ''}</summary>
              {match.snapshot.title && <p>{match.snapshot.title}</p>}
              <p>{match.snapshot.excerpt}</p>
              <p className="muted">Saves as {match.file?.name}. Page layout, images, and other assets are omitted.</p>
            </details>}
            {destination?.independent && <span className="muted"> · Existing reference</span>}
            {ready && <span> · Saved</span>}
            {(match.reason || (match.file && !destination)) && <span className="muted"> · {match.reason ?? 'Reference no longer available.'}</span>}
            {failures.has(match.id) && <div role="status">{failures.get(match.id)}</div>}
            {progress?.id === match.id && match.file && <progress aria-label={`Copying ${match.file.name}`} max={match.file.size} value={progress.bytes} />}
          </li>;
        })}
      </ul>
      {!!saved.size && <p role="status">{saved.size} {saved.size === 1 ? 'attachment' : 'attachments'} saved</p>}
      {selectedBytes > maxZoteroAttachmentBatch && <p>Choose files totaling at most 128 MiB per batch.</p>}
      <button type="button" className="button primary" disabled={busy || !queue.length || selectedBytes > maxZoteroAttachmentBatch}
        onClick={() => void save()}>{progress ? 'Copying attachments…' : failures.size ? 'Retry selected attachments' : 'Copy selected attachments'}</button>
    </>}
  </section>;
}
