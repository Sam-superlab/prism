import { maxLiteraturePdfBytes } from './literature-pdfs';
import { extractLiteratureHtmlSnapshot, maxSnapshotHtmlBytes } from './literature-html-snapshot';
import type { ZoteroRdfImport } from './zotero-rdf-import';

const maxFolderFiles = 2000;
const maxRdfBytes = 8 * 1024 * 1024;
export const maxZoteroAttachmentBatch = 128 * 1024 * 1024;

export type ZoteroAttachmentMatch = ZoteroRdfImport['attachments'][number] & (
  { file: File; snapshot?: { title: string; excerpt: string; truncated: boolean }; reason?: never } |
  { file?: never; snapshot?: never; reason: string }
);

async function sha256(file: File) {
  const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function matchZoteroAttachmentFolder(rdf: ZoteroRdfImport, rdfName: string, selection: FileList) {
  if (!selection.length || selection.length > maxFolderFiles) throw new Error('Choose a Zotero export folder containing at most 2,000 files.');
  const files = Array.from(selection);
  const root = files[0].webkitRelativePath.split('/')[0];
  if (!root || files.some((file) => !file.webkitRelativePath.startsWith(`${root}/`)))
    throw new Error('Choose the export folder containing the RDF file and its files folder.');
  const rdfMatches = files.filter((file) => file.webkitRelativePath.normalize('NFC') === `${root}/${rdfName}`.normalize('NFC'));
  const rdfFile = rdfMatches.length === 1 ? rdfMatches[0] : undefined;
  if (!rdfFile || !rdfFile.size || rdfFile.size > maxRdfBytes || await sha256(rdfFile) !== rdf.fileHash)
    throw new Error('This folder does not contain the same Zotero RDF file. Choose the original export folder.');

  const byPath = new Map<string, File[]>();
  for (const file of files) {
    const relative = file.webkitRelativePath.slice(root.length + 1).normalize('NFC');
    if (!/^files\/[1-9][0-9]{0,15}\/[^/\\\u0000-\u001f\u007f]+$/u.test(relative)) continue;
    const matches = byPath.get(relative) ?? [];
    matches.push(file);
    byPath.set(relative, matches);
  }
  const paths = new Map<string, Set<string>>();
  for (const entry of rdf.attachments) {
    for (const path of entry.paths) {
      const key = path.normalize('NFC');
      const references = paths.get(key) ?? new Set<string>();
      references.add(entry.id);
      paths.set(key, references);
    }
  }
  const result: ZoteroAttachmentMatch[] = [];
  for (const entry of rdf.attachments) {
    const matched = new Set<File>();
    let conflicting = false;
    for (const path of entry.paths) {
      const key = path.normalize('NFC');
      if ((paths.get(key)?.size ?? 0) > 1) conflicting = true;
      for (const file of byPath.get(key) ?? []) matched.add(file);
    }
    const file = matched.values().next().value;
    const html = entry.format === 'webpage';
    const reason = conflicting ? 'More than one attachment claims this path.' :
      matched.size > 1 ? 'More than one file matches this attachment.' :
        !file ? 'File missing from the selected folder.' :
          !file.size || file.size > (html ? maxSnapshotHtmlBytes : maxLiteraturePdfBytes) ? `File is empty or exceeds ${html ? 8 : 32} MiB.` :
            [...file.name].length > 200 ? 'Filename is too long.' : undefined;
    if (reason || !file) {
      result.push({ ...entry, reason: reason ?? 'File missing from the selected folder.' });
    } else if (html) {
      try {
        const { file: text, ...snapshot } = await extractLiteratureHtmlSnapshot(file);
        result.push({ ...entry, fileName: file.name, file: text, snapshot });
      } catch (cause) {
        result.push({ ...entry, reason: cause instanceof Error ? cause.message : 'Could not extract page text.' });
      }
    } else {
      result.push({ ...entry, file });
    }
  }
  return result;
}
