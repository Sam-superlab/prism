import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const user = '11111111-1111-4111-8111-111111111111';

test('resumes the localized Knowledge guide and makes a card from a real definition', async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem(`prism.guide-language.v1.${id}`, 'ja');
  }, user);
  await page.goto('/knowledge');
  const guide = page.getByRole('complementary', { name: '最初の知識ノート' });
  await guide.getByRole('button', { name: '今はスキップ' }).click();
  await page.reload();
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pip と再開' })).toBeVisible();
  await page.goto('/settings');
  await page.getByRole('link', { name: '最初の知識ノート' }).click();
  await guide.getByRole('button', { name: 'Pip と定義を書く' }).click();
  await expect(page).toHaveURL('/knowledge');

  const definition = `Guide definition ${randomUUID()}`;
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Title', { exact: true }).fill(definition);
  await expect(editor.getByLabel('Object type')).toHaveValue('definition');
  await editor.getByLabel('Mathematical content').fill('An operation is commutative if $a+b=b+a$.');
  await expect(editor.getByRole('region', { name: 'Content preview' }).locator('.katex')).toBeVisible();
  await editor.getByRole('button', { name: 'Save knowledge' }).click();

  await expect(page.getByRole('heading', { name: definition })).toBeVisible();
  await guide.getByRole('button', { name: 'Pip とカードを作る' }).click();
  await editor.getByLabel('Prompt').fill('When is an operation commutative?');
  await editor.getByRole('button', { name: 'Save card' }).click();
  await expect(page.getByText('When is an operation commutative?')).toBeVisible();
  await page.reload();
  await expect(guide).toHaveCount(0);
});

test('takes Pip’s sample PDF through formula review and only saves on confirmation', async ({ page }) => {
  await page.goto('/practice');
  const guide = page.getByRole('complementary', { name: 'Try an exercise import' });
  await guide.getByRole('button', { name: 'Start the import with Pip' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Try Pip’s sample PDF' }).click();
  await editor.getByRole('button', { name: 'Preview exercises' }).click();
  await expect(editor.getByRole('region', { name: 'Check PDF formulas' })).toBeVisible();
  await editor.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Pip’s practice sample', { exact: true })).toHaveCount(0);

  await guide.getByRole('button', { name: 'Start the import with Pip' }).click();
  await editor.getByRole('button', { name: 'Try Pip’s sample PDF' }).click();
  await editor.getByRole('button', { name: 'Preview exercises' }).click();
  await editor.getByRole('checkbox', { name: 'Include exercise 1' }).check();
  await editor.getByRole('button', { name: 'Keep this example' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved 1 exercise' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Replay guide' })).toBeVisible();
});

test('creates a project and adds an existing note through the Research guide', async ({
  page,
  request,
  baseURL,
}) => {
  const note = `Guide material ${randomUUID()}`;
  const noteId = randomUUID();
  const seeded = await request.post('/api/v1/knowledge-items', {
    headers: { Origin: baseURL!, 'Idempotency-Key': noteId },
    data: { id: noteId, type: 'definition', title: note, content: 'A synthetic guide note.' },
  });
  expect(seeded.ok()).toBeTruthy();
  const project = `Guide project ${randomUUID()}`;
  await page.goto('/research');
  const guide = page.getByRole('complementary', { name: 'Start a research project' });
  await guide.getByRole('button', { name: 'Set up a project with Pip' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Project title').fill(project);
  await editor.getByLabel('Background and objectives').fill('What should the guide help us study?');
  await editor.getByRole('button', { name: 'Save project' }).click();

  await expect(page.getByRole('heading', { name: project })).toBeVisible();
  await guide.getByRole('button', { name: 'Find material to link' }).click();
  await editor.getByRole('searchbox', { name: 'Search materials' }).fill(note);
  await editor.getByRole('button', { name: note, exact: true }).click();
  await editor.getByRole('button', { name: 'Create link' }).click();
  await expect(
    page.getByRole('region', { name: 'Project materials' }).getByRole('link', { name: note }),
  ).toBeVisible();
  await expect(guide).toHaveCount(0);
});
