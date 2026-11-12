import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const firstVisit =
  /\/api\/v1\/(knowledge-items|research\/projects|tasks|inbox|arxiv\/subscriptions)\?limit=1$/;

let notesCreated: string[];

test.beforeEach(async ({ page }) => {
  notesCreated = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/knowledge-items')
      notesCreated.push(request.postDataJSON().id);
  });
  // The suite shares a backend. Present an empty workspace only during first-visit detection.
  await page.route(firstVisit, (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
});

test.afterEach(async ({ request, baseURL }) => {
  for (const id of new Set(notesCreated)) {
    const path = `/api/v1/knowledge-items/${id}`;
    const response = await request.get(path);
    if (!response.ok()) continue;
    const item = await response.json();
    const archived = await request.delete(path, {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${item.version}"` },
    });
    expect(archived.ok()).toBeTruthy();
  }
});

test('skips and resumes onboarding, then schedules a review of the card just created', async ({ page }) => {
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Welcome to PRISM' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to PRISM' })).toBeHidden();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Open guide' }).click();
  const checklist = page.getByRole('region', { name: 'Getting started' });
  await checklist.getByRole('button', { name: 'Create note' }).click();
  const note = page.getByRole('dialog');
  await note.getByLabel('Title', { exact: true }).fill('Identity element');
  await note.getByLabel('Mathematical content').fill('The identity element leaves every element unchanged.');
  await note.getByRole('button', { name: 'Save knowledge' }).click();

  await checklist.getByRole('button', { name: 'Make a card' }).click();
  const card = page.getByRole('dialog');
  await card.getByLabel('Prompt', { exact: true }).fill('What does the identity element do?');
  await card.getByRole('button', { name: 'Save card' }).click();
  await checklist.getByRole('link', { name: 'Start first review' }).click();
  await expect(page.getByText('What does the identity element do?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reveal answer' }).click();
  await page.getByRole('button', { name: /Good.*Recalled correctly/ }).click();
  await expect(page.getByRole('heading', { name: 'Next review' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Today', exact: true }).click();
  await expect(checklist.getByRole('heading', { name: 'You finished your first review' })).toBeVisible();
  await checklist.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(checklist).toBeHidden();
});

test('practice makes no writes until the user keeps the example', async ({ page, request }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/v1\/(knowledge-items|review\/events)/.test(request.url())) {
      writes.push(new URL(request.url()).pathname);
    }
  });
  await page.goto('/today');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  const demo = page.getByRole('dialog');
  await demo.getByRole('button', { name: 'See the review card' }).click();
  await demo.getByRole('button', { name: 'Reveal answer' }).click();
  await demo.getByRole('button', { name: 'Good', exact: true }).click();
  await demo.getByRole('button', { name: 'Back to checklist' }).click();
  expect(writes).toEqual([]);

  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await demo.getByRole('button', { name: 'Keep this example' }).click();
  const checklist = page.getByRole('region', { name: 'Getting started' });
  await expect(checklist.getByRole('link', { name: 'Start first review' })).toBeVisible();
  const link = await checklist.getByRole('link', { name: 'Open note' }).getAttribute('href');
  const id = link?.split('/').at(-1);
  expect(id).toBeTruthy();
  expect(writes).toEqual(['/api/v1/knowledge-items', `/api/v1/knowledge-items/${id}/cards`]);
  const { items } = await (await request.get(`/api/v1/knowledge-items/${id}/cards`)).json();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ prompt: 'What is an abelian group?', review_count: 0 });
});

test('switches tutorial languages without losing progress and shows the new guides', async ({ page }) => {
  await page.goto('/today');
  const welcome = page.getByRole('dialog');
  await expect(welcome.getByRole('heading', { name: 'Welcome to PRISM' })).toBeVisible();
  await welcome.getByRole('combobox').selectOption('zh-CN');
  await expect(welcome.getByRole('heading', { name: '欢迎使用 PRISM' })).toBeVisible();

  await page.reload();
  await expect(welcome.getByRole('heading', { name: '欢迎使用 PRISM' })).toBeVisible();
  await expect(welcome.getByRole('combobox')).toHaveValue('zh-CN');
  await welcome.getByRole('button', { name: '创建第一条笔记' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Title', { exact: true }).fill('Tutorial language note');
  await editor
    .getByLabel('Mathematical content')
    .fill('A note to preserve when changing the guide language.');
  await editor.getByRole('button', { name: 'Save knowledge' }).click();
  await expect(editor).toBeHidden();

  const chineseGuide = page.getByRole('region', { name: '入门指南' });
  await expect(chineseGuide.getByRole('link', { name: '打开练习' })).toHaveAttribute('href', '/practice');
  await chineseGuide.getByRole('combobox').selectOption('ja');
  const japaneseGuide = page.getByRole('region', { name: 'はじめてのガイド' });
  await expect(japaneseGuide.getByRole('link', { name: 'ノートを開く' })).toHaveAttribute(
    'href',
    `/knowledge/${notesCreated[0]}`,
  );
  await expect(japaneseGuide.getByRole('link', { name: '外観設定を開く' })).toHaveAttribute(
    'href',
    '/settings#appearance-heading',
  );

  await page.reload();
  await expect(japaneseGuide.getByRole('combobox')).toHaveValue('ja');
  await expect(japaneseGuide.getByRole('link', { name: 'ノートを開く' })).toHaveAttribute(
    'href',
    `/knowledge/${notesCreated[0]}`,
  );
});

test('keeps the welcome closed for an existing workspace and opens the guide from Settings', async ({
  page,
  request,
  baseURL,
}) => {
  await page.unroute(firstVisit);
  const id = randomUUID();
  notesCreated.push(id);
  const created = await request.post('/api/v1/knowledge-items', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title: 'Existing note', type: 'note', content: 'Already in this workspace.' },
  });
  expect(created.status()).toBe(201);

  await page.goto('/today');
  const user = await (await request.get('/api/v1/me')).json();
  await expect
    .poll(() => page.evaluate((id) => localStorage.getItem(`prism.getting-started.v1.${id}`), user.id))
    .toBe('{"status":"hidden"}');
  await expect(page.getByRole('heading', { name: 'Welcome to PRISM' })).toBeHidden();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Open guide' }).click();
  await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible();
});
