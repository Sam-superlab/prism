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
  await page.clock.fastForward(15 * 60 * 1000);
  await expect(panel.getByRole('status')).toHaveText('Focus complete');
  await panel.getByRole('button', { name: 'Start break', exact: true }).click();
  await expect(panel.getByRole('timer', { name: 'Break time remaining' })).toBeVisible();
  const saved = await (await request.get(`/api/v1/tasks/${id}`)).json();
  expect(saved.status).toBe('ready');
});
