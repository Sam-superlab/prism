import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Real UI workflows against scripts/e2e-api.ts's isolated PostgreSQL engine.
 * The only external transport fixture is arXiv Atom metadata; product operations use the real API.
 */
const prefix = '浏览器验收';
async function createKnowledge(page: Page, title: string) {
  await page.goto('/knowledge');
  await page.getByRole('button', { name: 'New knowledge', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog
    .getByLabel('Mathematical content')
    .fill('浏览器验收记录，未验证。LaTeX rendering: $\\dim V=n$.');
  await dialog.getByRole('button', { name: 'Save knowledge', exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return page.url().split('/').at(-1)!;
}
async function addCard(page: Page, prompt: string, type = 'statement') {
  await page.getByRole('button', { name: 'Add card', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Review focus').selectOption(type);
  await dialog.getByLabel('Prompt').fill(prompt);
  await dialog.getByLabel('Reference answer', { exact: true }).fill('独立答案，测试公式 $\\dim V=n$。');
  await dialog.getByRole('button', { name: 'Save card', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.review-card-row').filter({ hasText: prompt })).toBeVisible();
}
async function createTask(page: Page, title: string, minutes: number, pinned = false) {
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Task title').fill(title);
  await dialog.getByLabel('Estimated minutes', { exact: true }).fill(String(minutes));
  if (pinned) await dialog.getByLabel('Pin to daily plan').check();
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test.describe.serial('PRISM complete product workflows', () => {
  test('create theorem, two independent cards, reveal/rate and inspect immutable history', async ({
    page,
  }) => {
    const id = await createKnowledge(page, `${prefix} · 数学知识`);
    await addCard(page, 'Statement — browser workflow');
    await addCard(page, 'Proof — independent schedule', 'proof');
    await page.goto('/review/session');
    await expect(page.locator('.recall-prompt')).toContainText('Statement — browser workflow');
    await expect(page.locator('.recall-answer')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await expect(page.locator('.recall-answer .katex')).toBeVisible();
    await page.getByRole('button', { name: /^Good/ }).click();
    await expect(page.locator('.recall-prompt')).toContainText('Proof — independent schedule');
    const response = await page.request.get(`/api/v1/knowledge-items/${id}/cards`);
    expect(response.ok()).toBeTruthy();
    const cards = (await response.json()).items as { prompt: string; review_count: number; due_at: string }[];
    expect(cards.find((c) => c.prompt.startsWith('Statement'))?.review_count).toBe(1);
    expect(cards.find((c) => c.prompt.startsWith('Proof'))?.review_count).toBe(0);
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await page.getByRole('button', { name: /^Good/ }).click();
    await expect(page.getByRole('heading', { name: 'Review complete', exact: true })).toBeVisible();
    await expect(page.getByText('2 / 2 reviewed', { exact: true })).toBeVisible();
    await page.goto(`/knowledge/${id}`);
    await page
      .locator('.review-card-row')
      .first()
      .getByRole('button', { name: 'History', exact: true })
      .click();
    await expect(page.getByRole('dialog').getByText('GOOD', { exact: true })).toBeVisible();
  });

  test('lost review response retries the exact same operation and commits once', async ({ page }) => {
    const id = await createKnowledge(page, `${prefix} · 丢失响应恢复`);
    await addCard(page, 'Retry-safe review');
    const commands: { key: string; body: string | null }[] = [];
    await page.route('**/api/v1/review/events', async (route) => {
      commands.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      if (commands.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    await page.goto('/review/session');
    await expect(page.locator('.recall-prompt')).toContainText('Retry-safe review');
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await page.getByRole('button', { name: /^Good/ }).click();
    await expect(page.getByText(/Retry GOOD;/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Again/ })).toBeDisabled();
    await page.getByRole('button', { name: /^Good/ }).click();
    await expect(page.getByRole('heading', { name: 'Review complete', exact: true })).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    const cards = (await (await page.request.get(`/api/v1/knowledge-items/${id}/cards`)).json()).items;
    expect(cards[0].review_count).toBe(1);
    const events = (await (await page.request.get(`/api/v1/review/history?card_id=${cards[0].id}`)).json())
      .items;
    expect(events).toHaveLength(1);
  });

  test('project → conjecture → scoped evidence → task → audit timeline', async ({ page }) => {
    await page.goto('/research');
    await page.getByRole('button', { name: 'New research project', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Project title').fill(`${prefix} · Strong Persistence`);
    await dialog.getByLabel('Background and objectives').fill('Isolated browser acceptance project.');
    await dialog.getByLabel('Research area').fill('Commutative Algebra');
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(page).toHaveURL(/\/research\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Add object', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title', { exact: true }).fill(`${prefix} · 猜想`);
    await dialog.getByLabel('Object type').selectOption('conjecture');
    await dialog
      .getByLabel('Content', { exact: true })
      .fill('Conjecture fixture with $I^n$. No mathematical verification is implied.');
    await dialog.getByLabel('Mathematical claim status').selectOption('conjecture');
    await dialog.getByRole('button', { name: 'Save research object', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const objectCard = page.locator('.object-card').filter({ hasText: `${prefix} · 猜想` });
    await objectCard.getByRole('button', { name: 'Edit research object', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Mathematical claim status').selectOption('computationally_verified');
    await dialog
      .getByLabel('Verification scope')
      .fill('Test-only parameters n=1..3; symbolic fixture, not a general proof.');
    await dialog.getByLabel('Results / evidence').fill('All specified test cases recorded.');
    await dialog.getByLabel('Proof or evidence reference').fill('e2e-fixture://experiment-1');
    await dialog.getByRole('button', { name: 'Save research object', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(objectCard.getByText('Computationally verified', { exact: true })).toBeVisible();
    await objectCard.getByRole('button', { name: 'Create task', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Task title').fill(`${prefix} · 检查边界条件`);
    await dialog.getByLabel('Estimated minutes', { exact: true }).fill('25');
    await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Research tasks', exact: true }).click();
    await page.getByRole('button', { name: `Complete ${prefix} · 检查边界条件`, exact: true }).click();
    await expect(
      page
        .locator('.research-task')
        .filter({ hasText: '检查边界条件' })
        .locator('.badge')
        .filter({ hasText: 'Completed' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Research objects', exact: true }).first().click();
    await expect(objectCard.getByText('Computationally verified', { exact: true })).toBeVisible();
    await expect(page.locator('.timeline')).toContainText(/Claim status changed|claim/);
    await objectCard.getByRole('button', { name: `${prefix} · 猜想`, exact: false }).click();
    await expect(page.getByRole('dialog')).toContainText('Test-only parameters n=1..3');
  });

  test('exercise/template → real sets/cardio → complete → edit preserved workout history', async ({
    page,
  }) => {
    await page.goto('/fitness');
    await page.getByRole('button', { name: 'Exercise library', exact: true }).click();
    await page.getByRole('button', { name: 'Add exercise', exact: true }).first().click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Exercise name').fill(`${prefix} · Bench Press`);
    await dialog.getByRole('button', { name: 'Save exercise', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByRole('button', { name: 'Create template', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Template name').fill(`${prefix} · Upper`);
    await dialog.getByRole('button', { name: 'Add exercise', exact: true }).click();
    await dialog.getByLabel('Exercise 1', { exact: true }).selectOption({ label: `${prefix} · Bench Press` });
    await dialog.getByLabel('Weight (kg)', { exact: true }).fill('20');
    await dialog.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page
      .locator('.template-card')
      .filter({ hasText: `${prefix} · Upper` })
      .getByRole('button', { name: 'Start workout', exact: true })
      .click();
    await expect(page).toHaveURL(/\/fitness\/[0-9a-f-]+$/);
    const sessionId = page.url().split('/').at(-1)!;
    await expect(
      page
        .locator('.session-exercise')
        .getByRole('heading', { name: `${prefix} · Bench Press`, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add set', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('External weight').fill('100');
    await dialog.getByLabel('Weight unit').selectOption('lb');
    await dialog.getByLabel('Repetitions').fill('5');
    await dialog.getByLabel('RPE').fill('7');
    await dialog.getByRole('button', { name: 'Save set', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('100 lb', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cardio', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Activity type').fill('Test Run');
    await dialog.getByLabel('Minutes', { exact: true }).fill('20');
    await dialog.getByLabel('Distance', { exact: true }).fill('2');
    await dialog.getByLabel('Average heart rate').fill('145');
    await dialog.getByRole('button', { name: 'Save cardio entry', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Complete workout', exact: true }).click();
    await expect(
      page.getByText('Workout saved. You can still edit exercises, sets, and notes; statistics will update.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Edit set', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('External weight').fill('110');
    await dialog.getByRole('button', { name: 'Save set', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText('110 lb', { exact: true })).toBeVisible();
    const session = await (await page.request.get(`/api/v1/fitness/sessions/${sessionId}`)).json();
    expect(session.status).toBe('completed');
    expect(session.sets).toHaveLength(1);
    expect(Number(session.sets[0].weight_kg)).toBeCloseTo(49.8951607, 5);
    expect(Number(session.cardio[0].distance_meters)).toBe(2000);
    await page.getByRole('link', { name: '← Workout history', exact: true }).click();
    await expect(
      page
        .locator('.session-card')
        .filter({ hasText: `${prefix} · Upper` })
        .getByText('Completed', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Progress', exact: true }).click();
    await page.getByLabel('Compare exercise').selectOption({ label: `${prefix} · Bench Press` });
    await expect(
      page.getByRole('img', { name: 'Maximum weight progression for this exercise, in kg' }),
    ).toBeVisible();
  });

  test('category subscription → scheduled ingestion → save/read → reading task', async ({ page }) => {
    await page.goto('/discover');
    await page.getByRole('button', { name: 'Add subscription', exact: true }).first().click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Match value').fill('math.AC');
    await dialog.getByRole('button', { name: 'Save subscription', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(async () => {
      await page.getByRole('button', { name: 'Refresh feed', exact: true }).click();
      await expect(
        page.locator('.paper-card').filter({ hasText: 'PRISM E2E metadata fixture' }),
      ).toBeVisible();
    }).toPass({ timeout: 25000, intervals: [1000, 2000] });
    const paper = page.locator('.paper-card').filter({ hasText: 'PRISM E2E metadata fixture' });
    await expect(paper.getByRole('link', { name: 'PDF', exact: true })).toHaveAttribute(
      'href',
      /https:\/\/arxiv.org\/pdf\//,
    );
    await paper.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(paper.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    await paper.getByRole('button', { name: 'Create reading task', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reading task', { exact: true }).fill(`${prefix} · 读论文`);
    await dialog.getByLabel('Estimated minutes').fill('45');
    await dialog.getByRole('button', { name: 'Create reading task', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await paper.getByRole('button', { name: 'Mark as read', exact: true }).click();
    await page.getByRole('button', { name: 'Saved', exact: true }).first().click();
    const saved = page.locator('.paper-card').filter({ hasText: 'PRISM E2E metadata fixture' });
    await expect(saved.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
    await expect(saved.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    const tasks = await (await page.request.get('/api/v1/tasks?limit=500')).json();
    expect(
      tasks.items.filter(
        (t: { title: string; source_type: string }) =>
          t.title === `${prefix} · 读论文` && t.source_type === 'reading',
      ),
    ).toHaveLength(1);
  });

  test('capacity, pin, manual reorder, completion and overloaded schedule stay explicit', async ({
    page,
  }) => {
    await page.goto('/planner');
    await createTask(page, `${prefix} · 优先行动`, 15, true);
    await createTask(page, `${prefix} · 长任务`, 90);
    await createTask(page, `${prefix} · 小任务`, 5);
    await page.getByRole('spinbutton', { name: 'Daily capacity in minutes' }).fill('180');
    await page.getByRole('button', { name: /^(Generate plan|Replan)$/ }).click();
    const pinned = page.locator('.task-row').filter({ hasText: `${prefix} · 优先行动` });
    await expect(pinned).toBeVisible();
    const before = await page.locator('.task-row h3').allTextContents();
    await pinned.locator('summary[aria-label="Task options"]').click();
    await pinned.getByRole('button', { name: 'Move down', exact: true }).click();
    await expect(async () => {
      const after = await page.locator('.task-row h3').allTextContents();
      expect(after).not.toEqual(before);
    }).toPass();
    await page.getByRole('spinbutton', { name: 'Daily capacity in minutes' }).fill('0');
    await page.getByRole('button', { name: 'Replan', exact: true }).click();
    await expect(page.getByText(/Pinned tasks and hard deadlines exceed capacity/)).toBeVisible();
    await expect(pinned).toBeVisible();
    await pinned.getByRole('button', { name: `Complete ${prefix} · 优先行动`, exact: true }).click();
    await page.locator('.plan-toolbar').getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(page.locator('.task-row').filter({ hasText: `${prefix} · 优先行动` })).toBeVisible();
    await page.locator('.task-pool > summary').click();
    await expect(page.locator('.task-pool-list')).toContainText(`${prefix} · 长任务`);
  });

  test('quick capture Inbox classification, preferences and private export download', async ({
    page,
  }, testInfo) => {
    await page.goto('/today');
    await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Content').fill(`${prefix} · Inbox 想法`);
    await dialog.getByRole('button', { name: 'Save capture', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const row = page.locator('.inbox-row').filter({ hasText: `${prefix} · Inbox 想法` });
    await row.getByRole('button', { name: 'Save as knowledge', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.goto('/knowledge');
    await page.getByPlaceholder('Search knowledge titles or content…').fill(`${prefix} · Inbox`);
    await expect(page.locator('.knowledge-card').filter({ hasText: `${prefix} · Inbox 想法` })).toBeVisible();
    await page.goto('/settings');
    await page.getByLabel('FSRS desired retention').fill('0.91');
    await page.getByLabel('Default daily capacity (minutes)').fill('120');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(
      page.getByText('Preferences saved. Future scheduling will use these settings.'),
    ).toBeVisible();
    const [createdResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/v1/exports') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create full export', exact: true }).click(),
    ]);
    const createdExport = await createdResponse.json();
    const downloadLink = page.getByRole('link', { name: 'Download ZIP', exact: true });
    try {
      await expect(downloadLink).toBeVisible({ timeout: 20000 });
    } catch (error) {
      const jobs = await (await page.request.get('/api/v1/automation/jobs?limit=100')).json();
      const state = createdExport.id
        ? await (await page.request.get(`/api/v1/exports/${createdExport.id}`)).json()
        : createdExport;
      await testInfo.attach('export-diagnostics.json', {
        body: JSON.stringify({ jobs, state }, null, 2),
        contentType: 'application/json',
      });
      console.error('Export diagnostics', JSON.stringify({ jobs, state }));
      throw error;
    }
    const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/i);
    const destination = testInfo.outputPath('prism-export.zip');
    await download.saveAs(destination);
    const file = await readFile(destination);
    expect(file.subarray(0, 2).toString()).toBe('PK');
    expect(file.length).toBeGreaterThan(500);
  });

  test('430px navigation and keyboard modal remain operable without page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto('/today');
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Knowledge', exact: true })
      .click();
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(page.getByRole('button', { name: 'New knowledge', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.keyboard.press('Meta+k');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Search and navigate', exact: true })).toBeVisible();
    await expect(dialog.getByPlaceholder('Search knowledge titles or keywords…')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Capture a thought', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
