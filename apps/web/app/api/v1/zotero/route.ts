import { NextRequest, NextResponse } from 'next/server';
import { desktopMode, desktopTokenFor } from '../../../../lib/server-auth';
import { readZoteroCollections, readZoteroItems, ZoteroError } from '../../../../lib/server-zotero';

export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' };

export async function GET(request: NextRequest) {
  if (!desktopMode())
    return NextResponse.json(
      { error: { message: 'Zotero is available in the PRISM desktop app.' } },
      { status: 404, headers },
    );
  if (!desktopTokenFor(request))
    return NextResponse.json(
      { error: { message: 'Open PRISM from the desktop app.' } },
      { status: 403, headers },
    );
  try {
    const params = request.nextUrl.searchParams;
    const offset = params.get('start') ?? '0';
    const search = params.get('q')?.trim() ?? '';
    if (!/^\d{1,7}$/.test(offset) || search.length > 120)
      throw new ZoteroError(400, 'Choose a valid Zotero page or shorter search.');
    const collection = params.get('collection');
    const page =
      collection === null
        ? await readZoteroCollections(Number(offset))
        : await readZoteroItems(collection, Number(offset), search);
    return NextResponse.json(page, { headers });
  } catch (error) {
    if (error instanceof ZoteroError)
      return NextResponse.json({ error: { message: error.message } }, { status: error.status, headers });
    return NextResponse.json({ error: { message: 'Unable to read Zotero.' } }, { status: 502, headers });
  }
}
