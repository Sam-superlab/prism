import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { NextRequest } from 'next/server';
import { apiBase, desktopMode, desktopTokenFor, sessionFor } from '../../../lib/server-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!/^[a-z0-9][a-z0-9-]{0,150}\.png$/.test(name)) return new Response(null, { status: 404, headers });

  try {
    const desktop = desktopMode();
    const token = desktop ? desktopTokenFor(request) : (await sessionFor(request)).session?.accessToken;
    if ((desktop || process.env.NODE_ENV === 'production') && !token)
      return new Response(null, { status: token === null ? 403 : 401, headers });
    const owner = await fetch(new URL('/api/v1/me', apiBase()), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    await owner.body?.cancel();
    if (!owner.ok) return new Response(null, { status: owner.status, headers });

    const file = await open(
      resolve(process.env.PRISM_DATA_DIR ?? '.data', 'knowledge-sources', name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return new Response(null, { status: 404, headers });
      return new Response(new Uint8Array(await file.readFile()), {
        headers: { ...headers, 'Content-Type': 'image/png', 'Cross-Origin-Resource-Policy': 'same-origin' },
      });
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return new Response(null, { status: code === 'ENOENT' || code === 'ELOOP' ? 404 : 503, headers });
  }
}
