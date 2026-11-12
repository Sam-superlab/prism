import { NextRequest, NextResponse } from 'next/server';
import {
  apiBase,
  clearCookie,
  desktopMode,
  desktopTokenFor,
  sameOrigin,
  sessionFor,
  SESSION_COOKIE,
} from '../../../../lib/server-auth';
import { BodyLimitError, readLimitedBody } from '../../../../lib/request-body';

export const runtime = 'nodejs';
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request))
    return NextResponse.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'The request origin could not be verified.',
          details: {},
          request_id: crypto.randomUUID(),
        },
      },
      { status: 403 },
    );
  const { path } = await context.params;
  const target = new URL(`/api/v1/${path.map(encodeURIComponent).join('/')}`, apiBase());
  target.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'idempotency-key', 'if-match']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const desktop = desktopMode();
    const token = desktop ? desktopTokenFor(request) : undefined;
    const auth = desktop ? { session: null, changed: false } : await sessionFor(request);
    const publicEndpoint = request.method === 'GET' && path.join('/') === 'auth/config';
    if (desktop ? !token : process.env.NODE_ENV === 'production' && !auth.session && !publicEndpoint) {
      const forbidden = token === null;
      const response = NextResponse.json(
        {
          error: {
            code: forbidden ? 'FORBIDDEN' : 'UNAUTHENTICATED',
            message: desktop ? 'Open PRISM from the desktop app.' : 'Sign in to PRISM to continue.',
            details: {},
            request_id: crypto.randomUUID(),
          },
        },
        { status: forbidden ? 403 : 401 },
      );
      if (auth.changed) clearCookie(response, SESSION_COOKIE);
      return response;
    }
    const accessToken = token ?? auth.session?.accessToken;
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readLimitedBody(request);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
    if (desktop) responseHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
    for (const name of ['content-type', 'content-disposition', 'etag', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const response = new NextResponse(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
    if (auth.changed && !auth.session) clearCookie(response, SESSION_COOKIE);
    return response;
  } catch (error) {
    if (error instanceof BodyLimitError)
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
            details: { max_bytes: 1024 * 1024 },
            request_id: crypto.randomUUID(),
          },
        },
        { status: 413 },
      );
    return NextResponse.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'PRISM is temporarily unavailable. Please try again.',
          details: {},
          request_id: crypto.randomUUID(),
        },
      },
      { status: 502 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const PUT = proxy;
