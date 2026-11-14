import { createHash } from 'node:crypto';
import { ApiError, validation } from './errors';
import { normalizeReferenceIdentifier } from './reference-lookup';

export type OpenAccessReference = {
  arxiv_id?: string | null;
  doi?: string | null;
  url?: string | null;
  publication?: { pmid?: string } | null;
};
type Provider = 'arxiv' | 'pmc';
export type OpenAccessPdfSelection = { provider: Provider; identifier: string };
export type OpenAccessPdfCandidate = OpenAccessPdfSelection & {
  title: string | null;
  source_url: string;
  license: string | null;
};
type PmcCandidate = OpenAccessPdfCandidate & { md5: string | null };

const arxivOrigin = 'https://arxiv.org';
const europePmcOrigin = 'https://www.ebi.ac.uk';
const pmcOrigin = 'https://pmc-oa-opendata.s3.amazonaws.com';
const pdfLimit = 32 * 1024 * 1024;
const metadataLimit = 512 * 1024;
const pmcidPattern = /^PMC[1-9]\d{0,11}$/;
const pmcVersionPattern = /^PMC[1-9]\d{0,11}\.[1-9]\d{0,4}$/;
const pdfHeader = /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, limit) || null
    : null;
}

function knownIdentifier(kind: 'doi' | 'pmid' | 'arxiv', value: string | null | undefined) {
  try {
    return value ? normalizeReferenceIdentifier(kind, value) : null;
  } catch {
    return null;
  }
}

function arxivId(reference: OpenAccessReference) {
  const doi = knownIdentifier('doi', reference.doi);
  const doiId = doi && /^10\.48550\/arxiv\.(.+)$/i.exec(doi)?.[1];
  const explicit = knownIdentifier('arxiv', reference.arxiv_id) ?? knownIdentifier('arxiv', doiId);
  if (explicit) return explicit;
  if (!reference.url || !/^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i.test(reference.url)) return null;
  return knownIdentifier('arxiv', reference.url);
}

function matchesReference(item: Record<string, unknown>, doi: string | null, pmid: string | null) {
  if (doi && knownIdentifier('doi', cleanText(item.doi, 250)) !== doi) return false;
  if (!pmid) return !!doi;
  return String(item.pmid ?? (item.source === 'MED' ? item.id : '')) === pmid;
}

function unavailable() {
  return new ApiError(
    502,
    'EXTERNAL_SERVICE_ERROR',
    'Could not reach the open-access source. Try again shortly.',
  );
}

async function body(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit)
      throw validation('The source file exceeds the download size limit.');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.byteLength;
      if (size > limit) throw validation('The source file exceeds the download size limit.');
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Options = { fetch?: typeof fetch };

