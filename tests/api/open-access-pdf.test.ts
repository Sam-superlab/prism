import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createOpenAccessPdf } from '../../apps/api/src/open-access-pdf';

const pdf = '%PDF-1.7\nSynthetic open-access fixture\n%%EOF\n';
const doi = '10.1234/fixture';
const pmcid = 'PMC999999999';
const identifier = pmcid + '.2';
const md5 = createHash('md5').update(pdf).digest('hex');
const pmcMetadata = {
  pmcid,
  version: 2,
  doi,
  pmid: 12345,
  title: 'Synthetic article',
  is_pmc_openaccess: true,
  license_code: 'CC BY',
  pdf_url: `s3://pmc-oa-opendata/${identifier}/${identifier}.pdf?md5=${md5}`,
};

function provider(overrides: Record<string, unknown> = {}, content = pdf) {
  return vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    if (url.hostname === 'www.ebi.ac.uk')
      return Response.json({
        resultList: {
          result: [
            { pmcid, doi, pmid: '12345', isOpenAccess: 'Y', hasPDF: 'Y' },
            { pmcid: 'PMC11111111', doi: '10.1234/unrelated', isOpenAccess: 'Y', hasPDF: 'Y' },
          ],
        },
      });
    if (url.hostname === 'pmc-oa-opendata.s3.amazonaws.com' && url.pathname === '/') {
      expect(url.searchParams.get('prefix')).toBe('metadata/' + pmcid + '.');
      return new Response(
        `<ListBucketResult><Contents><Key>metadata/${identifier}.json</Key></Contents><Contents><Key>metadata/PMC11111111.1.json</Key></Contents></ListBucketResult>`,
      );
    }
    if (url.pathname === `/metadata/${identifier}.json`)
      return Response.json({ ...pmcMetadata, ...overrides });
    if (url.pathname === `/${identifier}/${identifier}.pdf`)
      return new Response(content, { headers: { 'Content-Type': 'binary/octet-stream' } });
    throw Error('Unexpected fixture request');
  });
}

describe('open-access PDF source discovery', () => {
  it('returns an arXiv candidate without fetching and downloads the selected canonical path only', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }),
    );
    const oa = createOpenAccessPdf({ fetch });
    const reference = { doi: '10.48550/arXiv.math.AC/0501234v2', url: 'https://example.test/paper' };
    const { items } = await oa.discover(reference);
    expect(items).toEqual([
      {
        provider: 'arxiv',
        identifier: 'math.ac/0501234v2',
        title: null,
        source_url: 'https://arxiv.org/abs/math.ac/0501234v2',
        license: null,
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      oa.download(reference, { provider: 'arxiv', identifier: 'https://example.test/other' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
    expect(await oa.download(reference, items[0])).toEqual({
      bytes: Buffer.from(pdf),
      fileName: 'arxiv-math.ac-0501234v2.pdf',
    });
    expect(String(fetch.mock.calls[0][0])).toBe('https://arxiv.org/pdf/math.ac/0501234v2');
  });

  it('matches exact DOI and PMID, checks NLM open-access records, and verifies the file digest', async () => {
    const fetch = provider();
    const oa = createOpenAccessPdf({ fetch });
    const reference = { doi, publication: { pmid: '12345' } };
    const { items } = await oa.discover(reference);
    expect(items).toEqual([
      {
        provider: 'pmc',
        identifier,
        title: 'Synthetic article',
        source_url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
        license: 'CC BY',
      },
    ]);
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls.every(([url]) => !String(url).endsWith('.pdf'))).toBe(true);
    await expect(oa.download(reference, items[0])).resolves.toEqual({
      bytes: Buffer.from(pdf),
      fileName: identifier + '.pdf',
    });
    await expect(
      createOpenAccessPdf({ fetch: provider({}, pdf + 'different') }).download(reference, items[0]),
    ).rejects.toThrow('no longer matches');
    await expect(oa.discover({ doi, publication: { pmid: '999' } })).resolves.toEqual({ items: [] });
  });

  it('refuses changed identifiers, external paths, missing OA flags, redirects, HTML and oversized responses', async () => {
    for (const change of [
      { doi: '10.9999/different' },
      { is_pmc_openaccess: false },
      { pdf_url: 'https://example.test/paper.pdf' },
    ]) {
      const fetch = provider(change);
      const oa = createOpenAccessPdf({ fetch });
      await expect(oa.discover({ doi })).resolves.toEqual({ items: [] });
      await expect(oa.download({ doi }, { provider: 'pmc', identifier })).rejects.toMatchObject({
        status: 422,
      });
      expect(fetch.mock.calls.every(([url]) => !String(url).endsWith('.pdf'))).toBe(true);
    }
    const arxiv_id = '2401.12345';
    for (const [response, error] of [
      [
        new Response(null, { status: 302, headers: { Location: 'https://example.test/file' } }),
        'Could not reach',
      ],
      [new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), 'did not return a PDF'],
      [new Response('<html>', { headers: { 'Content-Type': 'application/pdf' } }), 'did not return a PDF'],
      [
        new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '33554433' } }),
        'size limit',
      ],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
      await expect(
        createOpenAccessPdf({ fetch }).download({ arxiv_id }, { provider: 'arxiv', identifier: arxiv_id }),
      ).rejects.toThrow(error);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
});
