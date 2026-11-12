import { describe, expect, it } from 'vitest';
import {
  buildArxivDeck,
  type ArxivDeckCandidate,
  type ArxivDeckFeedback,
} from '../../packages/core/src/arxiv-for-you';

const now = '2026-11-09T12:00:00Z';
const old = '2026-08-11T12:00:00Z';

function paper(id: string, title: string, rest: Partial<ArxivDeckCandidate> = {}): ArxivDeckCandidate {
  return {
    paper_id: id,
    title,
    abstract: '',
    categories: [],
    updated_at: now,
    subscription_score: 0,
    ...rest,
  };
}

function action(
  id: string,
  title: string,
  reaction: ArxivDeckFeedback['reaction'],
  rest: Partial<ArxivDeckFeedback> = {},
): ArxivDeckFeedback {
  return { paper_id: id, title, abstract: '', reaction, is_saved: false, updated_at: now, ...rest };
}

const deck = (input: Partial<Parameters<typeof buildArxivDeck>[0]>) =>
  buildArxivDeck({ candidates: [], feedback: [], keywords: [], now, seed: '2026-11-09', ...input });

describe('arXiv For You deck', () => {
  it('favors followed title phrases, respects phrase boundaries, and penalizes Show less', () => {
    const result = deck({
      candidates: [
        paper('title', 'Tropical curves and intersection theory'),
        paper('abstract', 'Local degenerations', { abstract: 'We study tropical curves.' }),
        paper('partial', 'Pseudotropical curves'),
        paper('less', 'Tropical curves in computational geometry'),
      ],
      keywords: [
        { term: 'Tropical-curves', mode: 'follow' },
        { term: 'computational geometry', mode: 'less' },
      ],
    });
    expect(result.items.map(({ paper_id }) => paper_id)).toEqual(['title', 'abstract', 'partial', 'less']);
    expect(result.items[0].reason).toContain('Tropical-curves');
    expect(result.items[2].reason).not.toContain('Tropical-curves');
  });

  it('learns strongest from saving, then liking, then expressing interest', () => {
    const feedback = [
      action('history-1', 'Monomial ideals', null, { is_saved: true }),
      action('history-2', 'Modular forms', 'liked'),
      action('history-3', 'Floer homology', 'interested'),
    ];
    const result = deck({
      candidates: [
        paper('new-interest', 'Floer homology for braid groups', { updated_at: old }),
        paper('new-like', 'Modular forms in positive characteristic', { updated_at: old }),
        paper('new-save', 'Monomial ideals of graphs', { updated_at: old }),
      ],
      feedback,
    });
    expect(result.items.map(({ paper_id }) => paper_id)).toEqual(['new-save', 'new-like', 'new-interest']);
    expect(result.items[0].reason).toContain('monomial ideals');
    expect(result.suggestions).toEqual([]);
  });

  it('decays older actions and treats a skip as neutral', () => {
    const candidates = [
      paper('former', 'Graph ideals of paths'),
      paper('recent', 'Modular forms with complex multiplication'),
      paper('unseen', 'Random walks on expanders'),
    ];
    const feedback = [
      action('past-save', 'Graph ideals', null, { is_saved: true, updated_at: old }),
      action('present-interest', 'Modular forms', 'interested'),
    ];
    const withoutSkip = deck({ candidates, feedback });
    expect(withoutSkip.items[0].paper_id).toBe('recent');
    expect(deck({ candidates, feedback: [...feedback, action('skipped', 'Random walks', 'skip')] })).toEqual(
      withoutSkip,
    );
  });

  it('excludes an exact rejection and demotes related results without learning them as interests', () => {
    const candidates = [
      paper('rejected', 'Nonlinear optics for waveguides'),
      paper('related', 'Nonlinear optics of nanophotonic devices'),
      paper('neutral', 'The geometry of moduli spaces'),
    ];
    const result = deck({
      candidates,
      feedback: [action('rejected', candidates[0].title, 'not_interested')],
    });
    expect(result.items.map(({ paper_id }) => paper_id)).toEqual(['neutral', 'related']);
    expect(result.suggestions).toEqual([]);
  });

  it('ranks research matches without overriding rejection or recommending a linked paper from itself', () => {
    const rejected = paper('rejected', 'Groebner bases and generating functions');
    const result = deck({
      candidates: [
        paper('neutral', 'Generating functions in combinatorics'),
        paper('match', 'Computing Groebner bases'),
        paper('linked', 'Persistent homology'),
        rejected,
      ],
      feedback: [action(rejected.paper_id, rejected.title, 'not_interested')],
      research: [
        {
          project_title: 'Local algebra',
          headings: ['Gröbner basis', 'group'],
          excerpts: [],
          paper_id: null,
        },
        {
          project_title: 'Topology',
          headings: ['Persistent homology'],
          excerpts: [],
          paper_id: 'linked',
        },
      ],
    });
    expect(result.items[0]).toMatchObject({
      paper_id: 'match',
      reason: 'Matches research project “Local algebra” on “Gröbner basis”.',
    });
    expect(result.items.map(({ paper_id }) => paper_id)).not.toContain('rejected');
    expect(result.items.find(({ paper_id }) => paper_id === 'linked')?.reason).not.toContain('Topology');
  });

  it('keeps four strong picks, then a different followed topic and a seeded subscribed wildcard', () => {
    const candidates = [
      paper('a', 'Monomial ideals of chordal graphs', { categories: ['math.AC'], subscription_score: 10 }),
      paper('b', 'Monomial ideals and symbolic powers', { categories: ['math.AC'], subscription_score: 10 }),
      paper('c', 'Monomial ideals in exterior algebras', { categories: ['math.AC'], subscription_score: 10 }),
      paper('d', 'Monomial ideals of affine semigroups', { categories: ['math.AC'], subscription_score: 10 }),
      paper('alternate', 'Tropical curves in toric surfaces', {
        categories: ['math.AG'],
        subscription_score: 2,
        updated_at: old,
      }),
      paper('wild-1', 'Étale cohomology and number fields', {
        categories: ['math.NT'],
        subscription_score: 2,
      }),
      paper('wild-2', 'Equivariant stable homotopy', { categories: ['math.AT'], subscription_score: 2 }),
      paper('unsubscribed', 'Symplectic embeddings', { categories: ['math.SG'] }),
    ];
    const input = {
      candidates,
      keywords: [
        { term: 'monomial ideals', mode: 'follow' },
        { term: 'tropical curves', mode: 'follow' },
      ] as const,
    };
    const result = deck(input);
    expect(result.items.slice(0, 4).map(({ paper_id }) => paper_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.items[4]).toMatchObject({
      paper_id: 'alternate',
      reason: expect.stringContaining('tropical curves'),
    });
    expect(['wild-1', 'wild-2']).toContain(result.items[5].paper_id);
    expect(result.items[5].reason).toContain('wildcard');
    expect(deck({ ...input, candidates: [...candidates].reverse() })).toEqual(result);
    const wildcards = new Set(
      Array.from({ length: 24 }, (_, i) => deck({ ...input, seed: i }).items[5].paper_id),
    );
    expect(wildcards.size).toBeGreaterThan(1);
  });

  it('suppresses near duplicates without dropping unrelated papers with no category', () => {
    const result = deck({
      candidates: [
        paper('original', 'Derived categories of algebraic toric varieties'),
        paper('duplicate', 'A note on derived categories of algebraic toric varieties'),
        paper('unrelated', 'Noncommutative Gröbner bases and regular sequences'),
        paper('missing-date', 'Quantum invariants of knots', { updated_at: '' }),
      ],
    });
    expect(result.items).toHaveLength(3);
    expect(result.items.filter(({ paper_id }) => ['original', 'duplicate'].includes(paper_id))).toHaveLength(
      1,
    );
    expect(result.items.map(({ paper_id }) => paper_id)).toContain('missing-date');
    expect(result.items.every(({ reason }) => reason.length > 0)).toBe(true);
  });

  it('suggests recurring mathematical terms without suggesting generic phrases or duplicating manual rules', () => {
    const result = deck({
      feedback: [
        action('saved', 'New bounds for monomial ideals and Betti numbers', null, { is_saved: true }),
        action('saved-2', 'New bounds for monomial ideals and Betti numbers', null, { is_saved: true }),
        action('liked', 'New bounds for modular forms', 'liked'),
        action('interested', 'A modular form and spectral sequences', 'interested'),
        action('interested', 'A modular form and spectral sequences', 'interested'),
      ],
      keywords: [
        { term: 'Monomial ideals', mode: 'follow' },
        { term: 'betti number', mode: 'less' },
      ],
    });
    expect(result.suggestions).toEqual(['modular form']);
  });

  it('combines spelling aliases in suggestions and honors the followed term across spellings', () => {
    const feedback = [
      action('liked', 'Gröbner bases for toric ideals', 'liked'),
      action('interested', 'Computing Groebner bases', 'interested'),
    ];
    expect(deck({ feedback }).suggestions).toEqual(['Gröbner basis']);
    expect(deck({ feedback, keywords: [{ term: 'Grobner basis', mode: 'follow' }] }).suggestions).toEqual([]);
    const result = deck({
      candidates: [paper('matched', 'Computing Groebner bases'), paper('other', 'Quiver representations')],
      keywords: [{ term: 'Gröbner basis', mode: 'follow' }],
    });
    expect(result.items[0]).toMatchObject({
      paper_id: 'matched',
      reason: expect.stringContaining('Gröbner basis'),
    });
  });

  it('uses indexed EoM article titles, combining plurals while requiring stronger evidence for broad words', () => {
    const feedback = [
      action('liked', 'A Galois group with a new factor', 'liked', {
        abstract: 'A discussion of Hodge structures.',
      }),
      action('interested', 'Galois groups and the main factor', 'interested', {
        abstract: 'We use a Hodge structure.',
      }),
    ];
    expect(deck({ feedback }).suggestions).toEqual(['Galois group']);
    expect(deck({ feedback, keywords: [{ term: 'Galois groups', mode: 'less' }] }).suggestions).toEqual([]);
    expect(
      deck({
        feedback: [
          ...feedback,
          action('third', 'A study in topology', 'liked', { abstract: 'We use a Hodge structure.' }),
        ],
      }).suggestions,
    ).toContain('Hodge structure');
  });
});
