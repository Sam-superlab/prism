import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-csl';
import type { BibliographyItem } from './bibliography';
import type { CustomLiteratureCitationStyle } from './bibliography-custom-csl';
import { bibliographyCslRecords } from './bibliography-export';
import chicago from './csl/chicago-author-date.json';
import ieee from './csl/ieee.json';

export const literatureCitationStyles = [
  { id: 'apa', label: 'APA 7th edition' },
  { id: 'ieee', label: 'IEEE' },
  { id: 'chicago-author-date', label: 'Chicago 18th edition (author–date)' },
] as const;
export type LiteratureCitationStyle = (typeof literatureCitationStyles)[number]['id'];
export const literatureCitationLocators = [
  ['page', 'Page'],
  ['chapter', 'Chapter'],
  ['section', 'Section'],
  ['paragraph', 'Paragraph'],
  ['equation', 'Equation'],
  ['figure', 'Figure'],
  ['table', 'Table'],
  ['appendix', 'Appendix'],
  ['book', 'Book'],
  ['column', 'Column'],
  ['folio', 'Folio'],
  ['issue', 'Issue'],
  ['line', 'Line'],
  ['note', 'Note'],
  ['opus', 'Opus'],
  ['part', 'Part'],
  ['sub-verbo', 'Sub verbo'],
  ['verse', 'Verse'],
  ['volume', 'Volume'],
] as const;
export type LiteratureCitationDetail = {
  locator?: string | number;
  label?: (typeof literatureCitationLocators)[number][0];
  prefix?: string;
  suffix?: string;
  suppressAuthor?: boolean;
};

const config = plugins.config.get('@csl');
config.styles.add('ieee', ieee.xml);
config.styles.add('chicago-author-date', chicago.xml);

export function formatLiteratureCitations(
  items: readonly BibliographyItem[],
  style: LiteratureCitationStyle | CustomLiteratureCitationStyle,
  locale = 'en-US',
  details: readonly (LiteratureCitationDetail | undefined)[] = [],
): { bibliography: string; citation: string } {
  if (!items.length) return { bibliography: '', citation: '' };
  // Use distinct processor IDs even if imported citation keys happen to coincide.
  const records = bibliographyCslRecords(items).map((item, index) => ({ ...item, id: `prism-${index + 1}` }));
  const cite = new Cite(records);
  // The plugin caches compiled engines by style ID; custom IDs are immutable.
  if (typeof style !== 'string' && !config.styles.has(style.id)) config.styles.add(style.id, style.xml);
  const options = {
    style: typeof style === 'string' ? style : style.id,
    lang: locale.replace('_', '-'),
    format: 'text',
  };
  return {
    citation: cite
      .format('citation', {
        ...options,
        entry: records.map((record, index) => {
          const detail = details[index];
          if (!detail) return record.id;
          const locator =
            detail.locator === undefined ? undefined : String(detail.locator).trim() || undefined;
          return {
            id: record.id,
            locator,
            label: locator ? (detail.label ?? 'page') : undefined,
            prefix: detail.prefix?.trim() || undefined,
            suffix: detail.suffix?.trim() || undefined,
            'suppress-author': detail.suppressAuthor || undefined,
          };
        }),
        citationsPre: [],
        citationsPost: [],
      })
      .trim(),
    bibliography: cite.format('bibliography', options).trim(),
  };
}
