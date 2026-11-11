import { describe, expect, it } from 'vitest';
import {
  arxivQuery,
  fetchRecentPapers,
  parseArxivFeed,
  parseArxivIdentifier,
  rankPaper,
} from '../../apps/worker/src/arxiv';

const entry = (id = '2611.00001v2', overrides = '') =>
  `<entry><id>http://arxiv.org/abs/${id}</id><title>  Strong\n persistence of ideals </title><summary>Monomial ideals and associated primes.</summary><author><name>Ada Researcher</name></author><category term="math.AC"/><published>2026-11-01T00:00:00Z</published><updated>2026-11-08T00:00:00Z</updated>${overrides}</entry>`;
const feed = (content: string, total = 1) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>${total}</opensearch:totalResults>${content}</feed>`;
describe('arXiv metadata ingestion', () => {
  it('normalizes legacy/modern identifiers without losing versions', () => {
    expect(parseArxivIdentifier('https://arxiv.org/abs/math/0309136v3')).toEqual({
      id: 'math/0309136',
      version: 3,
    });
    expect(parseArxivIdentifier('https://arxiv.org/pdf/2611.00001v2.pdf')).toEqual({
      id: '2611.00001',
      version: 2,
    });
    expect(() => parseArxivIdentifier('bad-id')).toThrow();
  });
  it('preserves source links, authors/categories and quarantines malformed entries', () => {
    const result = parseArxivFeed(feed(entry() + '<entry><id>bad</id></entry>', 2));
    expect(result.papers[0].title).toBe('Strong persistence of ideals');
    expect(result.papers[0].source_url).toBe('https://arxiv.org/abs/2611.00001');
    expect(result.papers[0].authors).toEqual(['Ada Researcher']);
    expect(result.quarantined).toHaveLength(1);
  });
  it('rejects malformed XML, entities and source error feeds', () => {
    expect(() => parseArxivFeed('<feed>')).toThrow('Malformed');
    expect(() => parseArxivFeed('<!DOCTYPE feed><feed/>')).toThrow('Unsafe');
    expect(() =>
      parseArxivFeed(
        feed('<entry><id>http://arxiv.org/api/errors#bad</id><summary>Invalid search</summary></entry>'),
      ),
    ).toThrow('arXiv API error');
  });
  it('gives transparent weighted matches and does not infer semantic relevance', () => {
    const paper = parseArxivFeed(feed(entry())).papers[0];
    const ranked = rankPaper(paper, [
      { subscription_type: 'category', subscription_value: 'math.AC', enabled: true, weight: 2 },
      { subscription_type: 'keyword', subscription_value: 'monomial', enabled: true },
      { subscription_type: 'author', subscription_value: 'Ada Researcher', enabled: true },
      { subscription_type: 'topic', subscription_value: 'unmatched', enabled: true },
    ]);
    expect(ranked.relevance_score).toBe(16);
    expect(ranked.match_reasons).toHaveLength(3);
    expect(
      arxivQuery([{ subscription_type: 'category', subscription_value: 'math.AC', enabled: true }]),
    ).toBe('cat:math.AC');
  });
  it('fetches through a rate-limit coordinator and deduplicates canonical versions', async () => {
    let coordinated = 0;
    const result = await fetchRecentPapers(
      [{ subscription_type: 'category', subscription_value: 'math.AC', enabled: true }],
      {
        now: new Date('2026-11-08T10:00:00Z'),
        fetch: async () => new Response(feed(entry() + entry('2611.00001v1'), 2)),
        withRateLimit: async (action) => {
          coordinated++;
          return action();
        },
      },
    );
    expect(coordinated).toBe(1);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].latest_version).toBe(2);
  });
  it('catches up beyond seven days after an ingestion outage', async () => {
    const old = entry()
      .replace('2026-11-01T00:00:00Z', '2026-10-19T00:00:00Z')
      .replace('2026-11-08T00:00:00Z', '2026-10-20T00:00:00Z');
    const subscriptions = [
      { subscription_type: 'category' as const, subscription_value: 'math.AC', enabled: true },
    ];
    const common = {
      now: new Date('2026-11-08T10:00:00Z'),
      fetch: async () => new Response(feed(old)),
      withRateLimit: async <T>(action: () => Promise<T>) => action(),
    };
    expect((await fetchRecentPapers(subscriptions, common)).papers).toHaveLength(0);
    expect(
      (await fetchRecentPapers(subscriptions, { ...common, since: new Date('2026-10-01T00:00:00Z') })).papers,
    ).toHaveLength(1);
  });
});
