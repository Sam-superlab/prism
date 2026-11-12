import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('organizes saved papers in optional folders and keeps the smart shelves separate', async ({ page }) => {
  const papers = [
    { title: 'Synthetic commutative algebra manuscript', reaction: 'interested', arxivId: '2611.99991' },
    { title: 'Synthetic geometry paper', reaction: 'liked', arxivId: '2611.99992' },
  ].map(({ title, reaction, arxivId }) => {
    const id = randomUUID();
    const paperId = randomUUID();
    const updated = '2026-11-13T09:00:00Z';
    return {
      id,
      paper_id: paperId,
      version: '1',
      status: 'unread',
      is_saved: true,
      for_you_reaction: reaction,
      relevance_score: 0,
      match_reasons: [],
      paper: {
        id: paperId,
        arxiv_id: arxivId,
        latest_version: 1,
        title,
        authors: ['Test Author'],
        abstract: 'A synthetic paper for the folders workflow.',
        categories: ['math.AC'],
        published_at: updated,
        updated_at: updated,
        source_url: `https://arxiv.org/abs/${arxivId}`,
        pdf_url: `https://arxiv.org/pdf/${arxivId}`,
      },
    };
  });
  const requestedIds: string[] = [];
  await page.route(/\/api\/v1\/arxiv\/feed(?:\?|$)/, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const ids = params.get('ids');
    if (ids) requestedIds.push(ids);
    const reaction = params.get('reaction');
    await route.fulfill({
      json: {
        items: papers.filter(
          (paper) =>
            (!ids || ids.split(',').includes(paper.id)) && (!reaction || paper.for_you_reaction === reaction),
        ),
        next_cursor: null,
      },
    });
  });

  await page.goto('/discover');
  const filters = page.getByRole('group', { name: 'Explore filters' });
  await filters.getByRole('button', { name: 'Saved', exact: true }).click();
  const saved = page.getByRole('region', { name: 'Saved folders' });
  await saved.getByRole('button', { name: 'New folder' }).click();
  const create = page.getByRole('dialog', { name: 'New folder in Saved' });
  await create.getByLabel('Folder name').fill('Commutative algebra');
  await create.getByRole('button', { name: 'Create folder' }).click();
  await saved.getByRole('button', { name: 'Commutative algebra', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No papers in this folder' })).toBeVisible();
  await saved.getByRole('button', { name: 'All saved' }).click();

  const paper = page.locator('article').filter({ hasText: papers[0].paper.title });
  await paper.getByLabel('More paper actions').click();
  await paper.getByRole('button', { name: 'Organize folders' }).click();
  const organize = page.getByRole('dialog', { name: 'Organize paper' });
  await organize.getByRole('checkbox', { name: 'Commutative algebra' }).check();
  await organize.getByRole('button', { name: 'Done' }).click();
  await saved.getByRole('button', { name: 'Commutative algebra', exact: true }).click();
  await expect(page.getByRole('heading', { name: papers[0].paper.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: papers[1].paper.title })).toHaveCount(0);
  expect(requestedIds).toContain(papers[0].id);

  await saved.getByRole('button', { name: 'Rename folder' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename folder' });
  await rename.getByLabel('Folder name').fill('Graded rings');
  await rename.getByRole('button', { name: 'Save name' }).click();
  await page.reload();
  await filters.getByRole('button', { name: 'Saved', exact: true }).click();
  await saved.getByRole('button', { name: 'Graded rings', exact: true }).click();
  await expect(page.getByRole('heading', { name: papers[0].paper.title })).toBeVisible();
  await filters.getByRole('button', { name: 'Interested', exact: true }).click();
  await expect(page.getByRole('heading', { name: papers[0].paper.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: papers[1].paper.title })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Liked', exact: true }).click();
  await expect(page.getByRole('heading', { name: papers[1].paper.title })).toBeVisible();
  await expect(page.getByRole('heading', { name: papers[0].paper.title })).toHaveCount(0);
});
