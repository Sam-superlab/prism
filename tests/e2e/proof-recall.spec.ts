import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('proof hints reveal in order and a stuck step survives in review history', async ({
  page,
  request,
  baseURL,
}) => {
  const duplicateKeyErrors: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Encountered two children with the same key')) duplicateKeyErrors.push(message.text());
  });
  const id = randomUUID();
  const notePath = `/api/v1/knowledge-items/${id}`;
  const created = await request.post('/api/v1/knowledge-items', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: {
      id,
      title: 'Subgroup intersections',
      type: 'theorem',
      subject: 'Proof Recall E2E',
      content: 'The intersection of two subgroups is a subgroup.',
      proof_content: 'Use the one-step subgroup criterion for the intersection.',
    },
  });
  expect(created.status()).toBe(201);

  try {
    await page.goto(`/knowledge/${id}`);
    await page.getByRole('button', { name: 'Add card', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Review focus').selectOption('proof');
    await editor.getByRole('button', { name: 'Markdown source for Prompt', exact: true }).click();
    await editor.getByLabel('Prompt', { exact: true }).fill('Prove the subgroup intersection theorem.');
    await editor.getByRole('button', { name: 'Add a proof step' }).click();
    await editor.getByLabel('Hint for step 1', { exact: true }).fill('Check that the identity is in both subgroups.');
    await editor.getByRole('button', { name: 'Add a proof step' }).click();
    await editor.getByLabel('Hint for step 2', { exact: true }).fill('Check closure of the intersection under $ab^{-1}$.');
    await editor.getByRole('button', { name: 'Save card', exact: true }).click();
    await page.getByRole('link', { name: 'Practice proof' }).click();

    const recall = page.getByRole('region', { name: 'Proof Recall' });
    const card = page.locator('main:not([hidden]) .recall-card');
    await expect(card.getByText('Prove the subgroup intersection theorem.', { exact: true })).toHaveCount(1);
    await expect(card.getByRole('textbox')).toHaveCount(1);
    await card.getByRole('textbox', { name: 'Your proof outline', exact: true }).fill('Use the subgroup criterion.');
    await expect(recall.getByRole('list', { name: 'Proof hints' })).toBeHidden();
    expect(duplicateKeyErrors).toEqual([]);
    await recall.getByRole('button', { name: 'Reveal first hint' }).click();
    await expect(recall.getByText('Check that the identity is in both subgroups.')).toBeVisible();
    await expect(recall.getByText('Check closure of the intersection', { exact: false })).toBeHidden();
    await recall.getByRole('button', { name: 'Reveal next hint' }).click();
    await expect(recall.locator('.katex')).toBeVisible();
    await recall.getByRole('checkbox', { name: 'Mark step 2 as stuck' }).check();
    await expect(page.locator('.recall-answer')).toBeHidden();
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await expect(card.getByText('Prove the subgroup intersection theorem.', { exact: true })).toHaveCount(1);
    await expect(page.locator('.recall-answer')).toContainText('Use the one-step subgroup criterion');
    await page.getByRole('button', { name: /Hard.*Recalled with difficulty/ }).click();
    await expect(page.getByRole('heading', { name: 'Next review' })).toBeVisible();

    await page.goto(`/knowledge/${id}`);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'Review history' });
    await history.getByText('Stuck on 1 step', { exact: true }).click();
    await expect(history.getByText('Check closure of the intersection', { exact: false })).toBeVisible();
    await expect(history.getByText('Check that the identity is in both subgroups.')).toBeHidden();
  } finally {
    const item = await (await request.get(notePath)).json();
    await request.delete(notePath, {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${item.version}"` },
    });
  }
});

test('revealing an identical reference answer keeps the prompt visible only once', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const cardId = randomUUID();
  const notePath = `/api/v1/knowledge-items/${id}`;
  const statement = 'The intersection of two subgroups is a subgroup.';
  const created = await request.post('/api/v1/knowledge-items', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title: 'Identical prompt and answer', type: 'theorem', content: statement },
  });
  expect(created.status()).toBe(201);

  try {
    const card = await request.post(`${notePath}/cards`, {
      headers: { Origin: baseURL!, 'Idempotency-Key': cardId },
      data: { id: cardId, card_type: 'statement', prompt: statement, answer: statement },
    });
    expect(card.status()).toBe(201);
    await page.goto(`/review/session?card=${cardId}`);
    const review = page.locator('main:not([hidden]) .recall-card');
    await expect(review.getByText(statement, { exact: true })).toHaveCount(1);
    await review.getByRole('button', { name: 'Reveal answer' }).click();
    await expect(review.getByText('The reference answer matches the prompt above.')).toBeVisible();
    await expect(review.getByText(statement, { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Good/ })).toBeEnabled();
  } finally {
    const item = await (await request.get(notePath)).json();
    await request.delete(notePath, {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${item.version}"` },
    });
  }
});
