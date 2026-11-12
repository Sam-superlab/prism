import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('refreshes an existing Today plan when a task is added and explains deferrals', async ({
  page,
  request,
  baseURL,
}) => {
  const date = '2040-11-15';
  const title = 'Read the synthetic proof';
  const oversized = 'Oversized synthetic task';
  const existing = 'Manually deferred synthetic task';
  const outside = 'Synthetic task created outside Today';
  const taskId = randomUUID();
  const headers = () => ({ Origin: baseURL!, 'Idempotency-Key': randomUUID() });
  await page.clock.setFixedTime(new Date(date + 'T12:00:00Z'));
  const me = await (await request.get('/api/v1/me')).json();
  expect(
    (
      await request.post('/api/v1/tasks', {
        headers: headers(),
        data: {
          id: taskId,
          title: existing,
          source_type: 'general',
          estimated_minutes: 10,
          planned_date: date,
        },
      })
    ).status(),
  ).toBe(201);
  const generated = await request.post('/api/v1/daily-plans/generate', {
    headers: headers(),
    data: { plan_date: date, timezone: me.timezone, capacity_minutes: 600 },
  });
  expect(generated.status()).toBe(200);
  const plan = await generated.json();
  const oldItem = plan.items.find((item: { task_id: string }) => item.task_id === taskId);
  expect(oldItem).toBeTruthy();
  const deferred = await request.patch(`/api/v1/daily-plans/${plan.id}/items/${oldItem.id}`, {
    headers: { ...headers(), 'If-Match': `"${oldItem.version}"` },
    data: { status: 'deferred', deferred_reason: 'Keep my manual choice' },
  });
  expect(deferred.status()).toBe(200);

  await page.goto('/today');
  const region = page.getByRole('region', { name: 'Today’s plan' });
  const addTask = async (taskTitle: string, minutes: number) => {
    await region.getByRole('button', { name: 'Add task', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Next step' });
    await expect(dialog.getByLabel('Planned date (optional)', { exact: true })).toHaveValue(date);
    await dialog.getByLabel('Task title', { exact: true }).fill(taskTitle);
    await dialog.getByLabel('Estimated minutes', { exact: true }).fill(String(minutes));
    await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(dialog).toBeHidden();
  };

  await addTask(title, 20);
  await expect(region.locator('.task-row').filter({ hasText: title })).toBeVisible();
  await expect(region.getByRole('status')).toContainText(`Added to today’s plan: ${title}`);

  await addTask(oversized, 1440);
  await expect(region.getByRole('status')).toContainText(`Saved in Deferred: ${oversized}`);
  await region.getByRole('button', { name: 'Show deferred', exact: true }).click();
  await expect(region.locator('.task-row').filter({ hasText: oversized })).toBeVisible();
  await expect(region.locator('.task-row').filter({ hasText: existing })).toContainText(
    'Keep my manual choice',
  );
  expect(
    (
      await request.post('/api/v1/tasks', {
        headers: headers(),
        data: { id: randomUUID(), title: outside, source_type: 'general', estimated_minutes: 10 },
      })
    ).status(),
  ).toBe(201);
  await page.reload();
  await expect(region.locator('.task-row').filter({ hasText: outside })).toBeVisible();
});
