import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.use({ reducedMotion: 'reduce' });

test('updates the local graph, zooms and drags, then opens a linked research object', async ({
  page,
  request,
  baseURL,
}) => {
  const note = randomUUID();
  const project = randomUUID();
  const object = randomUUID();
  const create = (path: string, data: { id: string; title: string } & Record<string, string>) =>
    request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL!, 'Idempotency-Key': data.id },
      data,
    });
  expect(
    (
      await create('knowledge-items', {
        id: note,
        title: 'Graph fixture note',
        type: 'definition',
        content: 'Synthetic definition.',
      })
    ).status(),
  ).toBe(201);
  expect((await create('research/projects', { id: project, title: 'Graph fixture project' })).status()).toBe(
    201,
  );
  expect(
    (
      await create(`research/projects/${project}/objects`, {
        id: object,
        title: 'Graph fixture question',
        object_type: 'question',
        content: 'Synthetic question.',
        claim_status: 'needs_verification',
      })
    ).status(),
  ).toBe(201);

  await page.goto('/planner');
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Planner', exact: true })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Workspace Graph' }).click();
  await expect(page).toHaveURL(/\/graph$/);
  await expect(page.getByRole('region', { name: 'Workspace Graph', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace Graph', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Graph fixture note · Knowledge' }).locator('circle').first().click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/${note}$`));
  const local = page.getByRole('region', { name: 'Local graph', exact: true });
  await expect(local.getByText('No connections yet.')).toBeVisible();
  const connections = page.getByRole('region', { name: 'Research connections' });
  await connections.getByRole('button', { name: 'Link to research' }).click();
  const link = page.getByRole('dialog', { name: 'Link to research' });
  await link.getByLabel('Research project', { exact: true }).selectOption(project);
  await link.getByRole('button', { name: 'Create link', exact: true }).click();
  await expect(link.getByRole('link', { name: 'Graph fixture project' })).toBeVisible();
  await link.getByRole('button', { name: 'Close' }).click();
  await expect(local.getByRole('link', { name: 'Graph fixture project · Projects' })).toBeVisible();
  await local.getByRole('button', { name: 'Expand graph' }).click();

  const graph = page.getByRole('dialog', { name: 'Graph view' });
  const question = graph.getByRole('link', { name: 'Graph fixture question · Research objects' });
  await expect(question).toBeVisible();
  await graph.getByRole('button', { name: 'Graph settings' }).click();
  const scene = graph.locator('svg[aria-label="Interactive connection graph"]');
  await scene.evaluate((svg) => svg.setAttribute('data-test-instance', 'retained'));
  const depth = graph.getByRole('slider', { name: /Depth/ });
  await depth.press('ArrowLeft');
  await expect(question).toHaveCount(0);
  await expect(scene).toHaveAttribute('data-test-instance', 'retained');
  await depth.press('ArrowRight');
  await expect(question).toBeVisible();
  await expect(scene).toHaveAttribute('data-test-instance', 'retained');
  await graph.getByText('Display', { exact: true }).click();
  const beforeDisplay = await question.getAttribute('transform');
  await graph.getByRole('switch', { name: 'Arrows' }).check();
  await expect(graph.locator('line[marker-end]').first()).toBeVisible();
  await expect(question).toHaveAttribute('transform', beforeDisplay!);
  await graph.getByRole('switch', { name: 'Arrows' }).uncheck();
  await graph.getByRole('button', { name: 'Graph settings' }).click();
  await question.locator('circle').first().click({ button: 'right' });
  await expect(graph.getByRole('button', { name: 'Focus here' })).toBeVisible();
  await graph.getByRole('button', { name: 'Dismiss graph actions' }).click();
  const zoom = graph.getByRole('button', { name: 'Reset graph view' });
  const beforeZoom = await zoom.textContent();
  await graph.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText(beforeZoom!);
  await zoom.click();
  await question.locator('circle').first().hover();
  await expect(graph.locator('line[data-active="true"]').first()).toBeVisible();
  const point = (await question.locator('circle').first().boundingBox())!;
  const beforeDrag = await question.getAttribute('transform');
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x + point.width / 2 + 38, point.y + point.height / 2 + 24);
  await page.mouse.up();
  await expect(question).not.toHaveAttribute('transform', beforeDrag!);
  await question.locator('circle').first().click();
  await expect(page).toHaveURL(new RegExp(`/research/${project}\\?object=${object}$`));
  const objectDialog = page.getByRole('dialog', { name: 'Graph fixture question' });
  await expect(objectDialog.getByRole('region', { name: 'Local graph' })).toBeVisible();
  await objectDialog.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(new RegExp(`/research/${project}$`));
});
