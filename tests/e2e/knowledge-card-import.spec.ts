import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('pastes Markdown into review cards and preserves the prompt and answer', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const path = `/api/v1/knowledge-items/${id}`;
  const headers = { Origin: baseURL!, 'Idempotency-Key': id };
  const created = await request.post('/api/v1/knowledge-items', {
    headers,
    data: { id, title: 'Markdown card import fixture', type: 'definition', content: 'Example definition.' },
  });
  expect(created.status()).toBe(201);
  try {
    await page.goto(`/knowledge/${id}`);
    await page.getByRole('button', { name: 'Import cards' }).click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByLabel('Review card Markdown');
    await input.fill('## Card\n### Prompt\nMissing its answer');
    await expect(dialog.getByText('Line 1 needs both a prompt and an answer.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create cards' })).toBeDisabled();

    const first = {
      card_type: 'statement',
      prompt: 'Recall the import statement.',
      answer: 'The *statement* uses $x^2$.\n\n~~~text\n### Answer\n~~~',
    };
    const second = { card_type: 'example', prompt: 'Give an import example.', answer: '    A code sample' };
    const markdown = [
      '```markdown',
      '## Card',
      '### Prompt',
      first.prompt,
      '### Answer',
      first.answer,
      '',
      '## Card: example',
      '### Prompt',
      second.prompt,
      '### Answer',
      second.answer,
      '```',
    ].join('\r\n');
    await input.fill(markdown);
    await dialog.getByText('Preview 2 cards').click();
    await expect(dialog.locator('em')).toHaveText('statement');
    await expect(dialog.locator('.katex')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Create 2 cards' }).click();
    await expect(page.getByText('Created 2 cards.')).toBeVisible();
    await expect(page.getByRole('heading', { name: first.prompt })).toBeVisible();
    await expect(page.getByRole('heading', { name: second.prompt })).toBeVisible();
    const { items } = await (await request.get(`${path}/cards`)).json();
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining(first), expect.objectContaining(second)]),
    );
  } finally {
    const item = await (await request.get(path)).json();
    await request.delete(path, {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${item.version}"` },
    });
  }
});
