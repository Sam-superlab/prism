import { readPdfMathExtensionFonts } from './pdf-math-delimiters';
import { readPdfMathFonts } from './pdf-math-fonts';
import { reconstructPdfMath, type PdfMathLine, type PdfMathWarning } from './pdf-math-layout';
import { readPdfMathRules } from './pdf-math-rules';

export interface TextbookPage {
  page: number;
  text: string;
  mathLines?: PdfMathLine[];
}

export interface ExerciseCandidate {
  number: string;
  text: string;
  original: string;
  fromPage: number;
  toPage: number;
  uncertain: boolean;
  mathWarnings?: PdfMathWarning[];
}

export interface ExtractionResult {
  exercises: ExerciseCandidate[];
  warnings: string[];
}

interface Heading {
  number: string;
  text: string;
  indent: number;
  explicit: boolean;
  dottedWithoutDelimiter: boolean;
}

const exerciseSection =
  /^\s*(?:(?:(?:chapter|section)\s+)?\d+(?:\.\d+)*[.)]?\s+)?(?:(?:review|practice|chapter|section|additional)\s+)?(?:exercises|problems)(?:\s+(?:(?:for|in)\s+)?(?:(?:section|chapter)\s+)?\d+(?:\.\d+)*)?\s*:?\s*$/i;
const otherSection =
  /^\s*(?:(?:answers?|solutions?|hints)(?:\s+(?:to|for)\s+.+)?|bibliography|references|summary|appendix(?:\s+[a-z])?)\s*:?\s*$/i;
const chapterSection = /^\s*(?:chapter|section)\s+\d+(?:\.\d+)*[.:]?\s+\S/i;
const explicitNumber = /^(?:exercise|problem)\s+(\d+(?:\.\d+)*[a-z]?)(?:[.:)](?=\s|$))?(?:\s+|$)(.*)$/i;
const bareNumber = /^(\d+(?:\.\d+)*[a-z]?)[.)](?:\s+|$)(.*)$/i;
const dottedNumber = /^(\d+(?:\.\d+)+[a-z]?)\s+([\p{L}($].*)$/u;

function findHeading(line: string): Heading | undefined {
  const trimmed = line.trimStart();
  const explicit = explicitNumber.exec(trimmed);
  const bare = bareNumber.exec(trimmed);
  const dotted = dottedNumber.exec(trimmed);
  const match = explicit ?? bare ?? dotted;
  if (!match) return;
  return {
    number: match[1],
    text: match[2],
    indent: line.slice(0, line.length - trimmed.length).replaceAll('\t', '    ').length,
    explicit: Boolean(explicit),
    dottedWithoutDelimiter: !explicit && !bare,
  };
}

export function extractTextbookExercises(pages: TextbookPage[]): ExtractionResult {
  const exercises: ExerciseCandidate[] = [];
  const warnings: string[] = [];
  const sections = pages.some((page) => page.text.split(/\r?\n/).some((line) => exerciseSection.test(line)));
  let inSection = !sections;
  let inSupplement = false;
  let current:
    | {
        heading: Heading;
        original: string[];
        body: string[];
        fromPage: number;
        toPage: number;
        mathWarnings: PdfMathWarning[];
      }
    | undefined;

  function finish() {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) {
      exercises.push({
        number: current.heading.number,
        text,
        original: current.original.join('\n').trim(),
        fromPage: current.fromPage,
        toPage: current.toPage,
        uncertain: !current.heading.explicit && (!sections || current.heading.dottedWithoutDelimiter),
        ...(current.mathWarnings.length ? { mathWarnings: current.mathWarnings } : {}),
      });
    } else {
      warnings.push(`Exercise ${current.heading.number} has no readable text on page ${current.fromPage}.`);
    }
    current = undefined;
  }

  for (const { page, text, mathLines } of pages) {
    if (!text.trim()) {
      warnings.push(`Page ${page} has no selectable text. A scanned page may require manual transcription.`);
      if (current) {
        const previousLength = exercises.length;
        finish();
        if (exercises.length > previousLength) exercises[exercises.length - 1].uncertain = true;
      }
      continue;
    }
    const lines: PdfMathLine[] =
      mathLines ?? text.split(/\r?\n/).map((line) => ({ text: line, original: line }));
    for (const { text: line, original, mathWarnings } of lines) {
      if (exerciseSection.test(line)) {
        finish();
        inSection = true;
        inSupplement = false;
        continue;
      }
      if (otherSection.test(line)) {
        finish();
        inSection = false;
        inSupplement = true;
        continue;
      }
      if (chapterSection.test(line)) {
        finish();
        inSection = !sections;
        inSupplement = false;
        continue;
      }
      const heading = findHeading(line);
      if (
        heading &&
        !inSupplement &&
        (inSection || heading.explicit) &&
        (!current || heading.explicit || heading.indent <= current.heading.indent)
      ) {
        finish();
        current = {
          heading,
          original: [original],
          body: [heading.text],
          fromPage: page,
          toPage: page,
          mathWarnings: [...(mathWarnings ?? [])],
        };
        continue;
      }
      if (current) {
        current.original.push(original);
        current.body.push(line);
        if (mathWarnings) current.mathWarnings.push(...mathWarnings);
        if (line.trim()) current.toPage = page;
      }
    }
  }
  const beforeRangeEnd = exercises.length;
  finish();
  const lastExercise = exercises.length > beforeRangeEnd ? exercises.at(-1) : undefined;
  if (
    lastExercise &&
    !/[.!?;:]$/.test(lastExercise.text) &&
    !/[.!?;:]$/.test(lastExercise.original) &&
    !/\\end\{(?:[pbBvV]matrix|cases)\}\$$/.test(lastExercise.text)
  ) {
    lastExercise.uncertain = true;
  }

  const occurrences = new Map<string, number>();
  for (const exercise of exercises) {
    occurrences.set(exercise.number, (occurrences.get(exercise.number) ?? 0) + 1);
  }
  for (const exercise of exercises) {
    if (
      (occurrences.get(exercise.number) ?? 0) > 1 ||
      /[\uFFFD\uE000-\uF8FF]|\[(?:Formula omitted|Image[ :]|Superscript:|Subscript:)/u.test(exercise.text)
    ) {
      exercise.uncertain = true;
    }
  }
  if (!exercises.length) {
    warnings.push(
      'No numbered exercises found. Select an exercise section or paste a smaller excerpt with exercise numbers.',
    );
  } else if (exercises.some((exercise) => exercise.uncertain)) {
    warnings.push(
      'Review flagged exercises against the source for ambiguous numbering, glyphs, boundaries, or missing diagrams and formulas.',
    );
  }
  return { exercises, warnings };
}

const skippedHtml =
  'script, style, noscript, template, iframe, object, embed, link, nav, footer, svg, [hidden], [aria-hidden="true"]';
const blockHtml = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'MAIN',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
]);

