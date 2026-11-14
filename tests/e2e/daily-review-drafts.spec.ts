import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectMarkdownSource } from './markdown-source';

const today = '2040-11-10';
const yesterday = '2040-11-09';
const earlier = '2040-11-08';
const draftsPath = /\/api\/v1\/today\/review-drafts(?:\?|$)/;

test('automatically prepares yesterday’s opted-in notes and saves only an approved draft', async ({
  page,
  request,
  baseURL,
}) => {
  const knowledgeId = randomUUID();
  const draftId = randomUUID();
  const title = 'Algebra note for review drafts';
  const prompt = 'What is the additive identity?';
  const answer = 'It is $0$.';
  const knowledgePath = `/api/v1/knowledge-items/${knowledgeId}`;
  const created = await request.post('/api/v1/knowledge-items', {
    headers: { Origin: baseURL!, 'Idempotency-Key': knowledgeId },
    data: { id: knowledgeId, title, type: 'note', content: 'The additive identity is $0$.' },
  });
  expect(created.status()).toBe(201);
  await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));

  await page.goto(`/knowledge/${knowledgeId}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const noteEditor = page.getByRole('dialog');
  const inclusion = noteEditor.getByRole('checkbox', { name: 'Include this note in AI review drafts' });
  await expect(inclusion).not.toBeChecked();
  await inclusion.check();
  await noteEditor.getByRole('button', { name: 'Save knowledge' }).click();
  await expect(noteEditor).toBeHidden();
  expect((await (await request.get(knowledgePath)).json()).tags).toContain('ai-review');

  const pending = {
    knowledge_id: knowledgeId,
    title,
    cards: [{ id: draftId, card_type: 'statement', prompt, answer }],
  };
  let runs = 0;
  const earlierPrompt = 'Recall an older definition.';
  await page.route(draftsPath, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ date: yesterday, retry: false });
      runs++;
    } else {
      const date = new URL(route.request().url()).searchParams.get('date');
      if (date === earlier) {
        await route.fulfill({
          json: {
            date,
            status: 'ready',
            items: [
              { ...pending, cards: [{ ...pending.cards[0], id: randomUUID(), prompt: earlierPrompt }] },
            ],
          },
        });
        return;
      }
      expect(date).toBe(yesterday);
    }
    const { items } = await (await request.get(`${knowledgePath}/cards`)).json();
    await route.fulfill({
      json: {
        date: yesterday,
        status: runs ? 'ready' : 'idle',
        items: runs && !items.length ? [pending] : [],
      },
    });
  });

  await page.goto('/today');
  const reviewDrafts = page.getByRole('region', { name: 'AI review drafts' });
  await expect(reviewDrafts.getByText(prompt)).toBeVisible();
  expect((await (await request.get(`${knowledgePath}/cards`)).json()).items).toEqual([]);
  await reviewDrafts.getByRole('button', { name: 'Review draft' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Markdown source for Answer', exact: true }).click();
  await expectMarkdownSource(editor.getByLabel('Answer', { exact: true }), answer);
  const editedAnswer = 'It is the unique element $0$ satisfying $0+x=x$.';
  await editor.getByLabel('Answer', { exact: true }).fill(editedAnswer);
  await editor.getByRole('button', { name: 'Add to review queue' }).click();
  await expect(reviewDrafts.getByText('Review card saved.')).toBeVisible();
  expect((await (await request.get(`${knowledgePath}/cards`)).json()).items).toEqual([
    expect.objectContaining({ id: draftId, answer: editedAnswer }),
  ]);

  await page.reload();
  await expect(reviewDrafts.getByText('There are no drafts waiting for review.')).toBeVisible();
  await reviewDrafts.getByLabel('Draft date').fill(earlier);
  await expect(reviewDrafts.getByText(earlierPrompt)).toBeVisible();
  expect(runs).toBe(1);
});

test('a paused batch only retries after an explicit action', async ({ page }) => {
  await page.clock.setFixedTime(new Date(`${today}T12:00:00Z`));
  let retried = false;
  await page.route(draftsPath, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ date: yesterday, retry: true });
      retried = true;
    }
    await route.fulfill({
      json: {
        date: yesterday,
        status: retried ? 'ready' : 'paused',
        items: [],
        ...(retried ? {} : { message: 'Review drafting is paused.' }),
      },
    });
  });

  await page.goto('/today');
  const reviewDrafts = page.getByRole('region', { name: 'AI review drafts' });
  await expect(reviewDrafts.getByText('Review drafting is paused.')).toBeVisible();
  expect(retried).toBe(false);
  await reviewDrafts.getByRole('button', { name: 'Retry after checking credits' }).click();
  await expect(reviewDrafts.getByText('There are no drafts waiting for review.')).toBeVisible();
  expect(retried).toBe(true);
});
