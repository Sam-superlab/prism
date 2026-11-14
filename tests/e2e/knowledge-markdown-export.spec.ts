import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('copies and downloads the raw Markdown of an item or selected chapter', async ({
  context,
  page,
  request,
  baseURL,
}) => {
  const subject = 'Markdown Export Fixture';
  const content = 'A statement with $x^2$.\n\n$$\n\\dim V=n\n$$\n\n- Markdown list item';
  const proof = 'An editable explanation with $\\alpha$.\n\nSecond paragraph.';
  const source = 'Fixture textbook, p. 12';
  async function create(title: string, number: string) {
    const id = randomUUID();
    const response = await request.post('/api/v1/knowledge-items', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: {
        id,
        title,
        type: 'theorem',
        subject,
        tags: [`chapter:${number.split('.')[0]}`, `entry:${number}`],
        content,
        proof_content: proof,
        source_reference: source,
      },
    });
    expect(response.status()).toBe(201);
    return id;
  }

  const id = await create('First Markdown theorem', '12.2');
  await create('Second Markdown theorem', '12.10');
  await create('Outside Markdown selection', '13.1');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await page.goto(`/knowledge/${id}`);
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const raw = dialog.getByRole('textbox', { name: 'Markdown source' });
  const single = await raw.inputValue();
  expect(single).toContain('# First Markdown theorem\n\n');
  expect(single).toContain(content);
  expect(single).toContain(proof);
  expect(single).toContain(`Source: ${source}`);
  expect(single).not.toContain('Second Markdown theorem');
  await dialog.getByRole('button', { name: 'Copy Markdown', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Markdown copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(single);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: 'Download Markdown', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('First Markdown theorem.md');
  expect(await readFile(await download.path(), 'utf8')).toBe(single);

  await page.goto('/knowledge/export');
  await page.getByLabel('Subject', { exact: true }).selectOption(subject);
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const collection = await raw.inputValue();
  expect(collection).toMatch(/## First Markdown theorem[\s\S]*## Second Markdown theorem/);
  expect(collection).toContain(content);
  expect(collection).not.toContain('Outside Markdown selection');
  expect(collection).not.toContain(proof);

  await page.keyboard.press('Escape');
  await page.getByLabel('Include proofs and explanations', { exact: true }).check();
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const withProofs = await raw.inputValue();
  expect(withProofs).toContain(proof);
  const [chapterDownload] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: 'Download Markdown', exact: true }).click(),
  ]);
  expect(chapterDownload.suggestedFilename()).toMatch(/Chapter 12\.md$/);
  expect(await readFile(await chapterDownload.path(), 'utf8')).toBe(withProofs);
});
