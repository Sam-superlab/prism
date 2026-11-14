import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateReviewDrafts,
  ReviewDraftProviderError,
} from '../../packages/core/src/review-draft-provider';

const note = {
  knowledge_id: 'local-source-id',
  title: 'Prime ideal',
  content: String.raw`If $ab \in P$, then $a \in P$ or $b \in P$.`,
};
const card = {
  card_type: 'statement',
  prompt: 'What implication must hold for a prime ideal?',
  answer: note.content,
};

function completed(groups: unknown) {
  return Response.json({
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ notes: groups }) }],
      },
    ],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI review draft transport', () => {
  it('keeps source IDs local and maps structured drafts to their source notes', async () => {
    const fetch = vi.fn().mockResolvedValue(completed([{ index: 0, cards: [card] }]));
    vi.stubGlobal('fetch', fetch);
    const drafts = await generateReviewDrafts([note], 'synthetic-test-token');
    expect(drafts).toEqual([{ knowledge_id: note.knowledge_id, cards: [card] }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request.redirect).toBe('error');
    expect(request.body).not.toContain(note.knowledge_id);
    expect(JSON.parse(request.body)).toMatchObject({
      store: false,
      max_output_tokens: 2000,
      text: { format: { type: 'json_schema', strict: true } },
    });
  });

  it.each([
    ['credit_balance_exhausted', true],
    ['insufficient_quota', true],
    ['rate_limit_exceeded', false],
  ])('handles 429 %s without retrying or propagating response content', async (code, pause) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: { code, message: note.content } }, { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    await expect(generateReviewDrafts([note], 'synthetic-test-token')).rejects.toMatchObject({ pause });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects drafts assigned to an unknown source note', async () => {
    const fetch = vi.fn().mockResolvedValue(completed([{ index: 1, cards: [card] }]));
    vi.stubGlobal('fetch', fetch);
    await expect(generateReviewDrafts([note], 'synthetic-test-token')).rejects.toBeInstanceOf(
      ReviewDraftProviderError,
    );
  });
});
