import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';

export type PdfMathFont = 'mathbb' | 'mathcal' | 'mathscr' | 'ambiguous';

function classifyFontName(name: string): PdfMathFont | undefined {
  // Embedded subset names start with a six-letter tag followed by "+".
  const family = name
    .replace(/^[A-Z]{6}\+/, '')
    .toLowerCase()
    .replace(/[^a-z\d]/g, '');
  const blackboard =
    /blackboardbold|doublestruck|mathbb/.test(family) ||
    /^(?:msbm|bbm|bbold|dsrom)\d*(?:regular|medium|bold)?$/.test(family);
  const calligraphic =
    /mathcal/.test(family) || /^(?:(?:cm|lm)sy|lmmathsymbols)\d*(?:regular)?$/.test(family);
  const script = /mathscr/.test(family) || /^(?:rsfs|boondoxscr)\d*(?:regular)?$/.test(family);
  const matches = [blackboard, calligraphic, script].filter(Boolean).length;
  if (matches === 1) return blackboard ? 'mathbb' : calligraphic ? 'mathcal' : 'mathscr';
  if (matches > 1 || /blackboard|calligraph|script|chancery|^eus[mb]\d|^cmbsy\d/.test(family)) {
    return 'ambiguous';
  }
}

export function readPdfMathFonts(page: PDFPageProxy, items: readonly TextItem[]): Map<string, PdfMathFont> {
  const styles = new Map<string, PdfMathFont>();
  // getOperatorList resolves the fonts in commonObjs. fontExtraProperties supplies their original names.
  const fontIds = new Set(items.filter((item) => item.str.trim()).map((item) => item.fontName));
  for (const id of fontIds) {
    if (!page.commonObjs.has(id)) continue;
    const font: unknown = page.commonObjs.get(id);
    if (!font || typeof font !== 'object' || !('name' in font) || typeof font.name !== 'string') continue;
    const style = classifyFontName(font.name);
    if (style) styles.set(id, style);
  }
  return styles;
}
