export type LiteratureSpeechChunk = { paragraphIndex: number; text: string };

const chunkLimit = 300;
const mathSymbol = /[=≈≠≤≥∫∑∏√∈∉⇒⇔∀∃∂∞⊆⊂×÷^_]|\s[+−-]\s|\\(?:frac|sqrt|sum|int|begin)\b/u;
const proseStart = /^(?:a|an|as|assume|for|given|hence|if|in|let|note|since|so|suppose|then|thus|the|this|where|with)\s+\p{L}/iu;
const eastAsianProse = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u;

function isDisplayFormula(line: string) {
  if (/^(?:\$\$[\s\S]+\$\$|\\\[[\s\S]+\\\])$/u.test(line)) return true;
  if (!mathSymbol.test(line) || proseStart.test(line) || eastAsianProse.test(line))
    return false;
  const content = line.replace(/\\[a-z]+/giu, ' ');
  const words = content.match(/\p{L}{3,}/gu) ?? [];
  return words.length < 2;
}

function spokenParagraph(paragraph: string) {
  const lines = paragraph.split(/\r\n?|\n/u);
  let closingFence: string | undefined;
  return lines.flatMap((rawLine, index) => {
    const line = rawLine.trim();
    if (closingFence) {
      if (line === closingFence) closingFence = undefined;
      return [];
    }
    if (line === '$$' || line === '\\[') {
      const end = line === '$$' ? '$$' : '\\]';
      if (lines.slice(index + 1).some((candidate) => candidate.trim() === end)) {
        closingFence = end;
        return [];
      }
    }
    return !line || isDisplayFormula(line) ? [] : [line];
  }).join(' ').replace(/\s+/gu, ' ');
}

function sentenceSegmenter(locale?: string) {
  if (typeof Intl.Segmenter !== 'function') return;
  try {
    return new Intl.Segmenter(locale, { granularity: 'sentence' });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }
}

function splitLongSentence(sentence: string) {
  const parts: string[] = [];
  while (sentence.length > chunkLimit) {
    const boundary = sentence.lastIndexOf(' ', chunkLimit);
    let cut = boundary > 0 ? boundary : chunkLimit;
    // A hard split must leave both halves of a surrogate pair in the same chunk.
    if (cut === chunkLimit && /[\uDC00-\uDFFF]/u.test(sentence[cut])) cut--;
    parts.push(sentence.slice(0, cut));
    sentence = sentence.slice(cut).trimStart();
  }
  if (sentence) parts.push(sentence);
  return parts;
}

export function literatureSpeechChunks(
  paragraphs: readonly string[],
  locale?: string,
): LiteratureSpeechChunk[] {
  const segmenter = sentenceSegmenter(locale);
  return paragraphs.flatMap((paragraph, paragraphIndex) => {
    const text = spokenParagraph(paragraph);
    if (!text) return [];
    const segments = segmenter
      ? Array.from(segmenter.segment(text), ({ segment }) => segment)
      : text.split(/(?<=[.!?。！？])\s+/u);
    const chunks: LiteratureSpeechChunk[] = [];
    let pending = '';
    for (const part of segments.flatMap((sentence) => splitLongSentence(sentence.trim()))) {
      const joined = pending ? pending + ' ' + part : part;
      if (pending && joined.length > chunkLimit) {
        chunks.push({ paragraphIndex, text: pending });
        pending = part;
      } else pending = joined;
    }
    if (pending) chunks.push({ paragraphIndex, text: pending });
    return chunks;
  });
}
