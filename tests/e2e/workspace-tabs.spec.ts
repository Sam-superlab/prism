import { expect, test } from '@playwright/test';

test('restores tab order and layout on desktop startup and honors explicit navigation', async ({ page }) => {
  await page.goto('/knowledge');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await page.getByPlaceholder('Search knowledge titles or content…').fill('fixture filter');
  await navigation.getByRole('link', { name: 'Discover' }).click({ modifiers: ['ControlOrMeta'] });
  await navigation.getByRole('link', { name: 'Workspace Graph' }).click({ modifiers: ['ControlOrMeta'] });
  const graph = page.getByRole('region', { name: 'Workspace Graph', exact: true });
  await expect(graph).toBeVisible();
  const canvas = graph.getByLabel('Interactive connection graph');
  await expect(canvas).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height * 0.8);
  const tabs = page.getByRole('navigation', { name: 'Workspace tabs' });
  const titles = tabs.locator('.workspace-tab-select');
  await tabs.getByRole('button', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByPlaceholder('Search knowledge titles or content…')).toHaveValue('fixture filter');
  await tabs.getByRole('button', { name: 'Workspace Graph', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to vertical tabs' }).click();
  await expect(titles).toHaveText(['Knowledge', 'Discover', 'Workspace Graph']);
  await page.goto('/today?restoreTabs=1');
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByRole('button', { name: 'Switch to horizontal tabs' })).toBeVisible();
  await expect(titles).toHaveText(['Knowledge', 'Discover', 'Workspace Graph']);
  await expect(tabs.getByRole('button', { name: 'Workspace Graph', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto('/today');
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
});