export function createOpenAccessPdf(options: Options = {}) {
  const get = options.fetch ?? fetch;
  let active = 0;
  async function limited<T>(work: () => Promise<T>) {
    if (active >= 3)
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many open-access requests are running. Try again shortly.',
      );
    active++;
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally {
      active--;
    }
  }

  async function open(url: URL, accept: string, signal?: AbortSignal) {
    return get(url, {
      headers: { Accept: accept, 'User-Agent': 'PRISM personal literature library' },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]),
    });
  }

  async function metadata(url: URL, accept = 'application/json', signal?: AbortSignal) {
    const response = await open(url, accept, signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) return null;
      throw unavailable();
    }
    return (await body(response, metadataLimit)).toString('utf8');
  }

  async function findPmc(reference: OpenAccessReference, signal?: AbortSignal) {
    const doi = knownIdentifier('doi', reference.doi);
    const pmid = knownIdentifier('pmid', reference.publication?.pmid);
    if (!doi && !pmid) return [];
    // Escape Lucene quotes before embedding the identifier in the provider query.
    const query =
      (doi ? `DOI:"${doi.replace(/"/g, '\\"')}"` : `EXT_ID:${pmid} AND SRC:MED`) + ' AND OPEN_ACCESS:Y';
    const url = new URL('/europepmc/webservices/rest/search', europePmcOrigin);
    url.search = new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: '5' }).toString();
    const search = await metadata(url, 'application/json', signal);
    if (!search) return [];
    const result = record(record(JSON.parse(search)).resultList).result;
    if (!Array.isArray(result)) throw unavailable();
    const matching = [
      ...new Set(
        result
          .slice(0, 5)
          .map(record)
          .flatMap((item) => {
            const pmcid = cleanText(item.pmcid, 30);
            return pmcid &&
              pmcidPattern.test(pmcid) &&
              item.isOpenAccess === 'Y' &&
              item.hasPDF === 'Y' &&
              matchesReference(item, doi, pmid)
              ? [pmcid]
              : [];
          }),
      ),
    ].slice(0, 2);
    const candidates = await Promise.all(
      matching.map(async (pmcid) => {
        const listingUrl = new URL(pmcOrigin);
        listingUrl.search = new URLSearchParams({
          'list-type': '2',
          prefix: `metadata/${pmcid}.`,
          'max-keys': '10',
        }).toString();
        const listing = await metadata(listingUrl, 'application/xml', signal);
        if (!listing) return [];
        const versions = [
          ...new Set(
            Array.from(listing.matchAll(/<Key>metadata\/(PMC\d+\.\d+)\.json<\/Key>/g), (match) => match[1]),
          ),
        ]
          .filter((id) => pmcVersionPattern.test(id) && id.startsWith(pmcid + '.'))
          .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
          .slice(0, 4);
        return Promise.all(
          versions.map(async (identifier): Promise<PmcCandidate | null> => {
            const descriptor = await metadata(
              new URL(`/metadata/${identifier}.json`, pmcOrigin),
              'application/json',
              signal,
            );
            if (!descriptor) return null;
            const item = record(JSON.parse(descriptor));
            const pdf = cleanText(item.pdf_url, 500);
            const prefix = `s3://pmc-oa-opendata/${identifier}/${identifier}.pdf`;
            const md5 = pdf?.startsWith(prefix)
              ? /^\?md5=([a-f0-9]{32})$/i.exec(pdf.slice(prefix.length))?.[1]
              : null;
            if (
              item.pmcid !== pmcid ||
              Number(item.version) !== Number(identifier.split('.')[1]) ||
              item.is_pmc_openaccess !== true ||
              !matchesReference(item, doi, pmid) ||
              (pdf !== prefix && !md5)
            )
              return null;
            return {
              provider: 'pmc',
              identifier,
              title: cleanText(item.title, 500),
              source_url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
              license: cleanText(item.license_code, 100),
              md5: md5?.toLowerCase() ?? null,
            };
          }),
        );
      }),
    );
    return candidates.flat().filter((candidate): candidate is PmcCandidate => candidate !== null);
  }

  async function discover(reference: OpenAccessReference, signal?: AbortSignal) {
    const id = arxivId(reference);
    if (id)
      return {
        items: [
          {
            provider: 'arxiv' as const,
            identifier: id,
            title: null,
            source_url: `${arxivOrigin}/abs/${id}`,
            license: null,
          },
        ],
      };
    const deadline = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    return { items: (await limited(() => findPmc(reference, deadline))).map(({ md5: _, ...item }) => item) };
  }

  async function download(
    reference: OpenAccessReference,
    selection: OpenAccessPdfSelection,
    signal?: AbortSignal,
  ) {
    return limited(async () => {
      const { identifier, provider } = selection;
      const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      let url: URL;
      let checksum: string | null = null;
      if (provider === 'arxiv' && identifier === arxivId(reference))
        url = new URL(`/pdf/${identifier}`, arxivOrigin);
      else if (provider === 'pmc' && pmcVersionPattern.test(identifier)) {
        const candidate = (await findPmc(reference, deadline)).find((item) => item.identifier === identifier);
        if (!candidate) throw validation('Choose a PDF source found for this reference.');
        checksum = candidate.md5;
        url = new URL(`/${identifier}/${identifier}.pdf`, pmcOrigin);
      } else throw validation('Choose a PDF source found for this reference.');

      const response = await open(url, 'application/pdf, application/octet-stream', deadline);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(type ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw validation('The source did not return a PDF.');
      }
      const bytes = await body(response, pdfLimit);
      if (!pdfHeader.test(bytes.subarray(0, 10).toString('ascii')))
        throw validation('The source did not return a PDF.');
      if (checksum && createHash('md5').update(bytes).digest('hex') !== checksum)
        throw validation('The source PDF no longer matches its open-access record. Find the source again.');
      return {
        bytes,
        fileName: `${provider === 'arxiv' ? 'arxiv-' : ''}${identifier.replace('/', '-')}.pdf`,
      };
    });
  }

  return { discover, download };
}
