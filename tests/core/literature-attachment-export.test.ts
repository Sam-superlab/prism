import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { exportLiteratureAttachments } from '../../apps/web/lib/literature-attachment-export';
import type { LiteratureAttachment } from '../../apps/web/lib/literature-pdfs';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { unzipSync } = webRequire('fflate') as {
  unzipSync: (input: Uint8Array) => Record<string, Uint8Array>;
};
const referenceId = '11111111-1111-1111-1111-111111111111';
const original = '%PDF-1.4\nSynthetic original bytes';
const signal = new AbortController().signal;

function attachment(index: number, name: string, data = original): LiteratureAttachment {
  return {
    id: `22222222-2222-2222-2222-${index.toString().padStart(12, '0')}`,
    reference_id: referenceId,
    file_name: name,
    format: 'pdf',
    size_bytes: Buffer.byteLength(data),
    sha256: createHash('sha256').update(data).digest('hex'),
    version: '1',
    status: 'ready',
    next_offset: Buffer.byteLength(data),
  };
}

describe('portable literature attachment ZIP', () => {
  it('retains original bytes and metadata with safe, unique extraction paths', async () => {
    const items = [
      attachment(1, '../Unsafe/Article.pdf'),
      attachment(2, 'Unsafe_Article.PDF'),
      { ...attachment(3, 'CON.txt'), format: 'webpage' as const },
      { ...attachment(4, 'unfinished.pdf'), status: 'uploading' as const },
    ];
    const fetchAttachment = vi.fn(async () => new Response(original));
    const progress = vi.fn();
    const blob = await exportLiteratureAttachments(referenceId, items, {
      signal,
      fetchAttachment,
      onProgress: progress,
    });
    expect(blob.type).toBe('application/zip');
    const extracted = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(extracted)).toEqual([
      'attachments/_Unsafe_Article.pdf',
      'attachments/Unsafe_Article.pdf',
      'attachments/_CON.txt',
      'manifest.json',
    ]);
    for (const name of Object.keys(extracted).slice(0, 3))
      expect(new TextDecoder().decode(extracted[name])).toBe(original);
    expect(JSON.parse(new TextDecoder().decode(extracted['manifest.json']))).toEqual({
      version: 1,
      reference_id: referenceId,
      attachments: items.slice(0, 3).map(({ id, file_name, format, size_bytes, sha256 }, index) => ({
        id,
        file_name,
        format,
        size_bytes,
        sha256,
        path: Object.keys(extracted)[index],
      })),
    });
    expect(fetchAttachment.mock.calls).toEqual(items.slice(0, 3).map(({ id }) => [id, signal]));
    expect(progress.mock.calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('disambiguates NFC and case-insensitive collisions', async () => {
    const items = [attachment(1, 'Épreuve.pdf'), attachment(2, 'E\u0301PREUVE.PDF')];
    const blob = await exportLiteratureAttachments(referenceId, items, {
      signal,
      fetchAttachment: async () => new Response(original),
    });
    const extracted = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(extracted)).toEqual([
      'attachments/Épreuve.pdf',
      'attachments/ÉPREUVE (2).pdf',
      'manifest.json',
    ]);
  });

  it('checks limits before downloading, and rejects incomplete, extra, and changed bytes', async () => {
    const file = attachment(1, 'Test.pdf');
    const fetchAttachment = vi.fn(async () => new Response(original));
    await expect(
      exportLiteratureAttachments(
        referenceId,
        [
          { ...file, size_bytes: 40 * 1024 * 1024 },
          { ...attachment(2, 'Other.pdf'), size_bytes: 32 * 1024 * 1024 },
        ],
        { signal, fetchAttachment },
      ),
    ).rejects.toThrow('64 MiB');
    expect(fetchAttachment).not.toHaveBeenCalled();
    for (const [data, error] of [
      [original.slice(1), 'incomplete'],
      [original + 'x', 'size'],
      ['x' + original.slice(1), 'verify the contents'],
    ] as const)
      await expect(
        exportLiteratureAttachments(referenceId, [file], {
          signal,
          fetchAttachment: async () => new Response(data),
        }),
      ).rejects.toThrow(error);
  });

  it('cancels an active response without opening further attachments', async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream({
      pull() {
        controller.abort(new Error('Stopped'));
      },
      cancel: cancelled,
    });
    const fetchAttachment = vi.fn(async () => new Response(body));
    await expect(
      exportLiteratureAttachments(referenceId, [attachment(1, 'Test.pdf'), attachment(2, 'Other.pdf')], {
        signal: controller.signal,
        fetchAttachment,
      }),
    ).rejects.toThrow('Stopped');
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
