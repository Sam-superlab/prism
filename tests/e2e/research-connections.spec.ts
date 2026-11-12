import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('links knowledge and papers from their source pages to a research project', async ({
  page,
  request,
  baseURL,
}) => {
  const projectId = randomUUID();
  const noteId = randomUUID();
  const projectTitle = 'Synthetic research connection project';
  const noteTitle = 'Synthetic knowledge connection note';
  const create = (path: string, data: { id: string; title: string; type?: string; content?: string }) =>
    request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL!, 'Idempotency-Key': data.id },
      data,
    });
  expect((await create('research/projects', { id: projectId, title: projectTitle })).status()).toBe(201);
  expect(
    (
      await create('knowledge-items', {
        id: noteId,
        title: noteTitle,
        type: 'note',
        content: 'A synthetic research note.',
      })
    ).status(),
  ).toBe(201);

  await page.goto(`/knowledge/${noteId}`);
  const connections = page.getByRole('region', { name: 'Research connections' });
  await connections.getByRole('button', { name: 'Link to research' }).click();
  const modal = page.getByRole('dialog', { name: 'Link to research' });
  await modal.getByLabel('Research project', { exact: true }).selectOption(projectId);
  await modal.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(modal.getByRole('link', { name: projectTitle })).toBeVisible();
  await modal.getByRole('link', { name: projectTitle }).click();
  const materials = page.getByRole('region', { name: 'Project materials' });
  await expect(materials.getByRole('link', { name: noteTitle })).toHaveAttribute(
    'href',
    `/knowledge/${noteId}`,
  );
  await materials.getByRole('button', { name: 'Remove knowledge link' }).click();
  await expect(materials.getByRole('link', { name: noteTitle })).toHaveCount(0);
  expect((await request.get(`/api/v1/knowledge-items/${noteId}`)).status()).toBe(200);

  const subscriptions = await (await request.get('/api/v1/arxiv/subscriptions?limit=100')).json();
  if (
    !subscriptions.items.some((item: { subscription_value: string }) => item.subscription_value === 'math.AC')
  ) {
    const id = randomUUID();
    expect(
      (
        await request.post('/api/v1/arxiv/subscriptions', {
          headers: { Origin: baseURL!, 'Idempotency-Key': id },
          data: { id, subscription_type: 'category', subscription_value: 'math.AC' },
        })
      ).status(),
    ).toBe(201);
  }
  await page.goto('/discover');
  await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
  const paperTitle = 'PRISM E2E metadata fixture';
  const paper = page.locator('.paper-card').filter({ hasText: paperTitle });
  await paper.getByRole('button', { name: 'Link to research', exact: true }).click();
  await modal.getByLabel('Research project', { exact: true }).selectOption(projectId);
  await modal.getByRole('button', { name: 'Create link', exact: true }).click();
  await modal.getByRole('link', { name: projectTitle }).click();
  await expect(materials.getByRole('link', { name: paperTitle })).toHaveAttribute(
    'href',
    /https:\/\/arxiv.org\/abs\//,
  );
});

test('keyboard shortcuts open Settings and protect an open capture dialog', async ({ page }) => {
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Today at a glance' })).toBeVisible();
  await page.keyboard.press('Control+Shift+N');
  const capture = page.getByRole('dialog', { name: 'Capture a thought' });
  await expect(capture).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(capture).toBeVisible();
  await expect(page).toHaveURL(/\/today$/);
  await page.keyboard.press('Escape');
  await expect(capture).toBeHidden();
  await page.keyboard.press('Meta+,');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search and navigate' })).toBeVisible();
});
