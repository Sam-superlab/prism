'use client';

import dynamic from 'next/dynamic';
import { useRef, useState } from 'react';
import { api, uuid } from '../lib/api';
import { citationKeyPattern, doiPattern, arxivReferencePattern, safeReferenceUrl } from '../lib/bibliography';
import { API_BODY_LIMIT } from '../lib/request-body';
import type { BibliographyImportResult } from '../lib/bibliography-import';
import type { ZoteroRdfImport } from '../lib/zotero-rdf-import';
import type { ZoteroReferenceMatch } from './ZoteroAttachmentImport';
import { Field, Modal, Notice } from './ui';

const ZoteroAttachmentImport = dynamic(() => import('./ZoteroAttachmentImport').then((module) => module.ZoteroAttachmentImport));

const maxBytes = 8 * 1024 * 1024;
const batchSize = 200;

type ImportReport = {
  items: ZoteroReferenceMatch[];
};
type RdfReport = ImportReport & {
  collections_created: number; collections_kept: number;
  memberships_created: number; memberships_kept: number; memberships_skipped: number;
  notes_created: number; notes_kept: number; notes_skipped: number;
  standalone_notes_created?: number; standalone_notes_kept?: number; standalone_notes_skipped?: number;
};
const emptySelection = { collections: false, notes: false, standalone: false, existing: false };

