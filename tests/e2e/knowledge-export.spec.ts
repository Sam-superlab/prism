import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('exports inclusive chapter and entry ranges or one selected item', async ({
  page,
  request,
  baseURL,
}) => {
  const subject = 'PDF Export Geometry';
  async function create(title: string, number: string, type: string, itemSubject = subject) {
    const id = randomUUID();
    const response = await request.post('/api/v1/knowledge-items', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: {
        id,
        title,
        type,
        subject: itemSubject,
        tags: [`chapter:${number.split('.')[0]}`, `entry:${number}`, 'textbook-pages:6'],
        content: 'A statement with $x^2$.',
        proof_content: 'Optional explanation.',
        source_reference: 'Fixture textbook, textbook p. 6.',
        verification_status: 'unverified',
      },
    });
    expect(response.status()).toBe(201);
    return `entry-${id}`;
  }

  const last = await create('Outside selected range', '2.1', 'theorem');
  const later = await create('Later theorem', '1.10', 'theorem');
  const note = await create('A study note', '1.3', 'note');
  const first = await create('First definition', '1.2', 'definition');
  await create('Another subject', '1.7', 'theorem', 'Unrelated PDF Subject');

  await page.addInitScript(() => {
    window.print = () => document.documentElement.setAttribute('data-print-invoked', 'true');
  });
  await page.goto('/knowledge');
  await page.getByRole('link', { name: 'Export PDF', exact: true }).click();
  const preview = page.getByRole('article', { name: 'PDF preview' });
  const statements = preview.locator('section[id^="entry-"]');
  const statementIds = () => statements.evaluateAll((elements) => elements.map((entry) => entry.id));

  await page.getByLabel('Subject', { exact: true }).selectOption(subject);
  await page.getByLabel('Through chapter', { exact: true }).selectOption('2');
  await expect(statements).toHaveCount(4);
  expect(await statementIds()).toEqual([first, note, later, last]);
  await expect(preview.getByRole('link', { name: 'Theorem 1.10', exact: true })).toHaveAttribute(
    'href',
    `#${later}`,
  );

  await page.getByLabel('Selection', { exact: true }).selectOption('entries');
  await page.getByLabel('Subject', { exact: true }).selectOption(subject);
  await page
    .getByLabel('From entry', { exact: true })
    .selectOption({ label: 'Definition 1.2 · First definition' });
  await page
    .getByLabel('Through entry', { exact: true })
    .selectOption({ label: 'Theorem 1.10 · Later theorem' });
  await expect(statements).toHaveCount(3);
  expect(await statementIds()).toEqual([first, note, later]);
  await page.getByLabel('Include study notes', { exact: true }).uncheck();
  await expect(statements).toHaveCount(2);
  expect(await statementIds()).toEqual([first, later]);

  await page.getByLabel('Selection', { exact: true }).selectOption('items');
  await page.getByRole('checkbox', { name: /Later theorem/ }).check();
  await expect(statements).toHaveCount(1);
  expect(await statementIds()).toEqual([later]);
  await expect(preview.locator('.katex')).toBeVisible();
  await expect(preview.getByText('Optional explanation.')).toHaveCount(0);
  await page.getByLabel('Include proofs and explanations', { exact: true }).check();
  await expect(preview.getByText('Optional explanation.')).toBeVisible();
  await page.getByRole('button', { name: 'Save as PDF', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-print-invoked', 'true');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('heading', { name: 'Export knowledge' })).toBeHidden();
  await expect(preview).toBeVisible();
  const pdf = await page.pdf({ preferCSSPageSize: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
});
