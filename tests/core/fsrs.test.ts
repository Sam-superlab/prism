import { describe, expect, it } from 'vitest';
import { createCard, getRetrievability, reviewCard, schedulerConfig } from '../../packages/fsrs/src/index';

describe('versioned real FSRS adapter', () => {
  it('persists all model fields and independently schedules each card', async () => {
    const now = '2026-11-08T10:00:00Z';
    const statement = await createCard(now),
      proof = await createCard(now);
    const before = structuredClone(statement);
    const proofBefore = structuredClone(proof);
    const result = await reviewCard({ state: statement, rating: 'good', reviewedAt: now });
    expect(statement).toEqual(before);
    expect(proof).toEqual(proofBefore);
    expect(result.reviewCount).toBe(1);
    expect(Date.parse(result.dueAt)).toBeGreaterThan(Date.parse(now));
    expect(result.state).toHaveProperty('stabilityFast');
    expect((await schedulerConfig()).model_version).toBe('FSRS-7');
    expect((await schedulerConfig()).parameters.weights.length).toBeGreaterThan(0);
  });
  it('replays deterministically with fuzz disabled and bounds retrievability', async () => {
    const now = '2026-11-08T10:00:00Z',
      state = await createCard(now);
    const input = { state, rating: 'easy' as const, reviewedAt: now };
    expect(await reviewCard(input)).toEqual(await reviewCard(input));
    const reviewed = await reviewCard(input);
    const r = await getRetrievability(reviewed.state, '2026-11-10T10:00:00Z');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
    expect(await getRetrievability(state, now)).toBeNull();
  });
  it('records all four ratings and requires explicit algorithm migration', async () => {
    const now = '2026-11-08T10:00:00Z',
      state = await createCard(now);
    for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
      expect((await reviewCard({ state, rating, reviewedAt: now })).reviewCount).toBe(1);
    }
    await expect(createCard(now, { model_version: 'FSRS-6' })).rejects.toThrow('migration');
  });
});
