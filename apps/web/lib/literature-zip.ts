import { Inflate } from 'fflate';

const zipEndSignature = 0x06054b50;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export type ZipEntry = {
  start: number;
  compressed: number;
  size: number;
  method: number;
  flags: number;
  checksum: number;
};

const invalidArchive = () => new Error('The file contains an invalid ZIP archive.');

function zipDirectory(data: Uint8Array, maxEntries: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  let end = data.length - 22;
  const minimum = Math.max(0, end - 65_535);
  while (end >= minimum && (u32(end) !== zipEndSignature || end + 22 + u16(end + 20) !== data.length)) end--;
  if (end < minimum) throw invalidArchive();
  const count = u16(end + 10);
  const size = u32(end + 12);
  const start = u32(end + 16);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    !count ||
    count > maxEntries ||
    start + size !== end
  )
    throw invalidArchive();
  const entries = new Map<string, ZipEntry>();
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) throw invalidArchive();
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const compressed = u32(offset + 20);
    const length = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const next = offset + 46 + nameLength + u16(offset + 30) + u16(offset + 32);
    const local = u32(offset + 42);
    if (next > end || !nameLength || u16(offset + 34) || local + 30 > start || u32(local) !== 0x04034b50)
      throw invalidArchive();
    if (u16(local + 6) !== flags || u16(local + 8) !== method) throw invalidArchive();
    const name = utf8.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataStart + compressed > start || !safeZipName(name) || entries.has(name)) throw invalidArchive();
    const localName = utf8.decode(data.subarray(local + 30, local + 30 + u16(local + 26)));
    if (localName !== name) throw invalidArchive();
    entries.set(name, {
      start: dataStart,
      compressed,
      size: length,
      method,
      flags,
      checksum: u32(offset + 16),
    });
    offset = next;
  }
  if (offset !== end) throw invalidArchive();
  return entries;
}

function safeZipName(name: string) {
  return !/^[\\/]|[\\\x00-\x1f\x7f]|(^|\/)\.{1,2}(\/|$)/.test(name);
}

const crc32Table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function zipChecksum(bytes: Uint8Array) {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = crc32Table[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function inflateZipEntry(compressed: Uint8Array, size: number) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  const inflater = new Inflate((chunk) => {
    if (offset + chunk.byteLength > size) throw invalidArchive();
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  // Yield decoded chunks before accepting more input. This bounds the work and
  // temporary allocation when the ZIP directory lies about the output size.
  const chunkSize = 4096;
  for (let start = 0; start < compressed.byteLength; start += chunkSize) {
    const end = Math.min(start + chunkSize, compressed.byteLength);
    inflater.push(compressed.subarray(start, end), end === compressed.byteLength);
  }
  if (offset !== size) throw invalidArchive();
  return bytes;
}

export function readLiteratureZip(data: Uint8Array, maxEntries: number) {
  const entries = zipDirectory(data, maxEntries);
  return {
    entries,
    read(name: string) {
      const entry = entries.get(name);
      if (!entry) return;
      if (entry.flags & 1) throw new Error('The archive contains encrypted content.');
      const compressed = data.subarray(entry.start, entry.start + entry.compressed);
      const bytes =
        entry.method === 0
          ? compressed
          : entry.method === 8
            ? inflateZipEntry(compressed, entry.size)
            : undefined;
      if (!bytes || bytes.byteLength !== entry.size || zipChecksum(bytes) !== entry.checksum)
        throw invalidArchive();
      return bytes;
    },
  };
}

export function decodeLiteratureXml(bytes: Uint8Array) {
  // XML permits UTF-16 when the encoding is signalled by a byte-order marker.
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  return utf8.decode(bytes);
}
