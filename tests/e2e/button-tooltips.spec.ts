import { expect, test } from '@playwright/test';

test('button names float above the workspace and modal controls and respond to keyboard focus', async ({ page }) => {
  await page.goto('/research/library');
  const tip = page.locator('.button-tooltip[data-visible="true"]');
  const tools = page.getByRole('group', { name: 'Library tools' });
  const find = tools.getByRole('button', { name: 'Find duplicates' });
  await find.hover();
  await expect(tip).toHaveText('Find duplicates');
  await expect(tip).toHaveCSS('opacity', '1');
  expect((await tip.evaluate((element) => getComputedStyle(element).transitionProperty))).toContain('translate');
  await page.mouse.move(350, 650);
  await expect(page.locator('.button-tooltip')).toHaveCount(0);

  const search = page.getByRole('button', { name: 'Search', exact: true });
  await search.hover();
  await expect(tip).toHaveText('Search');
  await page.keyboard.press('Escape');
  await expect(page.locator('.button-tooltip')).toHaveCount(0);

  const add = tools.getByRole('button', { name: 'Add reference' });
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Add reference' });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await close.hover();
  await expect(dialog.locator('.button-tooltip[data-visible="true"]')).toHaveText('Close');
  await close.click();
  await expect(dialog).toBeHidden();
  await page.mouse.move(350, 650);
  await page.keyboard.press('Tab');
  await find.focus();
  await expect(tip).toHaveText('Find duplicates');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(tip).toHaveCSS('transition-property', 'none');
});
