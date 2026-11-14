import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { DELETE, GET, OPTIONS, POST } from '../../apps/web/app/api/browser-capture/route';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { NextRequest } = await import(pathToFileURL(requireWeb.resolve('next/server')).href) as {
  NextRequest: new (url: string, init?: RequestInit) => Parameters<typeof POST>[0];
};
const host = '127.0.0.1:43831';
const web = `http://${host}`;
const api = 'http://127.0.0.1:43832';
const desktop = 'b'.repeat(64);
const extension = `chrome-extension://${'a'.repeat(32)}`;
const website = 'https://example.test';
const cookie = `prism_desktop=${desktop}`;
const action = { Cookie: cookie, Origin: web, 'Sec-Fetch-Site': 'same-origin', 'X-PRISM-Browser-Capture': 'desktop' };
const transfer = JSON.stringify({ format: 'prism-reference-v1', capture: { fields: {
  title: 'Synthetic capture', url: 'https://example.test/article', authors: ['Example, Ada'], id: 'not-an-input-id',
}, pdfUrl: 'https://example.test/article.pdf' } });

function configure() {
  vi.stubEnv('PRISM_AUTH_MODE', 'desktop');
  vi.stubEnv('PRISM_WEB_ORIGIN', web);
  vi.stubEnv('PRISM_API_URL', api);
  vi.stubEnv('PRISM_DESKTOP_TOKEN', desktop);
  vi.stubEnv('PRISM_RECOVERY_PREVIEW', undefined);
}

function request(method: string, headers: Record<string, string> = {}, body?: string) {
  return new NextRequest(`${web}/api/browser-capture`, { method, headers: { Host: host, ...headers }, body });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('requires a verified desktop request to create or revoke a code, and rejects recovery', async () => {
  configure();
  expect(GET(request('GET')).status).toBe(404);
  expect(GET(request('GET', { Cookie: cookie })).status).toBe(204);
  expect(GET(request('GET', { Cookie: cookie, Host: 'other.test' })).status).toBe(404);
  expect((await POST(request('POST', { Cookie: cookie, Origin: web }))).status).toBe(403);
  expect((await POST(request('POST', { ...action, Origin: website }))).status).toBe(403);
  expect(DELETE(request('DELETE', { ...action, Origin: website })).status).toBe(404);
  expect((await POST(request('POST', action))).status).toBe(201);
  expect(DELETE(request('DELETE', action)).status).toBe(204);
  vi.stubEnv('PRISM_RECOVERY_PREVIEW', 'true');
  expect(GET(request('GET', action)).status).toBe(404);
  expect((await POST(request('POST', action))).status).toBe(404);
  vi.stubEnv('PRISM_RECOVERY_PREVIEW', undefined);
  vi.stubEnv('PRISM_AUTH_MODE', 'oidc');
  expect((await POST(request('POST', action))).status).toBe(404);
});

it('saves only bounded capture metadata with the exact origin and an unexpired code', async () => {
  configure();
  const issued = await POST(request('POST', action));
  const { code } = await issued.json() as { code: string };
  const token = code.split('.')[2];
  const authorization = { Origin: extension, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const preflight = { Origin: extension, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' };
  expect(OPTIONS(request('OPTIONS', preflight)).headers.get('access-control-allow-origin')).toBe(extension);
  expect(OPTIONS(request('OPTIONS', { ...preflight, Origin: website })).status).toBe(403);
  expect(OPTIONS(request('OPTIONS', { ...preflight, 'Access-Control-Request-Headers': 'cookie' })).status).toBe(403);
  const save = vi.fn(async (url: URL, init: RequestInit) => {
    expect(url.href).toBe(`${api}/api/v1/research/library/import`);
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${desktop}`);
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ items: [{ id: expect.any(String), title: 'Synthetic capture', authors: ['Example, Ada'],
      url: 'https://example.test/article', doi: null, arxiv_id: null, publication: {}, tags: [], year: null }] });
    return Response.json({ items: [{ status: 'imported' }] });
  });
  vi.stubGlobal('fetch', save);
  expect((await POST(request('POST', { ...authorization, Origin: website }, transfer))).status).toBe(403);
  expect((await POST(request('POST', { ...authorization, Cookie: cookie }, transfer))).status).toBe(401);
  expect((await POST(request('POST', authorization, 'x'.repeat(262_145)))).status).toBe(413);
  const snapshot = JSON.parse(transfer);
  snapshot.capture.snapshot = { text: 'Not for direct save', truncated: false };
  expect((await POST(request('POST', authorization, JSON.stringify(snapshot)))).status).toBe(422);
  expect(save).not.toHaveBeenCalled();
  const saved = await POST(request('POST', authorization, transfer));
  expect(saved.headers.get('access-control-allow-origin')).toBe(extension);
  expect(await saved.json()).toEqual({ status: 'saved' });
  expect(await (await POST(request('POST', authorization, transfer))).json()).toEqual({ status: 'saved' });
  expect(save).toHaveBeenCalledTimes(1);
  expect((await POST(request('POST', authorization, `${transfer} `))).status).toBe(401);
  expect(DELETE(request('DELETE', action)).status).toBe(204);
  expect((await POST(request('POST', authorization, transfer))).status).toBe(401);
});
