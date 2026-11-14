import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../../packages/database/src/index';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { validateApiResponse } from '../../apps/api/src/contract';

const day = '2026-09-03';
const nextDay = '2026-09-04';
const endpoint = '/today/review-drafts';
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;

async function openApp(enabled: boolean) {
  app = await buildApp({
    db,
    config: loadConfig({
      PRISM_AUTH_MODE: 'development',
      NEXT_PUBLIC_PRISM_AI_REVIEW_DRAFTS: enabled ? 'true' : undefined,
      PRISM_AI_PROMO_ONLY: enabled ? 'true' : undefined,
      OPENAI_API_KEY: 'local-mock-key',
    }),
  });
}

const post = (path: string, payload: object, key = randomUUID()) =>
  app.inject({ method: 'POST', url: '/api/v1' + path, headers: { 'Idempotency-Key': key }, payload });
const get = (path: string) => app.inject({ method: 'GET', url: '/api/v1' + path });

async function note(title: string, date: string, tags: string[]) {
  const id = randomUUID();
  const created = await post('/knowledge-items', {
    id,
    title,
    tags,
    type: 'note',
    content: 'A ring has an additive identity.\n![image](/knowledge-sources/private.pdf)',
    proof_content: 'Not part of the selected plain-text source.',
  });
  expect(created.statusCode).toBe(201);
  await db.transaction(app.prism.config.userId, (sql) =>
    sql.query('UPDATE knowledge_items SET created_at=$2 WHERE id=$1', [id, date + 'T12:00:00Z']),
  );
  return id;
}

function cardsResponse() {
  const result = {
    notes: [
      {
        index: 0,
        cards: [
          {
            card_type: 'statement',
            prompt: 'What identity does a ring have under addition?',
            answer: 'An additive identity.',
          },
        ],
      },
    ],
  };
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  });
}

beforeEach(async () => {
  vi.setSystemTime(new Date(nextDay + 'T12:00:00Z'));
  db = await createDatabase({ memory: true });
});

afterEach(async () => {
  await app?.close();
  await db?.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('daily AI review drafts', () => {
  it('requires billing opt-in and only sends the marked prior-day text once', async () => {
    const provider = vi.fn(async () => cardsResponse());
    vi.stubGlobal('fetch', provider);
    await openApp(false);
    const id = await note('Share this note', day, ['ai-review']);
    await note('Private unmarked note', day, []);
    await note('Old marked note', '2026-09-02', ['ai-review']);
    expect((await post(endpoint, { date: day })).json().status).toBe('disabled');
    expect(provider).not.toHaveBeenCalled();
    await app.close();
    await openApp(true);

    const [first, second] = await Promise.all([post(endpoint, { date: day }), post(endpoint, { date: day })]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    const request = provider.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe('https://api.openai.com/v1/responses');
    const sent = JSON.parse(String(request[1].body));
    expect(JSON.parse(sent.input)).toEqual({
      notes: [{ index: 0, title: 'Share this note', content: 'A ring has an additive identity.' }],
    });

    const result = await get(endpoint + '?date=' + day);
    expect(await validateApiResponse('GET', endpoint, result.statusCode, result.json())).toEqual([]);
    const batch = result.json();
    expect(batch.status).toBe('ready');
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].knowledge_id).toBe(id);
    const card = batch.items[0].cards[0];
    expect((await post(`/knowledge-items/${id}/cards/batch`, { cards: [card] }, card.id)).statusCode).toBe(
      201,
    );
    expect((await get(endpoint + '?date=' + day)).json()).toEqual({ date: day, status: 'ready', items: [] });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('keeps quota pause across local days and failed explicit retries', async () => {
    const provider = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'credit_balance_exhausted' } }, { status: 429 }))
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(cardsResponse());
    vi.stubGlobal('fetch', provider);
    await openApp(true);
    await note('First opt-in note', day, ['ai-review']);
    await note('Next opt-in note', nextDay, ['ai-review']);
    expect((await post(endpoint, { date: day })).json().status).toBe('paused');

    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
    expect((await get(endpoint + '?date=' + nextDay)).json().status).toBe('paused');
    expect((await post(endpoint, { date: nextDay })).json().status).toBe('paused');
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await post(endpoint, { date: nextDay, retry: true })).json().status).toBe('paused');
    expect((await post(endpoint, { date: nextDay })).json().status).toBe('paused');
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await post(endpoint, { date: nextDay, retry: true })).json().status).toBe('ready');
    expect(provider).toHaveBeenCalledTimes(3);
  });
});
