export const API_BODY_LIMIT = 1024 * 1024;
export class BodyLimitError extends Error {
  constructor() {
    super('The request body exceeds the 1 MiB limit.');
  }
}
export async function readLimitedBody(
  request: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  limit = API_BODY_LIMIT,
): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new BodyLimitError();
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new BodyLimitError();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
