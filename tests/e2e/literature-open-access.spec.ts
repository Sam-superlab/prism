import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { pdfWithImageAndRepeatedMargins } from './pdf-fixture';

test('finds and explicitly attaches a verified arXiv PDF through the local attachment workflow', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = 'Synthetic OA source ' + id;
  const path = `/api/v1/research/references/${id}`;
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, arxiv_id: '2611.99998v1' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  const requestLog: string[] = [];
  page.on('request', (incoming) => {
    if (incoming.url().includes('/open-access')) requestLog.push(incoming.method());
  });
  await expect(attachments.getByText('No attachments.')).toBeVisible();
  expect(requestLog).toEqual([]);

  await attachments.getByRole('button', { name: 'Find open-access PDF' }).click();
  await expect(attachments.getByText('arXiv preprint · 2611.99998v1')).toBeVisible();
  await expect(attachments.getByRole('link', { name: 'Open source' })).toHaveAttribute(
    'href',
    'https://arxiv.org/abs/2611.99998v1',
  );
  expect(requestLog).toEqual(['GET']);
  const empty = await request.get(path + '/attachments');
  expect((await empty.json()).items).toEqual([]);

  await attachments.getByRole('button', { name: 'Attach this PDF' }).click();
  await expect(attachments.getByText('PDF saved to this reference.')).toBeVisible();
  await expect(
    attachments.getByRole('button', { name: 'arxiv-2611.99998v1.pdf', exact: true }),
  ).toBeVisible();
  expect(requestLog).toEqual(['GET', 'POST']);
  const { items } = await (await request.get(path + '/attachments')).json();
  expect(items).toHaveLength(1);
  const downloaded = await request.get(`/api/v1/research/attachments/${items[0].id}/download`);
  expect(downloaded.headers()['content-type']).toBe('application/pdf');
  expect(await downloaded.body()).toEqual(pdfWithImageAndRepeatedMargins());
});
