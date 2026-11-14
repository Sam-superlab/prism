import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('Today creates one plan, records completion, and shows a saved next step tomorrow', async ({
  page,
  request,
  baseURL,
}) => {
  const date = '2040-11-09';
  const tomorrow = '2040-11-10';
  const title = 'Pinned continuation fixture';
  const note = 'Resume with the finite generation argument.';
  await page.clock.setFixedTime(new Date(date + 'T12:00:00Z'));
  const task = await request.post('/api/v1/tasks', {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() },
    data: { id: randomUUID(), title, source_type: 'general', estimated_minutes: 15, pinned: true },
  });
  expect(task.status()).toBe(201);

  await page.goto('/today');
  await expect(page.getByRole('button', { name: 'Replan', exact: true })).toBeVisible();
  const row = page.locator('.task-row').filter({ hasText: title });
  await expect(row).toBeVisible();
  const before = await (await request.get('/api/v1/today?date=' + date)).json();
  const overview = page.getByRole('region', { name: 'Today at a glance' });
  const progress = overview.getByRole('region', { name: 'Plan progress' });
  const budget = overview.getByRole('region', { name: 'Time budget' });
  await expect(progress).toContainText(`${before.completed_count} of ${before.planned_count} completed`);
  await expect(budget).toContainText(`${before.estimated_remaining_minutes} min remaining`);
  await expect(overview.getByRole('list', { name: 'Review ratings by day' }).getByRole('listitem')).toHaveCount(7);
  const generate = () =>
    request.post('/api/v1/daily-plans/generate', {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() },
      data: { plan_date: date, timezone: before.timezone, capacity_minutes: 0, if_missing: true },
    });
  const repeated = await Promise.all([generate(), generate()]);
  for (const response of repeated) {
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual(before.plan);
  }
  expect(
    before.plan.items.find((item: { title_snapshot: string }) => item.title_snapshot === title).pinned,
  ).toBe(true);

  await row.getByRole('button', { name: 'Complete ' + title }).click();
  await expect(progress).toContainText(`${before.completed_count + 1} of ${before.planned_count} completed`);
  await expect(budget).toContainText(`${before.estimated_remaining_minutes - 15} min remaining`);
  await progress.getByRole('button', { name: `${before.completed_count + 1} Done` }).click();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Daily reflection' }).click();
  const dialog = page.getByRole('dialog');
  const draft = dialog.getByLabel('Where will you pick up tomorrow?', { exact: true });
  await draft.fill(note);
  await dialog.getByRole('button', { name: 'Save reflection' }).click();
  await expect(dialog.getByText('Daily reflection saved.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('button', { name: 'Daily reflection' }).click();
  await expect(dialog.getByRole('region', { name: 'Where will you pick up tomorrow? editor' })).toContainText(note);

  await page.clock.setFixedTime(new Date(tomorrow + 'T12:00:00Z'));
  await page.reload();
  await expect(page.getByRole('region', { name: 'Yesterday’s next step' })).toContainText(note);
  await expect(page.getByRole('button', { name: 'Replan', exact: true })).toBeVisible();
});

test('collapsed desktop sidebar waits for intentional hover and remembers the pinned state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/research');
  const sidebar = page.getByRole('navigation', { name: 'Main navigation' });
  const library = sidebar.getByRole('link', { name: 'Library' });
  const label = library.getByText('Library');
  const pin = page.getByRole('button', { name: 'Pin sidebar open' });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(label).toBeHidden();
  await expect(library).toBeVisible();
  const compactWidth = (await library.boundingBox())!.width;
  const content = page.locator('.workspace');
  await expect.poll(async () => (await content.boundingBox())!.x).toBeLessThan(75);
  await content.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const restingPosition = (await content.boundingBox())!.x;
  const rail = page.locator('.sidebar-region');
  const icon = (await library.boundingBox())!;
  const iconPoint = { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 };
  const outside = { x: 450, y: 300 };
  const profile = rail.locator('.profile');
  await expect(rail.getByText('WORKSPACE', { exact: true })).toHaveCount(0);
  await expect(profile).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  for (const transparency of ['true', 'false']) {
    await page.evaluate((value) => { document.documentElement.dataset.transparency = value; }, transparency);
    const alignment = await rail.evaluate((region) => {
      const panel = region.querySelector('.sidebar')!;
      const frame = panel.getBoundingClientRect();
      const railWidth = parseFloat(getComputedStyle(panel).getPropertyValue('--sidebar-rail-width'));
      const center = frame.left + railWidth / 2;
      const icons = panel.querySelectorAll('.prism-symbol, .nav-link > svg, .avatar');
      const mainIcons = Array.from(panel.querySelectorAll('.prism-symbol, nav[aria-label="Main navigation"] .nav-link > svg'), (icon) => {
        const bounds = icon.getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      });
      const gaps = mainIcons.slice(1).map((position, index) => position - mainIcons[index]);
      return {
        left: frame.left - region.getBoundingClientRect().left,
        right: region.getBoundingClientRect().right - frame.left - railWidth,
        gapDifference: Math.max(...gaps) - Math.min(...gaps),
        maximumOffset: Math.max(...Array.from(icons, (icon) => {
          const bounds = icon.getBoundingClientRect();
          return Math.abs(bounds.left + bounds.width / 2 - center);
        })),
      };
    });
    expect(alignment.left).toBe(alignment.right);
    expect(alignment.maximumOffset).toBeLessThan(0.5);
    expect(alignment.gapDifference).toBeLessThan(2);
  }
  await page.evaluate(() => { document.documentElement.dataset.transparency = 'true'; });

  await page.clock.install();
  await page.mouse.move(iconPoint.x, iconPoint.y);
  await page.clock.runFor(120);
  expect(await pin.getAttribute('aria-expanded')).toBe('false');
  await page.mouse.move(outside.x, outside.y);
  await page.clock.runFor(300);
  expect(await pin.getAttribute('aria-expanded')).toBe('false');

  await page.mouse.move(iconPoint.x, iconPoint.y);
  await page.clock.runFor(300);
  await expect(label).toBeVisible();
  await expect(pin).toHaveAttribute('aria-expanded', 'true');
  await expect(profile).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect.poll(async () => (await library.boundingBox())!.width).toBeGreaterThan(compactWidth + 100);
  expect((await content.boundingBox())!.x).toBe(restingPosition);
  // Moving toward the label stays inside the expanded panel.
  const labelBox = (await label.boundingBox())!;
  await page.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
  await expect(label).toBeVisible();
  await page.mouse.move(outside.x, outside.y);
  await page.clock.runFor(80);
  expect(await pin.getAttribute('aria-expanded')).toBe('true');
  await page.mouse.move(iconPoint.x, iconPoint.y);
  await page.clock.runFor(240);
  expect(await pin.getAttribute('aria-expanded')).toBe('true');
  await page.mouse.move(outside.x, outside.y);
  await page.clock.runFor(220);
  await expect(label).toBeHidden();
  await page.reload();
  await expect(label).toBeHidden();
  await library.focus();
  await expect(label).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(label).toBeHidden();
  await pin.click();
  await expect(label).toBeVisible();
  await page.reload();
  await expect(label).toBeVisible();
});
