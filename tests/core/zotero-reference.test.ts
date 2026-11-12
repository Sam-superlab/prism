import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../apps/web/app/api/v1/zotero/route';
import { bibliographyBibtex } from '../../apps/web/lib/zotero-reference';

const webOrigin = 'http://127.0.0.1:38741';
const token = 'a'.repeat(64);
const request = (query = '', cookie = token, origin = webOrigin) =>
  ({
    nextUrl: new URL(`/api/v1/zotero${query}`, webOrigin),
    headers: new Headers({ host: '127.0.0.1:38741', origin }),
    cookies: { get: () => ({ value: cookie }) },
  }) as Parameters<typeof GET>[0];

function configureDesktop() {
  vi.stubEnv('PRISM_AUTH_MODE', 'desktop');
  vi.stubEnv('PRISM_WEB_ORIGIN', webOrigin);
  vi.stubEnv('PRISM_API_URL', 'http://127.0.0.1:40390');
  vi.stubEnv('PRISM_DESKTOP_TOKEN', token);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Zotero local metadata', () => {
  it('makes no request outside an authenticated desktop session or for an invalid collection', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('PRISM_AUTH_MODE', 'oidc');
    expect((await GET(request())).status).toBe(404);
    configureDesktop();
    expect((await GET(request('', ''))).status).toBe(403);
    expect((await GET(request('', token, 'https://example.org'))).status).toBe(403);
    expect((await GET(request('?collection=../items'))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads selected collection metadata by GET and strips extra Zotero fields', async () => {
    configureDesktop();
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        [
          {
            key: 'ABCD2345',
            data: {
              itemType: 'preprint',
              title: 'A preprint',
              creators: [{ creatorType: 'author', lastName: 'Example', firstName: 'Ada' }],
              date: '2025-01-31',
              DOI: '10.1234/EXAMPLE',
              url: 'https://arxiv.org/pdf/2501.12345v2.pdf',
              abstractNote: 'Private metadata omitted from the response',
              attachment: '/private/file.pdf',
            },
          },
        ],
        { headers: { 'Total-Results': '26' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const response = await GET(request('?collection=TEST2345&start=24&q=module%20%26%20ideal'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      items: [
        {
          zotero_key: 'ABCD2345',
          title: 'A preprint',
          authors: ['Example, Ada'],
          year: 2025,
          doi: '10.1234/example',
          arxiv_id: '2501.12345v2',
          url: 'https://arxiv.org/pdf/2501.12345v2.pdf',
        },
      ],
      next: 25,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL(
        'http://127.0.0.1:23119/api/users/0/collections/TEST2345/items/top?format=json&limit=25&start=24&q=module+%26+ideal',
      ),
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('exports the editor key and escapes special characters in BibTeX', () => {
    const bibtex = bibliographyBibtex([
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '1',
        kind: 'reference',
        title: 'Ring & module {notes}',
        authors: ['Example, Ada'],
        year: 2025,
        doi: null,
        arxiv_id: null,
        url: null,
        zotero_key: null,
      },
    ]);
    expect(bibtex).toContain('@misc{ref-11111111-1111-4111-8111-111111111111,');
    expect(bibtex).toContain('title = {{Ring \\& module \\{notes\\}}}');
  });
});
