import { describe, expect, it } from 'vitest';
import { extractTextbookExercises } from '../../apps/web/lib/textbook-extraction';

describe('textbook exercise extraction', () => {
  it('preserves labels, exact excerpts, subparts, and source page ranges', () => {
    const result = extractTextbookExercises([
      {
        page: 42,
        text: '2.3. Groups\nSection 2.3 Exercises\nExercise 2.3.1. Prove the claim.\n(a) Find $e$.\n2.3.2. Construct an example of',
      },
      {
        page: 43,
        text: 'a subgroup of $G$.\n  1) Name the subgroup.\nSolutions to exercises\nExercise 2.3.1. The answer is ...',
      },
    ]);
    expect(result.exercises).toEqual([
      {
        number: '2.3.1',
        text: 'Prove the claim.\n(a) Find $e$.',
        original: 'Exercise 2.3.1. Prove the claim.\n(a) Find $e$.',
        fromPage: 42,
        toPage: 42,
        uncertain: false,
      },
      {
        number: '2.3.2',
        text: 'Construct an example of\na subgroup of $G$.\n  1) Name the subgroup.',
        original: '2.3.2. Construct an example of\na subgroup of $G$.\n  1) Name the subgroup.',
        fromPage: 42,
        toPage: 43,
        uncertain: false,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('reports pages without selectable text and flags missing visual context', () => {
    const result = extractTextbookExercises([
      { page: 1, text: 'Exercises\n1. Find the area in [Image omitted; consult source].' },
      { page: 2, text: '' },
      { page: 3, text: '2. Compare [Formula omitted; consult source].' },
    ]);
    expect(result.exercises.map(({ uncertain }) => uncertain)).toEqual([true, true]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Page 2 has no selectable text')]),
    );
  });

  it('reports empty selections rather than fabricating exercises', () => {
    const result = extractTextbookExercises([{ page: 7, text: 'A group is a set with an operation.' }]);
    expect(result.exercises).toEqual([]);
    expect(result.warnings[0]).toMatch(/no numbered exercises/i);
  });
});
