import { parser } from '@lezer/markdown';
import { bibliographyExport } from './bibliography-export';
import { citationKey, citationKeyPattern, type BibliographyItem } from './bibliography';
import { liveMarkdownMath } from './live-markdown-math';

export const maxLiteratureWritingBytes = 512 * 1024;
export type LiteratureWritingFormat = 'csl-json' | 'biblatex';
const markdownParser = parser.configure(liveMarkdownMath);
const plainKey = /^[\p{L}\p{N}_]+(?:[:.#$%&+?<>~/-][\p{L}\p{N}_]+)*$/u;
const citeToken = /@(?:\{([^{}\s]+)\}|([\p{L}\p{N}_]+(?:[:.#$%&+?<>~/-][\p{L}\p{N}_]+)*))/gu;
const quartoCrossReference =
  /^(?:fig|tbl|lst|eq|sec|thm|lem|cor|prp|cnj|def|exm|exr|sol|rem|alg|nte|tip|wrn|imp|cau)-/i;
const reservedDocumentStem = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const bareUrl = /(?:https?|mailto):[^\s<>]+/giu;
const ignoredNodes = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
  'ProcessingInstruction',
  'Autolink',
  'URL',
  'LinkTitle',
  'LinkReference',
  'Image',
  'InlineMath',
  'DisplayMath',
  'UnclosedMath',
  'Escape',
]);
type Range = { from: number; to: number };
type Cite = Range & { key: string };
type Frontmatter = { start: number; end: number; body: number; content: string };

function readFrontmatter(source: string): Frontmatter | undefined {
  const opener = /^\uFEFF?---[ \t]*\r?\n/.exec(source);
  if (!opener) return;
  const start = opener[0].length;
  const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source.slice(start));
  if (!end) {
    if (/^[ \t]*\r?\n/.test(source.slice(start))) return;
    throw new Error('Close the YAML front matter before exporting.');
  }
  return {
    start,
    end: start + end.index,
    body: start + end.index + end[0].length,
    content: source.slice(start, start + end.index),
  };
}

function frontmatterFields(front: Frontmatter, key: string): Range[] {
  // Top-level scalar names are the only forms edited automatically. Complex
  // existing fields are left in place and surfaced for manual configuration.
  const starts = [...front.content.matchAll(/^([\w.-]+|"[^"\r\n]+"|'[^'\r\n]+'):[ \t]*/gm)];
  return starts.flatMap((match, index) => {
    if (match[1].replace(/^['"]|['"]$/g, '') !== key) return [];
    return [
      {
        from: front.start + match.index + match[0].length,
        to: front.start + (starts[index + 1]?.index ?? front.content.length),
      },
    ];
  });
}

function citationsIn(source: string, offset: number, ignore: readonly Range[] = []): Cite[] {
  const citations: Cite[] = [];
  let nextIgnored = 0;
  for (const match of source.matchAll(citeToken)) {
    const before = source.slice(Math.max(0, match.index - 2), match.index);
    if (/[\p{L}\p{N}_@]$/u.test(before) || /[\p{L}\p{N}_]-$/u.test(before)) continue;
    let unescaped = match.index;
    while (source[unescaped - 1] === '\\') unescaped--;
    if ((match.index - unescaped) % 2) continue;
    const from = match.index;
    const to = from + match[0].length;
    while (ignore[nextIgnored] && ignore[nextIgnored].to <= from) nextIgnored++;
    if (ignore[nextIgnored]?.from < to) continue;
    citations.push({ from: offset + from, to: offset + to, key: match[1] ?? match[2] });
  }
  return citations;
}

function documentCitations(source: string, front: Frontmatter | undefined): Cite[] {
  const offset = front?.body ?? 0;
  const body = source.slice(offset);
  const ignored: Range[] = [];
  markdownParser.parse(body).iterate({
    enter(node) {
      if (ignoredNodes.has(node.name)) {
        ignored.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  for (const url of body.matchAll(bareUrl)) ignored.push({ from: url.index, to: url.index + url[0].length });
  ignored.sort((first, second) => first.from - second.from);
  const nocite = front
    ? frontmatterFields(front, 'nocite').flatMap(({ from, to }) =>
        citationsIn(
          source.slice(from, to).replace(/(^|\s)#[^\r\n]*/g, (comment) => ' '.repeat(comment.length)),
          from,
        ),
      )
    : [];
  return [...nocite, ...citationsIn(body, offset, ignored)];
}

function attachBibliography(source: string, filename: string) {
  const front = readFrontmatter(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const field = `bibliography: ${filename}${newline}`;
  if (!front) {
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    return { source: bom + '---' + newline + field + '---' + newline + newline + source.slice(bom.length) };
  }
  const bibliography = frontmatterFields(front, 'bibliography');
  if (!bibliography.length) {
    if (/^\s*\{|^\?\s|^<<:/m.test(front.content)) {
      return {
        source,
        metadataWarning: `Add ${filename} to the bibliography field in your YAML front matter.`,
      };
    }
    return { source: source.slice(0, front.end) + field + source.slice(front.end) };
  }
  const warning = {
    source,
    metadataWarning: `Add ${filename} to the existing bibliography field in your YAML front matter.`,
  };
  if (bibliography.length !== 1) return warning;
  const [{ from, to }] = bibliography;
  const value = source.slice(from, to);
  const managedPattern = /^(["']?)(?:\.\/)?prism-references\.(?:json|bib)\1$/i;
  // Rewrite only simple scalar paths or an unambiguous block list. Leave
  // aliases, flow collections and more complex YAML untouched.
  const scalar = /^((["']?)[\w./-]+\2)([ \t]*(?:#[^\r\n]*)?)(?:\r?\n|$)/.exec(value);
  if (scalar && /\.(?:json|bib|bibtex|yaml|yml)$/i.test(scalar[1].replace(/['"]$/g, ''))) {
    if (managedPattern.test(scalar[1]))
      return { source: source.slice(0, from) + filename + source.slice(from + scalar[1].length) };
    const separator = source.slice(0, from).match(/[ \t]*$/)?.[0].length ?? 0;
    return {
      source:
        source.slice(0, from - separator) +
        newline +
        '  - ' +
        scalar[1] +
        scalar[3] +
        newline +
        '  - ' +
        filename +
        newline +
        source.slice(from + scalar[0].length),
    };
  }
  const lines = [...value.matchAll(/[^\r\n]*(?:\r?\n|$)/g)].filter((line) => line[0]);
  if (lines[0] && /^(?:#[^\r\n]*)?\r?\n$/.test(lines[0][0])) {
    const entries = lines.slice(1).filter((line) => !/^\s*(?:#.*)?$/u.test(line[0].trimEnd()));
    const simpleList = entries.map((line) =>
      /^( +)- +((["']?)[\w./-]+\3)([ \t]*(?:#[^\r\n]*)?)(?:\r?\n|$)/.exec(line[0]),
    );
    const indentation = simpleList[0]?.[1];
    if (indentation && simpleList.every((entry) => entry?.[1] === indentation)) {
      const existing = simpleList.findIndex((entry) => managedPattern.test(entry![2]));
      if (existing >= 0) {
        const line = entries[existing];
        const match = simpleList[existing]!;
        const start = from + line.index + match[0].indexOf(match[2]);
        return { source: source.slice(0, start) + filename + source.slice(start + match[2].length) };
      }
      const last = entries.at(-1)!;
      const insert = from + last.index + last[0].length;
      return {
        source: source.slice(0, insert) + indentation + '- ' + filename + newline + source.slice(insert),
      };
    }
  }
  return warning;
}

type BibliographyIndex = Map<string, Map<string, BibliographyItem>>;
function addReference(index: BibliographyIndex, key: string, item: BibliographyItem) {
  const refs = index.get(key) ?? new Map<string, BibliographyItem>();
  refs.set(`${item.kind}:${item.id}`, item);
  index.set(key, refs);
}

export function buildLiteratureWritingExport(
  source: string,
  items: readonly BibliographyItem[],
  format: LiteratureWritingFormat,
  quarto = false,
) {
  if (
    source.length > maxLiteratureWritingBytes ||
    new TextEncoder().encode(source).byteLength > maxLiteratureWritingBytes
  )
    throw new Error('Choose a Markdown or Quarto document no larger than 512 KiB.');
  const front = readFrontmatter(source);
  const citations = documentCitations(source, front);
  const index: BibliographyIndex = new Map();
  for (const item of items) {
    addReference(index, citationKey(item), item);
    for (const alias of item.citation_aliases ?? []) {
      if (citationKeyPattern.test(alias)) addReference(index, alias, item);
    }
  }
  const resolved = new Map<string, BibliographyItem>();
  const aliases = new Map<string, string>();
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  let rewritten = '';
  let position = 0;
  for (const cite of citations) {
    if (quarto && quartoCrossReference.test(cite.key)) continue;
    const candidates = index.get(cite.key);
    if (!candidates) {
      missing.add(cite.key);
      continue;
    }
    const item = candidates.values().next().value!;
    const canonical = citationKey(item);
    if (candidates.size > 1 || (index.get(canonical)?.size ?? 0) > 1) {
      ambiguous.add(cite.key);
      continue;
    }
    resolved.set(canonical, item);
    if (canonical === cite.key) continue;
    aliases.set(cite.key, canonical);
    rewritten +=
      source.slice(position, cite.from) +
      (plainKey.test(canonical) ? '@' + canonical : '@{' + canonical + '}');
    position = cite.to;
  }
  rewritten += source.slice(position);
  const file = bibliographyExport([...resolved.values()], format);
  const filename = 'prism-references' + file.extension;
  const linked = resolved.size ? attachBibliography(rewritten, filename) : { source: rewritten };
  return {
    document: linked.source,
    bibliography: { ...file, filename },
    metadataWarning: linked.metadataWarning,
    resolved: resolved.size,
    missing: [...missing],
    ambiguous: [...ambiguous],
    aliases: [...aliases].map(([from, to]) => ({ from, to })),
  };
}

export function literatureWritingDocumentStem(filename: string): string {
  const clean = filename
    .replace(/\.(?:md|markdown|qmd)$/i, '')
    .replace(/[^\p{L}\p{N}._ -]/gu, '-')
    .replace(/^[. ]+|[. ]+$/g, '');
  const stem =
    [...clean]
      .slice(0, 55)
      .join('')
      .replace(/[. ]+$/g, '') || 'manuscript';
  return reservedDocumentStem.test(stem) ? '_' + stem : stem;
}