export function readTextbookHtml(html: string): string {
  if (html.length > 4_000_000) throw new Error('Paste a single chapter or exercise section under 4 MB.');

  // A detached template keeps resources inert. Never attach the imported markup to the page.
  const template = document.createElement('template');
  template.innerHTML = html;
  function walk(node: Node, depth: number): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.replace(/\s+/g, ' ') ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    const mathScript =
      element.tagName === 'SCRIPT' && /^math\/tex\b/i.test(element.getAttribute('type') ?? '');
    if (
      mathScript ||
      element.matches('math, mjx-container, .katex, .katex-display, .MathJax, .MathJax_Display')
    ) {
      const source = mathScript
        ? element
        : element.querySelector('annotation[encoding="application/x-tex" i], script[type^="math/tex" i]');
      const tex = source?.textContent?.trim();
      if (!tex && element.nextElementSibling?.matches('script[type^="math/tex" i]')) return '';
      if (!tex) return ' [Formula omitted; consult source] ';
      const display =
        /display/i.test(source?.getAttribute('type') ?? '') ||
        /^(?:block|true)$/i.test(element.getAttribute('display') ?? '') ||
        element.matches('.katex-display, .MathJax_Display');
      const delimiter = display ? '$$' : '$';
      return tex.startsWith('$') ? tex : delimiter + tex + delimiter;
    }
    if (element.matches(skippedHtml)) return '';
    if (element.tagName === 'BR') return '\n';
    if (element.tagName === 'SUP' || element.tagName === 'SUB') {
      const label = element.tagName === 'SUP' ? 'Superscript' : 'Subscript';
      return `[${label}: ${element.textContent?.trim() ?? ''}]`;
    }
    if (element.tagName === 'IMG') {
      const alt = element.getAttribute('alt')?.trim();
      return alt ? ` [Image: ${alt}] ` : ' [Image omitted; consult source] ';
    }
    if (element.tagName === 'OL' || element.tagName === 'UL') {
      const reversed = element.hasAttribute('reversed');
      const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
      const start = element.getAttribute('start');
      let position = start === null ? (reversed ? items.length : 1) : Number(start);
      if (!Number.isSafeInteger(position)) position = 1;
      const lines = items.map((item) => {
        const value = item.getAttribute('value');
        if (value !== null && Number.isSafeInteger(Number(value))) position = Number(value);
        const type = element.getAttribute('type');
        const counter =
          /^(?:a|A)$/.test(type ?? '') && position >= 1 && position <= 26
            ? String.fromCharCode((type === 'a' ? 96 : 64) + position)
            : String(position);
        const label = element.tagName === 'UL' ? '•' : depth > 0 ? `(${counter})` : `${counter}.`;
        position += reversed ? -1 : 1;
        const text = Array.from(item.childNodes, (child) => walk(child, depth + 1))
          .join('')
          .trim();
        // Some HTML textbooks already display their exercise number inside the item.
        return `${'  '.repeat(depth)}${depth === 0 && findHeading(text.split('\n')[0]) ? text : `${label} ${text}`}`;
      });
      return `\n${lines.join('\n')}\n`;
    }
    const body = Array.from(node.childNodes, (child) => walk(child, depth)).join('');
    return blockHtml.has(element.tagName) ? `\n${body.trim()}\n` : body;
  }

  return Array.from(template.content.childNodes, (child) => walk(child, 0))
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const textbookPdfLimits = { fileBytes: 64 * 1024 * 1024, pages: 40 };

