import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('searches within a saved paper subfolder and links the selected paper', async ({
  page,
  request,
  baseURL,
}) => {
  const projectId = randomUUID();
  const project = await request.post('/api/v1/research/projects', {
    headers: { Origin: baseURL!, 'Idempotency-Key': projectId },
    data: { id: projectId, title: 'Synthetic materials project' },
  });
  expect(project.status()).toBe(201);
  const user = await (await request.get('/api/v1/me')).json();
  const filed = {
    id: randomUUID(),
    paper: { id: randomUUID(), title: 'Graded ideals', authors: ['Example Author'] },
  };
  const unfiled = {
    id: randomUUID(),
    paper: { id: randomUUID(), title: 'Unfiled paper', authors: ['Example Author'] },
  };
  const folder = { id: randomUUID(), name: 'Commutative algebra', shelf: 'saved', paperIds: [filed.id] };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: `prism.paper-folders.v1.${user.id}`,
    value: [folder],
  });
  await page.route(
    (url) => url.pathname === '/api/v1/arxiv/feed',
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      expect(query.get('saved')).toBe('true');
      const ids = query.get('ids')?.split(',');
      const search = query.get('q')?.toLowerCase();
      const items = [filed, unfiled].filter(
        (item) =>
          (!ids || ids.includes(item.id)) && (!search || item.paper.title.toLowerCase().includes(search)),
      );
      await route.fulfill({ json: { items, next_cursor: null } });
    },
  );
  await page.route('**/api/v1/research/paper-links', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 204 });
    else await route.continue();
  });

  await page.goto(`/research/${projectId}`);
  await page
    .getByRole('region', { name: 'References', exact: true })
    .getByRole('button', { name: 'Choose paper', exact: true })
    .click();
  const picker = page.getByRole('dialog', { name: 'Link material to project' });
  await expect(picker.getByRole('button', { name: 'Papers', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(picker.getByRole('button', { name: 'Saved', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(picker.getByRole('button', { name: /Unfiled paper/ })).toBeVisible();
  await picker.getByLabel('Subfolder').selectOption({ label: folder.name });
  await expect(picker.getByRole('button', { name: /Unfiled paper/ })).toHaveCount(0);

  const search = picker.getByRole('searchbox', { name: 'Search materials' });
  await search.fill('unfiled');
  await expect(picker.getByText('No unlinked materials match your search.')).toBeVisible();
  await search.fill('graded');
  await picker.getByRole('button', { name: /Graded ideals/ }).click();
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/research/paper-links',
  );
  await picker.getByRole('button', { name: 'Create link' }).click();
  expect((await submitted).postDataJSON()).toMatchObject({ project_id: projectId, paper_id: filed.paper.id });
  await expect(picker).toBeHidden();
});
