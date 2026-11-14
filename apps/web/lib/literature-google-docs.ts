import { citationKey, citationKeyPattern, type BibliographyItem } from './bibliography';
import { formatLiteratureCitations } from './bibliography-csl';

export const maxGoogleDocsMarkerInput = 20_000;
const marker = /\[\[cite:([a-z0-9_./:+-]{1,180})(?:\|([0-9A-Za-z., –—-]{1,35}))?\]\]/gi;

export function buildGoogleDocsCitationPacket(source: string, items: readonly BibliographyItem[]) {
  if (source.length > maxGoogleDocsMarkerInput)
    throw new Error('Paste up to 20,000 characters of citation markers.');
  const index = new Map<string, Map<string, BibliographyItem>>();
  for (const item of items)
    for (const key of [citationKey(item), ...(item.citation_aliases ?? [])]) {
      if (!citationKeyPattern.test(key)) continue;
      const matches = index.get(key) ?? new Map<string, BibliographyItem>();
      matches.set(item.kind + ':' + item.id, item);
      index.set(key, matches);
    }
  const entries = [];
  const bibliography = new Map<string, BibliographyItem>();
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const seen = new Set<string>();
  for (const match of source.matchAll(marker)) {
    const key = match[1];
    const locator = match[2]?.trim() ?? '';
    const expression = key + '|' + locator;
    if (seen.has(expression)) continue;
    seen.add(expression);
    if (seen.size > 100) throw new Error('Prepare up to 100 distinct citation markers at once.');
    const candidates = index.get(key);
    if (!candidates) {
      missing.add(key);
      continue;
    }
    const item = candidates.values().next().value!;
    const canonical = citationKey(item);
    if (candidates.size !== 1 || index.get(canonical)?.size !== 1) {
      ambiguous.add(key);
      continue;
    }
    entries.push({
      key,
      canonical,
      locator,
      text: formatLiteratureCitations([item], 'apa', 'en-US', [{ locator }]).citation,
    });
    bibliography.set(canonical, item);
  }
  const references = [...bibliography.values()];
  const packet = JSON.stringify({
    kind: 'prism-docs-citations',
    version: 1,
    entries,
    bibliography: formatLiteratureCitations(references, 'apa').bibliography,
  });
  if (new TextEncoder().encode(packet).byteLength > 256 * 1024)
    throw new Error('The citation packet is too large. Choose fewer references.');
  return { packet, count: entries.length, missing: [...missing], ambiguous: [...ambiguous] };
}