export async function readTextbookPdf(
  source: File | ArrayBuffer,
  range: { from: number; to: number },
): Promise<TextbookPage[]> {
  const size = source instanceof ArrayBuffer ? source.byteLength : source.size;
  if (size > textbookPdfLimits.fileBytes) throw new Error('Select a PDF under 64 MB.');
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 1 ||
    range.to < range.from
  ) {
    throw new Error('Enter a valid page range starting at page 1.');
  }
  if (range.to - range.from >= textbookPdfLimits.pages) throw new Error('Select at most 40 pages at a time.');

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
    throw new Error('The local PDF reader is unavailable in this browser. Try pasting the exercise text.');
  });
  // The worker can transfer its input buffer. Keep the caller's original bytes intact.
  const data = new Uint8Array(source instanceof ArrayBuffer ? source.slice(0) : await source.arrayBuffer());
  const worker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), {
    type: 'module',
  });
  const pdfWorker = pdfjs.PDFWorker.create({ port: worker });
  const task = pdfjs.getDocument({
    data,
    worker: pdfWorker,
    disableFontFace: true,
    fontExtraProperties: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const failure = new Promise<never>((_, reject) => {
    worker.addEventListener(
      'error',
      () => reject(new Error('The local PDF reader could not start. Try pasting the exercise text.')),
      { once: true },
    );
    timer = setTimeout(
      () => reject(new Error('PDF extraction timed out. Try a smaller page range.')),
      45_000,
    );
  });
  const decode = async () => {
    const document = await task.promise;
    if (range.to > document.numPages)
      throw new RangeError(`This PDF has ${document.numPages} pages. Select a range within the file.`);
    const pageLabels = await document.getPageLabels().catch(() => null);
    const pages: TextbookPage[] = [];
    for (let number = range.from; number <= range.to; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent({ disableNormalization: true });
      const items = content.items.filter((item) => 'str' in item);
      const lastIndex = items.findLastIndex((item) => item.str.trim());
      const last = items[lastIndex];
      const pageLabel = pageLabels?.[number - 1] || String(number);
      // Remove a matching page number only when it sits on a separate line in the bottom margin.
      if (last?.str.trim() === pageLabel && /^(?:\d+|[ivxlcdm]+)$/i.test(pageLabel)) {
        const viewport = page.getViewport({ scale: 1 });
        const [, footerY] = viewport.convertToViewportPoint(last.transform[4], last.transform[5]);
        const previousIndex = items.findLastIndex((item, index) => index < lastIndex && item.str.trim());
        const previous = items[previousIndex];
        const [, previousY] = previous
          ? viewport.convertToViewportPoint(previous.transform[4], previous.transform[5])
          : [0, 0];
        const detached =
          !previous ||
          (footerY - previousY >= Math.max(18, 2 * last.height) &&
            items.slice(previousIndex, lastIndex).some((item) => item.hasEOL));
        if (detached && footerY >= viewport.height * 0.85 && footerY <= viewport.height) {
          items.length = lastIndex;
        }
      }
      const text = items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
      // Fraction and radical bars, along with the original font names, come from the page operators.
      const operators = text.trim()
        ? await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE }).catch(() => undefined)
        : undefined;
      const rules = operators ? readPdfMathRules(operators, pdfjs.OPS) : [];
      const fonts = readPdfMathFonts(page, items);
      const extensionFonts = readPdfMathExtensionFonts(page, items);
      pages.push({ page: number, text, mathLines: reconstructPdfMath(items, rules, fonts, extensionFonts) });
      page.cleanup();
    }
    return pages;
  };
  try {
    const pages = await Promise.race([decode(), failure]);
    completed = true;
    return pages;
  } catch (error) {
    if (
      error instanceof RangeError ||
      (error instanceof Error && /^(?:PDF extraction timed out|The local PDF reader)/.test(error.message))
    )
      throw error;
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error('This PDF is password protected. Import an unlocked copy or paste the exercise text.');
    }
    throw new Error(
      'The selected PDF pages could not be read. Try a different text PDF or paste the exercise text.',
    );
  } finally {
    clearTimeout(timer);
    try {
      if (completed) await task.destroy();
      else void task.destroy().catch(() => {});
    } finally {
      pdfWorker.destroy();
      worker.terminate();
    }
  }
}
