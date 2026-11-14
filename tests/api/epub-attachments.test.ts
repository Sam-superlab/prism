import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { validateApiResponse } from '../../apps/api/src/contract';
import { loadConfig } from '../../apps/api/src/config';
import { createDatabase } from '../../packages/database/src/index';
import { createTestPostgres } from '../../apps/api/src/testing';

function epubContainer() {
  // Tiny stored ZIP fixture with a mimetype, package document and one XHTML chapter.
  const files = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['content.opf', '<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="fixture"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture</dc:title><dc:identifier id="fixture">urn:prism:test</dc:identifier><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-13T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>'],
    ['chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title></head><body><p>Chapter text.</p></body></html>'],
  ];
  let offset = 0;
  const local: Buffer[] = [], central: Buffer[] = [];
  for (const [name, content] of files) {
    const filename = Buffer.from(name), bytes = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const entry = Buffer.alloc(30), directory = Buffer.alloc(46);
    entry.writeUInt32LE(0x04034b50); entry.writeUInt16LE(20, 4);
    entry.writeUInt32LE((~crc) >>> 0, 14); entry.writeUInt32LE(bytes.length, 18);
    entry.writeUInt32LE(bytes.length, 22); entry.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE((~crc) >>> 0, 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(entry, filename, bytes);
    central.push(directory, filename);
    offset += entry.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

it('stores EPUB and text snapshots through neutral routes while legacy PDF actions remain format-specific', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'prism-epub-test-'));
  const pg = process.env.PRISM_API_TEST_POSTGRES === '1' ? await createTestPostgres(process.env.PRISM_TEST_POSTGRES_CONFIG) : undefined;
  const db = pg?.db ?? await createDatabase({ memory: true });
  const config = loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DATA_DIR: dataDir });
  const app = await buildApp({ db, config });
  async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: unknown, version?: string, key = randomUUID()) {
    const result = await app.inject({
      method, url: '/api/v1' + path,
      headers: { 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) },
      payload: payload as Record<string, unknown>,
    });
    if (result.headers['content-type']?.includes('application/json'))
      expect(await validateApiResponse(method, path, result.statusCode, result.json())).toEqual([]);
    return result;
  }
  try {
    const referenceId = randomUUID(), epubId = randomUUID(), invalidId = randomUUID();
    expect((await call('POST', '/research/references', { id: referenceId, title: 'EPUB fixture' })).statusCode).toBe(201);
    const list = `/research/references/${referenceId}/attachments`;
    const legacyList = `/research/references/${referenceId}/pdfs`;
    const bytes = epubContainer();
    const upload = (id: string, data: Buffer, format: string, file_name: string) => call('POST', list, {
      id, format, file_name, size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect((await upload(epubId, bytes, 'epub', 'Book.epub')).json()).toMatchObject({
      id: epubId, format: 'epub', status: 'uploading', next_offset: 0,
    });
    const epub = `/research/attachments/${epubId}`;
    const legacy = `/research/reference-pdfs/${epubId}`;
    expect((await call('GET', list)).json().items).toEqual([]);
    expect((await call('GET', epub + '/download')).statusCode).toBe(404);
    expect((await call('GET', epub + '/text-index')).statusCode).toBe(404);
    expect((await call('PUT', legacy + '/chunk', { offset: 0, data: bytes.toString('base64') })).statusCode).toBe(404);
    expect((await call('PUT', epub + '/chunk', { offset: 0, data: bytes.toString('base64') })).json().next_offset).toBe(bytes.length);
    expect((await call('POST', legacy + '/complete', {})).statusCode).toBe(404);
    expect((await call('POST', epub + '/complete', {})).json()).toMatchObject({
      id: epubId, format: 'epub', status: 'ready', next_offset: bytes.length,
    });
    const manifest = await call('GET', '/research/library/attachments?limit=1');
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['cache-control']).toBe('private, no-store');
    expect(manifest.json()).toEqual({ items: [{ id: epubId, reference_id: referenceId, format: 'epub',
      size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], next_cursor: null });
    expect(await validateApiResponse('GET', '/research/library/attachments', manifest.statusCode, manifest.json())).toEqual([]);
    expect((await call('GET', list)).json().items).toHaveLength(1);
    expect((await call('GET', legacyList)).json().items).toEqual([]);
    expect((await call('GET', legacy + '/download')).statusCode).toBe(404);
    expect((await call('GET', legacy + '/reading-position')).statusCode).toBe(404);
    expect((await call('GET', epub + '/reading-position')).json()).toEqual({ position: null });
    const position = await call('PUT', epub + '/reading-position', { page: 2, expected_version: null });
    expect(position.json()).toMatchObject({ position: { page: 2, pdf_id: epubId, version: '1' } });
    expect((await call('GET', epub + '/reading-position')).json()).toEqual(position.json());
    expect((await call('PUT', epub + '/reading-position', { page: 1, expected_version: null })).statusCode).toBe(412);
    expect((await call('GET', legacy + '/text-index')).statusCode).toBe(404);
    expect((await call('POST', legacy + '/text-index', { index_id: randomUUID(), page_count: 1 })).statusCode).toBe(404);
    const index = (attachment: string) => attachment + '/text-index';
    const fullText = '/research/library/full-text';
    const addIndex = async (attachment: string, pages: string[]) => {
      const path = index(attachment), indexId = randomUUID();
      expect((await call('POST', path, { index_id: indexId, page_count: pages.length })).json()).toMatchObject({
        index_id: indexId, status: 'indexing', next_page: 1,
      });
      expect((await call('PUT', path + '/pages', { index_id: indexId, start_page: 1, pages })).json()).toEqual({
        next_page: pages.length + 1,
      });
      expect((await call('GET', fullText + '?q=résumé')).json().items).toEqual([]);
      expect((await call('POST', path + '/complete', { index_id: indexId })).json()).toMatchObject({ status: 'ready' });
      return indexId;
    };
    expect((await call('GET', index(epub))).json()).toMatchObject({ status: 'missing' });
    expect((await call('POST', index(epub), { index_id: randomUUID(), page_count: 1, text_mode: 'local-ocr' })).statusCode).toBe(422);
    const epubIndex = await addIndex(epub, ['An introduction.', 'The chapter includes the Résumé.']);
    expect((await call('GET', index(epub))).json()).toMatchObject({ index_id: epubIndex, status: 'ready', page_count: 2 });
    expect((await call('GET', fullText + '?q=resume')).json().items).toEqual([
      expect.objectContaining({
        format: 'epub', pdf_id: epubId, reference_id: referenceId, kind: 'page',
        page: 2, annotation_id: null, snippet: expect.stringContaining('Résumé'),
      }),
    ]);
    const annotations = '/research/text-annotations';
    const epubAnnotations = epub + '/text-annotations';
    const annotationId = randomUUID();
    const create = { id: annotationId, anchor: { section: 1, section_key: 'chapter:0', block: 1, start: 0, end: 7, quote: 'Chapter' },
      comment: 'A synthetic bookmark', tags: ['  Proof ', 'PROOF'], color: 'green' };
    const key = randomUUID();
    expect((await call('POST', epubAnnotations, { ...create, anchor: { ...create.anchor, section_key: null } })).statusCode).toBe(422);
    expect((await call('POST', epubAnnotations, { ...create, anchor: { ...create.anchor, end: 8 } })).statusCode).toBe(422);
    const annotated = await call('POST', epubAnnotations, create, undefined, key);
    expect(annotated.statusCode, annotated.body).toBe(201);
    expect(annotated.json()).toMatchObject({ id: annotationId, attachment_id: epubId, format: 'epub', anchor: create.anchor,
      tags: ['Proof'], color: 'green', version: '1' });
    expect((await call('POST', epubAnnotations, create, undefined, key)).json()).toEqual(annotated.json());
    expect((await call('PATCH', `${annotations}/${annotationId}`, { anchor: create.anchor }, '1')).statusCode).toBe(422);
    const changed = await call('PATCH', `${annotations}/${annotationId}`, { comment: 'A revised bookmark', tags: [] }, '1');
    expect(changed.json()).toMatchObject({ anchor: create.anchor, version: '2', tags: [] });
    expect((await call('PATCH', `${annotations}/${annotationId}`, { comment: 'Stale' }, '1')).statusCode).toBe(412);
    expect((await call('GET', epubAnnotations + '?section=2')).json().items).toEqual([]);
    expect((await call('GET', epubAnnotations + '?section=1')).json().items).toEqual([changed.json()]);
    expect((await call('GET', fullText + '?q=revised%20bookmark')).json().items).toEqual([
      expect.objectContaining({ format: 'epub', pdf_id: epubId, page: 1, kind: 'annotation', annotation_id: annotationId }),
    ]);
    const advanced = await call('POST', '/research/library/search', { conditions: { all: [
      { field: 'annotation_color', operator: 'equals', value: 'green' },
      { field: 'annotation_comment', operator: 'contains', value: 'revised bookmark' },
    ] } });
    expect(advanced.json().items).toEqual([expect.objectContaining({ id: referenceId })]);

    expect((await call('PATCH', legacy, { file_name: 'Renamed.epub' }, '2')).statusCode).toBe(404);
    expect((await call('DELETE', legacy, undefined, '2')).statusCode).toBe(404);
    expect((await call('PATCH', epub, { file_name: 'Renamed.pdf' }, '2')).statusCode).toBe(422);
    expect((await call('PATCH', epub, { file_name: 'Renamed.epub' }, '2')).json().version).toBe('3');
    const download = await call('GET', epub + '/download');
    expect(download.headers['content-type']).toBe('application/epub+zip');
    expect(download.headers['content-disposition']).toContain('attachment; filename="Renamed.epub"');
    expect(download.rawPayload.equals(bytes)).toBe(true);
    const spoofed = Buffer.from(bytes);
    spoofed.writeUInt16LE(8, 8); // EPUB mimetype is required to be stored without compression.
    expect((await upload(invalidId, spoofed, 'epub', 'Bad.epub')).statusCode).toBe(200);
    const invalid = `/research/attachments/${invalidId}`;
    expect((await call('PUT', invalid + '/chunk', { offset: 0, data: spoofed.toString('base64') })).statusCode).toBe(200);
    expect((await call('POST', invalid + '/complete', {})).statusCode).toBe(422);
    expect((await call('GET', list)).json().items).toHaveLength(1);
    expect((await call('GET', '/research/library/attachments?limit=1')).json()).toEqual(manifest.json());
    expect((await call('DELETE', invalid, undefined, '1')).statusCode).toBe(204);
    expect((await call('DELETE', epub, undefined, '3')).statusCode).toBe(204);
    expect((await call('GET', `${annotations}/${annotationId}`)).statusCode).toBe(404);
    expect((await call('GET', fullText + '?q=bookmark')).json().items).toEqual([]);
    expect((await call('GET', list)).json().items).toEqual([]);
    expect((await call('GET', '/research/library/attachments')).json()).toEqual({ items: [], next_cursor: null });
    expect((await call('GET', fullText + '?q=resume')).json().items).toEqual([]);


    const snapshotId = randomUUID();
    const snapshotText = Buffer.from('A snapshot of Résumé.\n\nText λ 🚀 here.\n<script>not executable</script>');
    const webpage = `/research/attachments/${snapshotId}`;
    expect((await upload(randomUUID(), Buffer.alloc(262145), 'webpage', 'Oversized.txt')).statusCode).toBe(422);
    expect((await upload(randomUUID(), snapshotText, 'webpage', 'Rejected.html')).statusCode).toBe(422);
    expect((await upload(snapshotId, snapshotText, 'webpage', 'Snapshot.txt')).json()).toMatchObject({
      format: 'webpage', status: 'uploading',
    });
    expect((await call('PUT', webpage + '/chunk', { offset: 0, data: snapshotText.toString('base64') })).statusCode).toBe(200);
    expect((await call('POST', webpage + '/complete', {})).json()).toMatchObject({ format: 'webpage', status: 'ready' });
    const snapshot = await call('GET', webpage + '/download');
    expect(snapshot.headers['content-type']).toMatch(/^text\/plain; charset=utf-8$/i);
    expect(snapshot.headers['content-disposition']).toContain('attachment; filename="Snapshot.txt"');
    expect(snapshot.headers['x-content-type-options']).toBe('nosniff');
    expect(snapshot.rawPayload.equals(snapshotText)).toBe(true);
    await addIndex(webpage, ['Header', 'A snapshot of Résumé.']);
    expect((await call('GET', fullText + '?q=resume')).json().items).toEqual([
      expect.objectContaining({ format: 'webpage', pdf_id: snapshotId, page: 2, annotation_id: null }),
    ]);
    expect((await call('GET', legacyList)).json().items).toEqual([]);
    const snapshotAnnotation = randomUUID();
    const snap = { id: snapshotAnnotation, anchor: { section: 2, section_key: null, block: 1, start: 7, end: 9, quote: '🚀' },
      comment: 'Example launch', tags: ['example'] };
    const snapshotAnnotations = webpage + '/text-annotations';
    expect((await call('POST', snapshotAnnotations, { ...snap, anchor: { ...snap.anchor, start: 8, end: 10 } })).statusCode).toBe(422);
    expect((await call('POST', snapshotAnnotations, { ...snap, anchor: { ...snap.anchor, section_key: 'wrong' } })).statusCode).toBe(422);
    const exact = await call('POST', snapshotAnnotations, snap);
    expect(exact.statusCode, exact.body).toBe(201);
    expect(exact.json()).toMatchObject({ format: 'webpage', anchor: snap.anchor });
    expect((await call('GET', fullText + '?q=example%20launch')).json().items).toEqual([
      expect.objectContaining({ format: 'webpage', pdf_id: snapshotId, page: 2, annotation_id: snapshotAnnotation }),
    ]);
    const indexRoute = '/research/library/annotations';
    const harvest = await call('GET', `${indexRoute}?q=EXAMPLE%20launch&tag=EXAMPLE&color=yellow`);
    expect(harvest.statusCode, harvest.body).toBe(200);
    expect(harvest.json().items).toEqual([expect.objectContaining({ id: snapshotAnnotation, format: 'webpage',
      attachment_id: snapshotId, reference_id: referenceId, page: 2, quote: '🚀', tags: ['example'],
      href: `/research/library?reference=${referenceId}&pdf=${snapshotId}&page=2&annotation=${snapshotAnnotation}` })]);
    expect(harvest.headers['cache-control']).toBe('private, no-store');
    const pdfId = randomUUID();
    const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF\n');
    expect((await upload(pdfId, pdfBytes, 'pdf', 'Test.pdf')).statusCode).toBe(200);
    const pdf = `/research/attachments/${pdfId}`;
    expect((await call('PUT', pdf + '/chunk', { offset: 0, data: pdfBytes.toString('base64') })).statusCode).toBe(200);
    expect((await call('POST', pdf + '/complete', {})).statusCode).toBe(200);
    const firstPage = (await call('GET', '/research/library/attachments?limit=1')).json();
    expect(firstPage.items).toHaveLength(1);
    const attachmentCursor = encodeURIComponent(firstPage.next_cursor);
    const secondPage = (await call('GET', `/research/library/attachments?limit=1&cursor=${attachmentCursor}`)).json();
    expect(secondPage.next_cursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map((file) => file.id)).toEqual([snapshotId, pdfId].sort());
    expect((await call('GET', '/research/library/attachments?cursor=invalid')).statusCode).toBe(400);
    const pdfMark = randomUUID();
    expect((await call('POST', `/research/reference-pdfs/${pdfId}/annotations`, { id: pdfMark, page: 1, kind: 'highlight',
      text: 'Résumé for a fixture', comment: 'Example launch', color: 'blue', tags: ['Example'],
      rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }] })).statusCode).toBe(201);
    const page = (await call('GET', `${indexRoute}?tag=example&limit=1`)).json();
    expect(page.items).toEqual([expect.objectContaining({ id: pdfMark, format: 'pdf' })]);
    const token = encodeURIComponent(page.next_cursor);
    expect((await call('GET', `${indexRoute}?tag=example&cursor=${token}`)).json().items).toEqual([
      expect.objectContaining({ id: snapshotAnnotation, format: 'webpage' }),
    ]);
    expect((await call('GET', `${indexRoute}?color=yellow&cursor=${token}`)).statusCode).toBe(422);
    expect((await call('GET', `${indexRoute}?q=resume`)).json().items).toEqual([expect.objectContaining({ id: pdfMark })]);
    expect((await call('GET', `${indexRoute}?color=red`)).statusCode).toBe(422);
    const deviceId = randomUUID();
    await call('POST', '/devices', { id: deviceId, name: 'Annotation sync', platform: 'web' });
    const synced = (await call('POST', '/sync/snapshots', { device_id: deviceId })).json();
    const records = (await call('GET', `/sync/snapshots/${synced.id}/records?limit=100`)).json().records;
    expect(records).toContainEqual(expect.objectContaining({ entity_type: 'research_text_annotation', entity_id: snapshotAnnotation,
      data: expect.objectContaining({ anchor: snap.anchor, tags: ['example'] }) }));
    expect((await call('DELETE', `${annotations}/${snapshotAnnotation}`, undefined, '1')).statusCode).toBe(204);
    expect((await call('GET', snapshotAnnotations)).json().items).toEqual([]);
    expect((await call('GET', `${indexRoute}?tag=example`)).json().items).toEqual([expect.objectContaining({ id: pdfMark })]);

    const invalidTextId = randomUUID();
    const invalidText = Buffer.from([0xc0, 0xaf]);
    const badText = `/research/attachments/${invalidTextId}`;
    expect((await upload(invalidTextId, invalidText, 'webpage', 'Invalid UTF8.txt')).statusCode).toBe(200);
    expect((await call('PUT', badText + '/chunk', { offset: 0, data: invalidText.toString('base64') })).statusCode).toBe(200);
    expect((await call('POST', badText + '/complete', {})).statusCode).toBe(422);
    expect((await call('GET', list)).json().items).toHaveLength(2);

  } finally {
    await app.close();
    if (pg) await pg.cleanup();
    else await db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