export function BibliographyImport({ onClose, onImported, userId }: { onClose: () => void; onImported: () => void; userId?: string }) {
  const [file, setFile] = useState<string>();
  const [preview, setPreview] = useState<BibliographyImportResult | ZoteroRdfImport>();
  const [metadataConfirmed, setMetadataConfirmed] = useState(false);
  const [selection, setSelection] = useState(emptySelection);
  const [structureReport, setStructureReport] = useState<RdfReport>();
  const [rdfReferences, setRdfReferences] = useState<ZoteroReferenceMatch[]>();
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [totals, setTotals] = useState({ imported: 0, skipped: 0 });
  const generation = useRef(0);
  const job = useRef<{ batch: number; batches: ReturnType<typeof makeBatches>; keys: string[]; rdfKey?: string; rdfPayload?: string } | null>(null);
  const rdf = preview && 'omitted' in preview ? preview : undefined;
  const withStructure = selection.collections || selection.notes || selection.standalone;
  const notesOnly = Boolean(rdf && !rdf.records.length);
  const omittedNotes = rdf ? rdf.omitted.noteCount - (selection.notes ? rdf.notes.length : 0) - (selection.standalone ? rdf.standaloneNotes.length : 0) : 0;

  async function readFile(selected?: File) {
    const sequence = ++generation.current;
    setFile(selected?.name);
    setError('');
    setPreview(undefined);
    setMetadataConfirmed(false);
    setSelection(emptySelection);
    setStructureReport(undefined);
    setRdfReferences(undefined);
    setTotals({ imported: 0, skipped: 0 });
    job.current = null;
    if (!selected) return;
    try {
      if (selected.size > maxBytes) throw new Error('Choose a bibliography file under 8 MB.');
      let parsed: BibliographyImportResult | ZoteroRdfImport;
      if (/\.rdf$/i.test(selected.name)) {
        const [{ parseZoteroRdf }, bytes] = await Promise.all([import('../lib/zotero-rdf-import'), selected.arrayBuffer()]);
        parsed = await parseZoteroRdf(bytes, userId ?? '');
      } else {
        const [{ parseBibliographyImport }, source] = await Promise.all([import('../lib/bibliography-import'), selected.text()]);
        const format = /\.ris$/i.test(selected.name) ? 'ris' : /\.json$/i.test(selected.name) ? 'csl-json' : undefined;
        parsed = parseBibliographyImport(source, format);
      }
      if (sequence !== generation.current) return;
      const items = buildItems(parsed);
      const batches = makeBatches(items);
      if (parsed.format === 'zotero-rdf' && batches.length > 1)
        throw new Error('This Zotero export is too large for one import. Export a smaller Zotero collection and try again.');
      if (parsed.format === 'zotero-rdf' && !batches.length) batches.push([]);
      job.current = { batch: 0, batches, keys: batches.map(() => uuid()) };
      setPreview(parsed);
    } catch (cause) {
      if (sequence === generation.current) setError(cause instanceof Error ? cause.message : 'Could not read the file.');
    }
  }

  async function save() {
    const current = job.current;
    if (!current || busy || (rdf && (!metadataConfirmed || (notesOnly && !selection.standalone)))) return;
    setBusy(true);
    setError('');
    try {
      if (rdf && withStructure) {
        const body = { file_sha256: rdf.fileHash, items: current.batches[0],
          collections: selection.collections ? rdf.collections : [], notes: selection.notes ? rdf.notes : [],
          ...(selection.standalone && { standalone_notes: rdf.standaloneNotes }), link_existing: selection.existing };
        const serialized = JSON.stringify(body);
        if (new TextEncoder().encode(serialized).byteLength > API_BODY_LIMIT)
          throw new Error('This selection is too large for one import. Choose fewer options or export a smaller Zotero collection.');
        if (current.rdfPayload !== serialized) {
          current.rdfPayload = serialized;
          current.rdfKey = uuid();
        }
        const report = await api<RdfReport>('/research/library/zotero-rdf/import', { method: 'POST', key: current.rdfKey, body });
        const imported = report.items.filter((item) => item.status === 'imported').length;
        setTotals({ imported, skipped: report.items.length - imported });
        setStructureReport(report);
        setRdfReferences(report.items);
        current.batch = current.keys.length;
      }
      while (current.batch < current.keys.length) {
        const report = await api<ImportReport>('/research/library/import', {
          method: 'POST',
          key: current.keys[current.batch],
          body: { items: current.batches[current.batch] },
        });
        const imported = report.items.filter((item) => item.status === 'imported').length;
        if (rdf) setRdfReferences(report.items);
        setTotals((previous) => ({
          imported: previous.imported + imported,
          skipped: previous.skipped + report.items.length - imported,
        }));
        current.batch++;
      }
      onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import paused. Retry to continue.');
      if (current.batch > 0) onImported();
    } finally {
      setBusy(false);
    }
  }

  const complete = Boolean(preview && job.current && job.current.batch === job.current.keys.length);
  return (
    <Modal title="Import bibliography" onClose={() => { if (!busy && !attachmentBusy) onClose(); }} wide>
      <Field label="Bibliography file" hint="Choose a BibTeX, RIS, CSL JSON, or Zotero RDF export.">
        <input
          type="file"
          accept=".bib,.bibtex,.ris,.json,.rdf,application/json,application/rdf+xml"
          disabled={busy || attachmentBusy}
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
      </Field>
      {file && !preview && !error && <p role="status">Reading {file}…</p>}
      {error && <Notice tone="error">{error}</Notice>}
      {preview && (
        <>
          <p>{notesOnly ? `${rdf!.standaloneNotes.length} stand-alone ${rdf!.standaloneNotes.length === 1 ? 'note' : 'notes'}` :
            `${preview.records.length} ${preview.records.length === 1 ? 'reference' : 'references'}`} ready from {file}.</p>
          {rdf && <>
            {rdf.attachments.length > 0 ? <p>This step imports bibliography metadata and any selected collections or notes. After saving references, you can choose from {rdf.attachments.length} supported attachments in the export folder, including PDFs, EPUBs, and HTML page text.{rdf.omitted.attachmentCount > rdf.attachments.length && ` ${rdf.omitted.attachmentCount - rdf.attachments.length} other attachments are unavailable for automatic import.`}</p> :
              <p>{notesOnly ? 'This export contains stand-alone notes.' : 'This import includes bibliography metadata.'} It will omit {selection.collections ? 0 : rdf.omitted.collectionCount} collections,{' '}
                {omittedNotes} notes and {rdf.omitted.attachmentCount} attachments.</p>}
            {rdf.attachments.length > 0 && <p>{selection.collections ? 0 : rdf.omitted.collectionCount} collections and{' '}
              {omittedNotes} notes will be omitted.</p>}
            {!!rdf.omitted.collectionNames.length && <p className="muted">Collections in export {rdf.omitted.collectionNames.join(', ')}</p>}
            <p className="muted">Reimporting the same export keeps existing records and their edits. Deleted records stay archived.</p>
            {rdf.unavailable.collections && <p>{rdf.unavailable.collections}</p>}
            {rdf.unavailable.notes && <p>{rdf.unavailable.notes}</p>}
            {!!rdf.unavailable.collectionMembers && <p>{rdf.unavailable.collectionMembers} non-bibliographic collection members will be omitted.</p>}
            {!!rdf.unavailable.notesSkipped && <p>{rdf.unavailable.notesSkipped} notes are unlinked, ambiguous, or too large to import.</p>}
            {!!rdf.unavailable.notePathsSkipped && <p>{rdf.unavailable.notePathsSkipped} note collection paths are unavailable or too large to save as tags.</p>}
            {!complete && <div className="stack">
              {!!rdf.collections.length && <label><input type="checkbox" checked={selection.collections} disabled={busy}
                onChange={(event) => { setSelection({ ...selection, collections: event.target.checked }); setMetadataConfirmed(false); }} /> Include collection hierarchy ({rdf.collections.length})</label>}
              {!!rdf.notes.length && <label><input type="checkbox" checked={selection.notes} disabled={busy}
                onChange={(event) => { setSelection({ ...selection, notes: event.target.checked }); setMetadataConfirmed(false); }} /> Include linked notes ({rdf.notes.length}) as plain text in Knowledge</label>}
              {!!rdf.standaloneNotes.length && <>
                <label><input type="checkbox" checked={selection.standalone} disabled={busy}
                  onChange={(event) => { setSelection({ ...selection, standalone: event.target.checked }); setMetadataConfirmed(false); }} /> Include stand-alone notes ({rdf.standaloneNotes.length}) as plain text in Knowledge</label>
                <details open={selection.standalone || notesOnly || undefined}>
                  <summary>Preview stand-alone notes</summary>
                  <p>Notes will appear under the Zotero notes subject. Original collection paths appear as tags.</p>
                  <ul>{rdf.standaloneNotes.map((note) => <li key={note.resource_sha256}>
                    <div>{note.title}</div>
                    {note.collection_paths.map((path, index) => <div className="muted" key={index}>{path.join(' › ')}</div>)}
                  </li>)}</ul>
                </details>
              </>}
              {!notesOnly && (selection.collections || selection.notes) && <label><input type="checkbox" checked={selection.existing} disabled={busy}
                onChange={(event) => { setSelection({ ...selection, existing: event.target.checked }); setMetadataConfirmed(false); }} /> Also link to existing references matched by identifier</label>}
              <label><input type="checkbox" checked={metadataConfirmed} disabled={busy || (notesOnly && !selection.standalone)}
                onChange={(event) => setMetadataConfirmed(event.target.checked)} /> {notesOnly ? 'Import selected notes and collections' : withStructure ? 'Import metadata and selected collections or notes' : 'Import bibliography metadata only'}</label>
            </div>}
          </>}
          {preview.warnings.length > 0 && (
            <details>
              <summary>{preview.warnings.length} import warnings</summary>
              <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>
          )}
          <ul>{preview.records.slice(0, 5).map(({ fields }, index) => <li key={index}>{fields.title}</li>)}</ul>
        </>
      )}
      {totals.imported + totals.skipped > 0 && (
        <p role="status">{totals.imported} imported · {totals.skipped} skipped as duplicates</p>
      )}
      {structureReport && (selection.collections || selection.notes) && <p>{structureReport.collections_created} collections added · {structureReport.collections_kept} kept ·{' '}
        {structureReport.memberships_created} memberships added · {structureReport.memberships_kept} kept · {structureReport.memberships_skipped} skipped ·{' '}
        {structureReport.notes_created} notes added · {structureReport.notes_kept} kept · {structureReport.notes_skipped} skipped</p>}
      {structureReport?.standalone_notes_created !== undefined && <p role="status">{structureReport.standalone_notes_created} stand-alone {structureReport.standalone_notes_created === 1 ? 'note' : 'notes'} added ·{' '}
        {structureReport.standalone_notes_kept} kept · {structureReport.standalone_notes_skipped} skipped</p>}
      {complete && rdf && !!rdf.attachments.length && rdfReferences && file && userId &&
        <ZoteroAttachmentImport rdf={rdf} rdfName={file} userId={userId} references={rdfReferences} onBusy={setAttachmentBusy} />}
      <div className="modal-footer">
        <button type="button" className="button" onClick={onClose} disabled={busy || attachmentBusy}>{complete ? 'Done' : 'Close'}</button>
        {!complete && (
          <button type="button" className="button primary" onClick={() => void save()} disabled={!preview || busy || Boolean(rdf && (!metadataConfirmed || (notesOnly && !selection.standalone)))}>
            {busy ? 'Importing…' : error && preview ? 'Retry import' : notesOnly ? 'Import notes' : 'Import references'}
          </button>
        )}
      </div>
    </Modal>
  );
}

