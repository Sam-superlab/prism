import { describe, expect, it } from 'vitest';
import { literatureSpeechChunks } from '../../apps/web/lib/literature-read-aloud';

describe('literature read aloud chunks', () => {
  it('retains paragraph indices and readable prose around displayed equations', () => {
    expect(literatureSpeechChunks([
      '',
      'The next identity is useful.\nx² + y ∈ R[x,y]\nIt appears throughout the proof.',
      '$$\n\\frac{1}{2} = 0.5\n$$',
      'The assignment a = b respects the grading.',
      'Let x = 2.',
      '関数 f(x) = x について述べる。',
      'A = B',
    ])).toEqual([
      { paragraphIndex: 1, text: 'The next identity is useful. It appears throughout the proof.' },
      { paragraphIndex: 3, text: 'The assignment a = b respects the grading.' },
      { paragraphIndex: 4, text: 'Let x = 2.' },
      { paragraphIndex: 5, text: '関数 f(x) = x について述べる。' },
    ]);
  });

  it('batches sentences without carrying speech across paragraphs', () => {
    const sentence = 'An ideal contains elements that respect ring multiplication.';
    const first = Array.from({ length: 12 }, () => sentence).join(' ');
    const chunks = literatureSpeechChunks([first, 'Next paragraph.'], 'en');
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length <= 300)).toBe(true);
    expect(chunks.filter((chunk) => chunk.paragraphIndex === 0).map((chunk) => chunk.text).join(' ')).toBe(first);
    expect(chunks.at(-1)).toEqual({ paragraphIndex: 1, text: 'Next paragraph.' });
  });

  it('caps long text without spaces or splitting Unicode surrogate pairs', () => {
    const source = 'A' + '𝕜'.repeat(201);
    const chunks = literatureSpeechChunks([source], 'invalid_locale');
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(source);
    expect(chunks.every((chunk) => chunk.text.length <= 300 && chunk.text.isWellFormed())).toBe(true);
  });
});
