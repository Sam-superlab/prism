import { NextRequest, NextResponse } from 'next/server';
import { parseBibliographyCaptureTransfer } from '../../../lib/bibliography-capture';
import { browserCaptureConnection, isCaptureExtensionOrigin } from '../../../lib/browser-capture-connection';
import { BodyLimitError, readLimitedBody } from '../../../lib/request-body';
import { apiBase, desktopMode, desktopTokenFor, sameOrigin } from '../../../lib/server-auth';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
const maxCaptureBytes = 256 * 1024;
function localLaunch(request: NextRequest) {
  if (!desktopMode() || process.env.PRISM_RECOVERY_PREVIEW === 'true') return;
  const webOrigin = process.env.PRISM_WEB_ORIGIN;
  const apiOrigin = apiBase();
  const loopback = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
  const port = loopback.exec(webOrigin ?? '')?.[1];
  const apiPort = loopback.exec(apiOrigin)?.[1];
  const launch = process.env.PRISM_DESKTOP_TOKEN;
  if (!port || !apiPort || port === apiPort || Number(port) > 65535 || Number(apiPort) > 65535 ||
      request.headers.get('host') !== `127.0.0.1:${port}` || !launch || !/^[a-f0-9]{64}$/.test(launch)) return;
  return { port, launch };
}

function response(status: number, body?: object, origin?: string) {
  const resultHeaders = { ...headers, ...(origin && { 'Access-Control-Allow-Origin': origin }) };
  return body ? NextResponse.json(body, { status, headers: resultHeaders }) : new NextResponse(null, { status, headers: resultHeaders });
}

export function GET(request: NextRequest) {
  return localLaunch(request) && desktopTokenFor(request) ? response(204) : response(404);
}

function desktopAction(request: NextRequest) {
  return request.headers.get('x-prism-browser-capture') === 'desktop' && sameOrigin(request) && desktopTokenFor(request);
}

export function OPTIONS(request: NextRequest) {
  const local = localLaunch(request);
  const origin = request.headers.get('origin');
  const requested = request.headers.get('access-control-request-headers')?.toLowerCase().split(',').map((item) => item.trim());
  if (!local || !isCaptureExtensionOrigin(origin) ||
      request.headers.get('access-control-request-method') !== 'POST' || !requested?.includes('authorization') ||
      !requested.includes('content-type') || requested.some((item) => !['authorization', 'content-type'].includes(item))) return response(403);
  return new NextResponse(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
}

export async function POST(request: NextRequest) {
  const local = localLaunch(request);
  if (!local) return response(404);
  if (desktopAction(request)) return response(201, browserCaptureConnection.issue(local.launch, local.port));
  const origin = request.headers.get('origin');
  if (!isCaptureExtensionOrigin(origin)) return response(403);
  const authorization = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  const token = authorization?.[1];
  if (!token || request.headers.has('cookie') || !browserCaptureConnection.allows(local.launch, origin, token))
    return response(401, { error: 'This save code is unavailable. Generate a new one in PRISM.' }, origin);
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    return response(415, { error: 'Send a PRISM reference as JSON.' }, origin);
  let transfer: string;
  let capture: ReturnType<typeof parseBibliographyCaptureTransfer>;
  try {
    const buffer = await readLimitedBody(request, maxCaptureBytes);
    transfer = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    capture = parseBibliographyCaptureTransfer(transfer);
    if (capture.snapshot) return response(422, { error: 'Use Copy reference + page text to review the snapshot in PRISM.' }, origin);
  } catch (cause) {
    return response(cause instanceof BodyLimitError ? 413 : 422, { error: 'The captured reference is missing or invalid.' }, origin);
  }
  try {
    const result = await browserCaptureConnection.submit(local.launch, origin, token, transfer, async (id) => {
      const upstream = await fetch(new URL('/api/v1/research/library/import', apiBase()), {
        method: 'POST', headers: { Authorization: `Bearer ${local.launch}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ items: [{ id, ...capture.fields }] }),
      });
      if (upstream.status === 409 || upstream.status === 422) { await upstream.body?.cancel(); return 'rejected'; }
      if (!upstream.ok) { await upstream.body?.cancel(); throw new Error('Unable to save the reference.'); }
      const report = await upstream.json() as { items?: { status?: string }[] };
      if (report.items?.[0]?.status === 'imported') return 'saved';
      if (report.items?.[0]?.status === 'skipped') return 'duplicate';
      throw new Error('Unable to verify the save result.');
    });
    if (result === 'unavailable') return response(401, { error: 'This save code is unavailable. Generate a new one in PRISM.' }, origin);
    if (result === 'rejected') return response(422, { error: 'This reference could not be saved. Copy it and review it in PRISM.' }, origin);
    return response(200, { status: result }, origin);
  } catch {
    return response(503, { error: 'PRISM could not confirm the save. Keep this popup open and retry with the same code.' }, origin);
  }
}

export function DELETE(request: NextRequest) {
  const local = localLaunch(request);
  if (!local || !desktopAction(request)) return response(404);
  browserCaptureConnection.revoke(local.launch);
  return response(204);
}