const entryTypes: Record<string, string> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  'paper-conference': 'inproceedings',
  chapter: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  webpage: 'online',
};

function buildItems(parsed: BibliographyImportResult) {
  return parsed.records.map((record) => {
    const { fields, sourceKey, publication, creators } = record;
    const rawType = publication.entryType ?? '';
    const type = Object.hasOwn(entryTypes, rawType) ? entryTypes[rawType] : rawType;
    const container = ['inproceedings', 'incollection', 'inbook'].includes(type) ? 'booktitle' : 'journal';
    return {
      id: 'importId' in record ? record.importId : uuid(),
      ...('importSource' in record && { import_source: record.importSource }),
      ...fields,
      ...(creators && { creators }),
      tags: (publication.keywords ?? []).filter((value) => [...value].length <= 64).slice(0, 40),
      doi: fields.doi && doiPattern.test(fields.doi) ? fields.doi : null,
      arxiv_id: fields.arxiv_id && arxivReferencePattern.test(fields.arxiv_id) ? fields.arxiv_id : null,
      url: fields.url ? safeReferenceUrl(fields.url) : null,
      citation_key: sourceKey && citationKeyPattern.test(sourceKey) ? sourceKey : null,
      publication: Object.fromEntries(Object.entries({
        type: type.match(/^[a-z][a-z0-9-]{0,31}$/i)?.[0],
        [container]: publication.containerTitle,
        publisher: publication.publisher,
        address: publication.address,
        series: publication.series,
        editor: publication.editors?.join('; '),
        translator: publication.translators?.join('; '),
        edition: publication.edition,
        month: publication.month,
        note: publication.note,
        pmid: publication.pmid,
        pmcid: publication.pmcid,
        volume: publication.volume,
        number: publication.issue,
        pages: publication.pages,
        isbn: publication.isbn,
        issn: publication.issn,
        abstract: publication.abstract,
        keywords: publication.keywords?.join(', '),
      }).flatMap(([field, value]) =>
        value ? [[field, [...value].slice(0, ['abstract', 'note'].includes(field) ? 12000 : 2000).join('')]] : [],
      )),
    };
  });
}

function makeBatches(items: ReturnType<typeof buildItems>) {
  const encoder = new TextEncoder();
  const batches: (typeof items)[] = [];
  let batch: typeof items = [];
  let bytes = 16;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (batch.length === batchSize || bytes + size > API_BODY_LIMIT) {
      batches.push(batch);
      batch = [];
      bytes = 16;
    }
    batch.push(item);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
