import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('focuses a planned task, preserves pause across routes and offers a break after focus', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = 'Synthetic focus task';
  const task = await request.post('/api/v1/tasks', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, source_type: 'general', estimated_minutes: 15, pinned: true },
  });
  expect(task.status()).toBe(201);

  await page.clock.install();
  await page.goto('/today');
  const panel = page.getByRole('region', { name: 'Focus timer' });
  await panel.getByRole('combobox', { name: 'Focus duration' }).selectOption('15');
  const plan = page.getByRole('region', { name: 'Today’s plan' });
  await plan.getByRole('button', { name: `Focus on ${title}`, exact: true }).click();
  await expect(panel.getByText(title, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  const readout = panel.getByRole('timer', { name: 'Focus time remaining' });
  const paused = await readout.textContent();

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Knowledge' })
    .click();
  const status = page.getByRole('link', { name: /Focus.*paused/ });
  await expect(status).toBeVisible();
  await page.reload();
  await status.click();
  await expect(readout).toHaveText(paused!);

  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Knowledge' })
    .click();
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await page.clock.fastForward(15 * 60 * 1000);
  await expect(page.getByText('Focus session complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open timer', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Focus complete');
  await panel.getByRole('button', { name: 'Start break', exact: true }).click();
  await expect(panel.getByRole('timer', { name: 'Break time remaining' })).toBeVisible();
  const saved = await (await request.get(`/api/v1/tasks/${id}`)).json();
  expect(saved.status).toBe('ready');
});

test('persists muted reminders and desktop companion visibility', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'prismFocus', {
      value: {
        setState: (state: unknown) => (document.documentElement.dataset.testFocus = JSON.stringify(state)),
      },
    });
  });
  await page.goto('/settings');
  const settings = page.getByRole('region', { name: 'Focus timer' });
  const sound = settings.getByRole('switch', { name: /Timer sound/ });
  const pet = settings.getByRole('switch', { name: /Desktop companion/ });
  await sound.uncheck();
  await pet.check();
  await expect(page.locator('html')).toHaveAttribute('data-test-focus', /"sound":false.*"pet":true/);
  await page.reload();
  await expect(sound).not.toBeChecked();
  await expect(pet).toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event('prism:hide-pet')));
  await expect(pet).not.toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-test-focus', /"sound":false.*"pet":false/);
});
