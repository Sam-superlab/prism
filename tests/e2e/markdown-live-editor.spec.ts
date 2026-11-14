import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectMarkdownSource } from './markdown-source';

test('formats Markdown in the focused editor and saves the exact source', async ({ page, request }) => {
  const title = `Live Markdown ${randomUUID()}`;
  const source = '# Definition\n\nA **normal** subgroup satisfies $gH=Hg$.';
  await page.goto('/knowledge');
  await page.getByRole('button', { name: 'New knowledge', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New knowledge item' });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  const region = dialog.getByRole('region', { name: 'Content preview' });
  const editor = region.getByRole('textbox', { name: 'Mathematical content' });
  const mode = dialog.getByRole('button', { name: 'Markdown source for Mathematical content' });
  const save = dialog.getByRole('button', { name: 'Save knowledge', exact: true });

  await save.click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('aria-invalid', 'true');

  await editor.fill(source.slice(0, -1));
  await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await editor.pressSequentially('.');
  await expect(editor).toBeFocused();
  await expect(region.getByRole('textbox')).toHaveCount(1);
  const heading = editor.locator('.prism-md-heading');
  await expect(heading).toHaveText('Definition');
  await expect(editor.locator('.prism-md-strong')).toHaveText('normal');
  const equation = editor.locator('.katex annotation[encoding="application/x-tex"]');
  await expect(equation).toHaveText('gH=Hg');
  await editor.locator('.prism-md-math').click();
  await expect(equation).toHaveCount(0);
  await expect(editor.locator('.cm-line').last()).toContainText('$gH=Hg$');
  await expect(editor).toBeFocused();
  await editor.blur();
  await expect(equation).toHaveText('gH=Hg');

  await heading.click();
  await editor.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.insertText(' updated');
  await expect(editor.locator('.cm-line').first()).toContainText('Definition updated');
  await editor.press('ControlOrMeta+z');
  await mode.click();
  await expectMarkdownSource(editor, source);
  await expect(equation).toHaveCount(0);
  await mode.click();
  await expect(equation).toHaveText('gH=Hg');

  await save.click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const saved = await request.get(`/api/v1/knowledge-items/${page.url().split('/').at(-1)}`);
  expect(saved.ok()).toBe(true);
  expect((await saved.json()).content).toBe(source);
});

test('renders a multiline formula in place and keeps its source editable', async ({ page }) => {
  const source = 'A displayed equation.\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n\nNext paragraph.';
  await page.goto('/knowledge');
  await page.getByRole('button', { name: 'New knowledge', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New knowledge item' });
  const editor = dialog.getByRole('textbox', { name: 'Mathematical content' });
  const mode = dialog.getByRole('button', { name: 'Markdown source for Mathematical content' });
  await mode.click();
  await editor.fill(source);
  await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await mode.click();
  const formula = editor.locator('.prism-md-display .katex-display');
  await expect(formula).toBeVisible();
  await formula.click();
  await expect(formula).toHaveCount(0);
  await expect(editor.locator('.cm-line')).toHaveText(source.split('\n'));
  await editor.blur();
  await expect(formula).toBeVisible();
  await mode.click();
  await expectMarkdownSource(editor, source);
});
