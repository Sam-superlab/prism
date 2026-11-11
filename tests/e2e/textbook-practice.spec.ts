import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const book = 'Synthetic Algebra Textbook';
const chapter = 'Groups';
const original = 'Prove that the synthetic operation is associative.';
const edited = 'For the synthetic operation, verify associativity.';
const work = 'Synthetic scratch work: compare the two products.';
const exerciseText = [
  'Exercises',
  '1. Identify the neutral element of the example operation.',
  `2. ${original}`,
  '3. Determine the inverse of the example element.',
].join('\n');

async function openTextImport(page: Page, source = exerciseText) {
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Source format', { exact: true }).selectOption('text');
  await dialog.getByLabel('Book title', { exact: true }).fill(book);
  await dialog.getByLabel('Chapter', { exact: true }).fill(chapter);
  await dialog.getByLabel('Exercise text', { exact: true }).fill(source);
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();
  return dialog;
}

function pdfDocument(objects: string[]): Buffer {
  let document = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f '];
  objects.forEach((object, index) => {
    offsets.push(`${String(Buffer.byteLength(document)).padStart(10, '0')} 00000 n `);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const tableOffset = Buffer.byteLength(document);
  return Buffer.from(
    `${document}xref\n0 ${offsets.length}\n${offsets.join('\n')}\ntrailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${tableOffset}\n%%EOF\n`,
  );
}

function syntheticPdf(): Buffer {
  const streams = [
    ['Exercises', '1. Exercise on the excluded first page.'],
    ['Exercises', '9. Find the neutral element on the selected page.'],
  ].map(
    (lines, index) =>
      `BT /F1 12 Tf 60 720 Td ${lines.map((line) => `(${line}) Tj`).join(' 0 -24 Td ')} ET\n` +
      `BT /F1 12 Tf 300 90 Td (${16 + index}) Tj ET`,
  );
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /D /St 16 >>] >> >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  return pdfDocument(objects);
}

function pdfWithPositionedMath(): Buffer {
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    // Smaller offset runs encode scripts, without Unicode or LaTeX markers in the PDF.
    'BT /F1 12 Tf 60 688 Td (1. Compare ) Tj ET',
    'BT /F2 12 Tf 126.024 688 Td (x) Tj ET',
    'BT /F2 8 Tf 131.352 686.2 Td (1) Tj ET',
    'BT /F1 12 Tf 135.352 688 Td ( with ) Tj ET',
    'BT /F2 12 Tf 163.36 688 Td (x) Tj ET',
    'BT /F2 8 Tf 168.688 692.2 Td (n-1) Tj ET',
    'BT /F1 12 Tf 179.352 688 Td (.) Tj ET',
    // The bar ends at the last radicand glyph. The adjacent +2 belongs outside.
    'BT /F1 12 Tf 60 656 Td (2. Evaluate ) Tj ET',
    'BT /F3 12 Tf 123.372 665.4 Td <D6> Tj ET',
    'BT /F2 12 Tf 129.96 656 Td (-5) Tj ET',
    'BT /F1 12 Tf 140.456 656 Td (+2.) Tj ET',
    'q 1 0 0 1 129.96 665.4 cm .4 w 0 0 m 9.996 0 l S Q',
    // A root symbol without a matching bar gives no reliable endpoint.
    'BT /F1 12 Tf 60 624 Td (3. Check ) Tj ET',
    'BT /F3 12 Tf 114.684 633.4 Td <D6> Tj ET',
    'BT /F2 12 Tf 121.272 624 Td (-5) Tj ET',
    'BT /F1 12 Tf 131.268 624 Td (.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
  ]);
}

function pdfWithMathFonts(): Buffer {
  // Each styled glyph decodes as ASCII. The PDF font names carry the style evidence.
  const fontNames = ['ABCDEF+MSBM10', 'GHIJKL+CMSY10', 'MNOPQR+RSFS10', 'DecorativeScript'];
  const fontResources = fontNames.map((_, index) => `/F${index + 2} ${6 + index} 0 R`).join(' ');
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    'BT /F1 12 Tf 60 688 Td (1. Compare ) Tj /F2 12 Tf (Z) Tj /F1 12 Tf (, ) Tj',
    '/F3 12 Tf (A) Tj /F1 12 Tf (, and ) Tj /F4 12 Tf (B) Tj /F1 12 Tf ( with Z.) Tj ET',
    'BT /F1 12 Tf 60 656 Td (2. Inspect ) Tj /F5 12 Tf (Q) Tj /F1 12 Tf (.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R ${fontResources} >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...fontNames.map(
      (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
    ),
  ]);
}

function pdfWithFractionsAndSums(): Buffer {
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    // The numerator and denominator use separate text runs and a drawn rule.
    'BT /F1 12 Tf 60 688 Td (1. Find ) Tj ET',
    'BT /F2 10 Tf 118.5 700 Td (x+1) Tj ET',
    'q .4 w 115 692 m 139 692 l S Q',
    'BT /F2 10 Tf 124.5 681 Td (2) Tj ET',
    'BT /F1 12 Tf 144 688 Td (+3.) Tj ET',
    // The upper and lower bounds are placed over and under the Symbol glyph.
    'BT /F1 12 Tf 60 650 Td (2. Find ) Tj ET',
    'BT /F3 16 Tf 115 650 Td <E5> Tj ET',
    'BT /F2 8 Tf 118.5 660 Td (n) Tj ET',
    'BT /F2 8 Tf 115 641 Td (i=1) Tj ET',
    'BT /F2 12 Tf 136 650 Td (x.) Tj ET',
    // A raised expression over a fraction-like bar has no readable denominator.
    'BT /F1 12 Tf 60 608 Td (3. Inspect ) Tj ET',
    'BT /F2 10 Tf 117.5 620 Td (x+1) Tj ET',
    'q .4 w 115 612 m 137 612 l S Q',
    'BT /F1 12 Tf 144 608 Td (.) Tj ET',
    // Two separate rows above the glyph make ownership of the upper limit uncertain.
    'BT /F1 12 Tf 60 558 Td (4. Inspect ) Tj ET',
    'BT /F3 16 Tf 115 558 Td <E5> Tj ET',
    'BT /F2 8 Tf 118.5 567 Td (m) Tj ET',
    'BT /F2 8 Tf 118.5 574 Td (n) Tj ET',
    'BT /F2 12 Tf 136 558 Td (x.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
  ]);
}

function pdfWithLimitApproaches(): Buffer {
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    // A smaller condition centered below the operator.
    'BT /F1 12 Tf 60 688 Td (1. Find ) Tj ET',
    'BT /F4 12 Tf 120 688 Td (lim) Tj ET',
    'BT /F2 8 Tf 119 679 Td (x) Tj /F3 8 Tf <AE> Tj /F2 8 Tf (0) Tj ET',
    'BT /F2 12 Tf 160 688 Td (x.) Tj ET',
    // The right-side condition belongs to the full multiword operator.
    'BT /F1 12 Tf 60 646 Td (2. Find ) Tj ET',
    'BT /F4 12 Tf 120 646 Td (lim sup) Tj ET',
    'BT /F2 8 Tf 154 643 Td (n) Tj /F3 8 Tf <AEA5> Tj ET',
    'BT /F2 12 Tf 183 646 Td (a.) Tj ET',
    // The operator's two words can be separate PDF text items.
    'BT /F1 12 Tf 60 604 Td (3. Find ) Tj ET',
    'BT /F4 12 Tf 120 604 Td (lim) Tj ET',
    'BT /F1 12 Tf 138 604 Td (inf) Tj ET',
    'BT /F2 8 Tf 127 595 Td (n) Tj /F3 8 Tf <AEA5> Tj ET',
    'BT /F2 12 Tf 180 604 Td (b.) Tj ET',
    // Both rows are close enough to plausibly belong to the same operator.
    'BT /F1 12 Tf 60 554 Td (4. Inspect ) Tj ET',
    'BT /F4 12 Tf 120 554 Td (lim) Tj ET',
    'BT /F2 8 Tf 119 545 Td (x) Tj /F3 8 Tf <AE> Tj /F2 8 Tf (0) Tj ET',
    'BT /F2 8 Tf 119 537 Td (x) Tj /F3 8 Tf <AE> Tj /F2 8 Tf (1) Tj ET',
    'BT /F2 12 Tf 160 554 Td (x.) Tj ET',
    'BT /F1 12 Tf 60 504 Td (5. Read the word lim in this sentence.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
  ]);
}

function pdfWithIntegralAndProductLimits(): Buffer {
  const stream = [
    'BT /F1 12 Tf 60 724 Td (Exercises) Tj ET',
    // The integral's limits sit next to the glyph, with the integrand at its baseline.
    'BT /F1 12 Tf 60 688 Td (1. Find ) Tj ET',
    'BT /F3 16 Tf 115 688 Td <F2> Tj ET',
    'BT /F2 8 Tf 122 698 Td (1) Tj ET',
    'BT /F2 8 Tf 119 679 Td (0) Tj ET',
    'BT /F2 12 Tf 136 688 Td (x dx.) Tj ET',
    // The product uses centered upper and lower limits.
    'BT /F1 12 Tf 60 650 Td (2. Find ) Tj ET',
    'BT /F3 16 Tf 115 650 Td <D5> Tj ET',
    'BT /F2 8 Tf 119.5 660 Td (n) Tj ET',
    'BT /F2 8 Tf 115 641 Td (i=1) Tj ET',
    'BT /F2 12 Tf 136 650 Td (i.) Tj ET',
    // Two separate rows compete for the upper integral limit.
    'BT /F1 12 Tf 60 608 Td (3. Inspect ) Tj ET',
    'BT /F3 16 Tf 115 608 Td <F2> Tj ET',
    'BT /F2 8 Tf 122 617 Td (a) Tj ET',
    'BT /F2 8 Tf 122 624 Td (b) Tj ET',
    'BT /F2 12 Tf 136 608 Td (x dx.) Tj ET',
    // Two separate rows compete for the lower product limit.
    'BT /F1 12 Tf 60 558 Td (4. Inspect ) Tj ET',
    'BT /F3 16 Tf 115 558 Td <D5> Tj ET',
    'BT /F2 8 Tf 115 549 Td (i=1) Tj ET',
    'BT /F2 8 Tf 115 542 Td (i=2) Tj ET',
    'BT /F2 12 Tf 136 558 Td (i.) Tj ET',
    // This upper limit fits either placement on the narrow integral glyph.
    'BT /F1 12 Tf 60 510 Td (5. Inspect ) Tj ET',
    'BT /F3 16 Tf 115 510 Td <F2> Tj ET',
    'BT /F2 8 Tf 119 522 Td (b) Tj ET',
    'BT /F2 12 Tf 136 510 Td (x dx.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
  ]);
}

function pdfWithMathGrids(): Buffer {
  const stream = [
    'BT /F1 12 Tf 60 738 Td (Exercises) Tj ET',
    // Tall parentheses enclose two rows and two aligned columns.
    'BT /F1 12 Tf 60 690 Td (1. Inspect ) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 120 680 Tm (\\() Tj ET',
    'BT /F2 12 Tf 136 698 Td (1) Tj ET',
    'BT /F2 12 Tf 156 698 Td (2) Tj ET',
    'BT /F2 12 Tf 136 684 Td (3) Tj ET',
    'BT /F2 12 Tf 156 684 Td (4) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 174 680 Tm (\\)) Tj ET',
    'BT /F1 12 Tf 181 690 Td (.) Tj ET',
    // The brace encloses expressions at the left and their conditions at the right.
    'BT /F1 12 Tf 60 630 Td (2. Inspect ) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 120 620 Tm ({) Tj ET',
    'BT /F2 12 Tf 134 638 Td (x) Tj ET',
    'BT /F1 12 Tf 173 638 Td (if x > 0) Tj ET',
    'BT /F2 12 Tf 134 624 Td (0) Tj ET',
    'BT /F1 12 Tf 173 624 Td (otherwise) Tj ET',
    'BT /F1 12 Tf 234 630 Td (.) Tj ET',
    // A matrix row with a missing entry does not identify a complete grid.
    'BT /F1 12 Tf 60 570 Td (3. Inspect ) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 120 560 Tm ([) Tj ET',
    'BT /F2 12 Tf 136 578 Td (1) Tj ET',
    'BT /F2 12 Tf 156 578 Td (2) Tj ET',
    'BT /F2 12 Tf 146 564 Td (3) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 174 560 Tm (]) Tj ET',
    'BT /F1 12 Tf 181 570 Td (.) Tj ET',
    // This condition sits between the two expression baselines.
    'BT /F1 12 Tf 60 510 Td (4. Inspect ) Tj ET',
    'BT /F2 12 Tf 1 0 0 3 120 500 Tm ({) Tj ET',
    'BT /F2 12 Tf 134 518 Td (x) Tj ET',
    'BT /F1 12 Tf 173 511 Td (if x > 0) Tj ET',
    'BT /F2 12 Tf 134 504 Td (0) Tj ET',
    'BT /F1 12 Tf 234 510 Td (.) Tj ET',
    'BT /F1 12 Tf 60 468 Td (5. Compare \\(1, 2\\) and {3, 4}.) Tj ET',
  ].join('\n');
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
  ]);
}

test('reviews, edits, and saves selected exercises, then resumes the stuck exercise after reload', async ({
  page,
}) => {
  const sentExerciseData: string[] = [];
  page.on('request', (request) => {
    const body = request.postData() ?? '';
    if ([original, edited, work].some((value) => body.includes(value))) sentExerciseData.push(request.url());
  });
  await page.goto('/practice');
  const dialog = await openTextImport(page);
  const statement = dialog.getByLabel('Exercise 2 statement', { exact: true });
  await expect(statement).toHaveValue(original);
  await statement.fill(edited);
  const candidate = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  await expect(candidate.getByText(`2. ${original}`, { exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Include exercise 3', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save selected exercises', exact: true }).click();
  await expect(dialog).toBeHidden();

  const second = page.getByRole('button', { name: /^Exercise 2\b/i });
  await second.click();
  await expect(page.getByRole('button', { name: /^Exercise 3\b/i })).toHaveCount(0);
  await expect(page.getByText(edited, { exact: true })).toBeVisible();
  await page.getByLabel('Work for this attempt (optional)', { exact: true }).fill(work);
  await page.getByRole('button', { name: 'Stuck', exact: true }).click();
  await expect(page.getByText('Recorded: Stuck', { exact: true })).toBeVisible();

  const reimport = await openTextImport(page);
  await reimport.getByRole('checkbox', { name: 'Include exercise 3', exact: true }).uncheck();
  await reimport.getByRole('button', { name: 'Save selected exercises', exact: true }).click();
  await expect(page.getByText('Saved 0 exercises. Skipped 2 already saved.', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Start practice set', exact: true }).click();
  await expect(page.getByText('Practice set · 1 of 2', { exact: true })).toBeVisible();
  const details = page.getByRole('article', { name: 'Practice exercise 2' });
  await expect(details.getByText(edited, { exact: true })).toBeVisible();
  await expect(details.getByText(/Stuck on your last attempt/)).toBeVisible();
  await details.getByText('Original extracted text', { exact: true }).click();
  await expect(details.getByText(`2. ${original}`, { exact: true })).toBeVisible();
  await details.getByText('Attempt history (1)', { exact: true }).click();
  await expect(details.getByText(work, { exact: true })).toBeVisible();
  expect(sentExerciseData).toEqual([]);
});

test('keeps the import dialog open on file-picker cancellation but closes it on Escape', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = dialog.getByLabel('Book title', { exact: true });
  await title.fill('Synthetic PDF textbook');
  await dialog.getByLabel('Textbook PDF', { exact: true }).dispatchEvent('cancel', { bubbles: true });
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue('Synthetic PDF textbook');
  await title.press('Escape');
  await expect(dialog).toBeHidden();
});

test('converts imported notation to LaTeX, previews edits, and retains the source excerpt', async ({
  page,
}) => {
  await page.goto('/practice');
  const source = '1. Let A ⊆ Λ.';
  const dialog = await openTextImport(page, `Exercises\n${source}`);
  const candidate = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  const statement = candidate.getByLabel('Exercise 1 statement', { exact: true });
  const preview = candidate.getByRole('region', { name: 'Rendered preview' });
  const annotation = 'annotation[encoding="application/x-tex"]';

  await expect(statement).toHaveValue(String.raw`Let $A \subseteq \Lambda$.`);
  await expect(preview.locator('.katex')).toBeVisible();
  await expect(preview.locator(annotation)).toHaveText(String.raw`A \subseteq \Lambda`);
  await statement.fill(String.raw`Let $A \subsetneq \Lambda$.`);
  await expect(preview.locator(annotation)).toHaveText(String.raw`A \subsetneq \Lambda`);
  await expect(candidate.getByText(source, { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'Save selected exercises', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const details = page.getByRole('article', { name: 'Practice exercise 1' });
  await expect(details.locator(annotation)).toHaveText(String.raw`A \subsetneq \Lambda`);
  await details.getByText('Original extracted text', { exact: true }).click();
  await expect(details.getByText(source, { exact: true })).toBeVisible();

  await details.getByRole('button', { name: 'Edit exercise', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit exercise 1' });
  const savedStatement = edit.getByLabel('Exercise statement', { exact: true });
  await savedStatement.fill('Let A ⊆ Λ.');
  await edit.getByRole('button', { name: 'Convert symbols to LaTeX', exact: true }).click();
  await expect(savedStatement).toHaveValue(String.raw`Let $A \subseteq \Lambda$.`);
  await expect(edit.getByRole('region', { name: 'Rendered preview' }).locator(annotation)).toHaveText(
    String.raw`A \subseteq \Lambda`,
  );
  await edit.getByRole('button', { name: 'Save exercise', exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(details.locator(annotation)).toHaveText(String.raw`A \subseteq \Lambda`);
});

test('extracts only the selected page from a local text PDF and removes its footer', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic PDF textbook');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Selected section');
  const pdf = syntheticPdf();
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    dialog.getByLabel('Textbook PDF', { exact: true }).click(),
  ]);
  await picker.setFiles({
    name: 'synthetic-textbook.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  await dialog.getByLabel('First PDF page', { exact: true }).fill('2');
  await dialog.getByLabel('Last PDF page', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();
  await expect(dialog.getByLabel('Exercise 9 statement', { exact: true })).toHaveValue(
    'Find the neutral element on the selected page.',
  );
  await expect(dialog.getByRole('checkbox', { name: 'Include exercise 9' })).toBeChecked();
  await expect(dialog.getByLabel('Exercise 1 statement', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save selected exercises', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const details = page.getByRole('article', { name: 'Practice exercise 9' });
  await expect(
    details.getByText('Find the neutral element on the selected page.', { exact: true }),
  ).toBeVisible();
  await expect(details.getByText(/PDF page 2/)).toBeVisible();
  await details.getByText('Original extracted text', { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    details.getByRole('button', { name: 'Download original PDF', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('synthetic-textbook.pdf');
  expect(await readFile(await download.path())).toEqual(pdf);
});

test('restores PDF scripts and radical scope, and flags a root with no reliable scope', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic notation textbook');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Positioned mathematics');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'positioned-notation.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithPositionedMath(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  const scripts = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  const scriptSource = scripts.getByLabel('Exercise 1 statement', { exact: true });
  await expect(scriptSource).toHaveValue(/x_(?:\{1\}|1).*x\^\{\s*n\s*-\s*1\s*\}/);
  await expect(scripts.locator('pre')).toContainText('Compare x1 with xn-1');
  const scriptPreview = scripts.getByRole('region', { name: 'Rendered preview' });
  await expect(scriptPreview.locator('.katex-html .msupsub')).toHaveCount(2);
  await expect(scripts.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const root = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  const rootSource = root.getByLabel('Exercise 2 statement', { exact: true });
  await expect(rootSource).toHaveValue(/\\sqrt\{\s*-5\s*\}\$?\s*\+\s*2/);
  const rootPreview = root.getByRole('region', { name: 'Rendered preview' });
  await expect(rootPreview.locator('.katex-html .sqrt')).toBeVisible();
  await expect(root.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const ambiguous = dialog.getByRole('region', { name: 'Extracted exercise 3' });
  const review = ambiguous.getByRole('region', { name: 'Check PDF formulas' });
  await expect(review.locator('mark')).toHaveText('√-5');
  await expect(review.getByRole('listitem')).toContainText(/root|radical/i);
  await expect(ambiguous.getByLabel('Exercise 3 statement', { exact: true })).toHaveValue(/√-5/);
});

test('restores PDF math alphabets from font metadata and flags an ambiguous alphabet', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic math fonts');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Font metadata');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'math-fonts.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithMathFonts(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  const styled = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  const statement = styled.getByLabel('Exercise 1 statement', { exact: true });
  await expect(statement).toHaveValue(/\\mathbb\{Z\}.*\\mathcal\{A\}.*\\mathscr\{B\}.*with Z\./);
  await expect(styled.locator('pre')).toContainText('Compare Z, A, and B with Z.');
  const preview = styled.getByRole('region', { name: 'Rendered preview' });
  await expect(preview.locator('.katex-html .mathbb')).toHaveText('Z');
  await expect(preview.locator('.katex-html .mathcal')).toHaveText('A');
  await expect(preview.locator('.katex-html .mathscr')).toHaveText('B');
  await expect(styled.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const ambiguous = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  await expect(ambiguous.getByLabel('Exercise 2 statement', { exact: true })).toHaveValue('Inspect Q.');
  const review = ambiguous.getByRole('region', { name: 'Check PDF formulas' });
  await expect(review.locator('mark')).toHaveText('Q');
  await expect(review.getByRole('listitem')).toContainText(/font|script|calligraph/i);
  await expect(dialog.getByRole('checkbox', { name: 'Include exercise 2' })).toBeChecked();
});

test('reconstructs PDF fractions and summation bounds and flags ambiguous formulas', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic stacked formulas');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Fractions and sums');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'stacked-formulas.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithFractionsAndSums(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  const fraction = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  await expect(fraction.getByLabel('Exercise 1 statement', { exact: true })).toHaveValue(
    /\\frac\{\s*x\s*\+\s*1\s*\}\{\s*2\s*\}[^\n]*\+\s*3/,
  );
  await expect(fraction.locator('pre')).toContainText(/x\+1\s+2/);
  await expect(fraction.getByRole('region', { name: 'Rendered preview' }).locator('mfrac')).toHaveCount(1);
  await expect(fraction.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const sum = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  await expect(sum.getByLabel('Exercise 2 statement', { exact: true })).toHaveValue(
    /\\sum(?:\\limits)?_\{\s*i\s*=\s*1\s*\}\^\{\s*n\s*\}\$?\s*x/,
  );
  await expect(sum.locator('pre')).toContainText('∑');
  const sumPreview = sum.getByRole('region', { name: 'Rendered preview' });
  await expect(sumPreview.locator('munderover, msubsup')).toHaveCount(1);
  await expect(sumPreview.locator('.katex-html .op-limits')).toHaveCount(1);
  await expect(sum.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const ambiguous = dialog.getByRole('region', { name: 'Extracted exercise 3' });
  const review = ambiguous.getByRole('region', { name: 'Check PDF formulas' });
  await expect(review.locator('mark')).toContainText('x+1');
  await expect(review.getByRole('listitem')).toContainText(/fraction|denominator/i);
  await expect(ambiguous.getByLabel('Exercise 3 statement', { exact: true })).not.toHaveValue(/\\frac/);
  await expect(dialog.getByRole('checkbox', { name: 'Include exercise 3' })).toBeChecked();

  const ambiguousSum = dialog.getByRole('region', { name: 'Extracted exercise 4' });
  const sumReview = ambiguousSum.getByRole('region', { name: 'Check PDF formulas' });
  await expect(sumReview.locator('mark')).toContainText('∑');
  await expect(sumReview.getByRole('listitem')).toContainText(/sum|upper|limit/i);
});

test('reconstructs PDF integral and product bounds and flags competing limits', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic operator textbook');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Integrals and products');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'operator-limits.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithIntegralAndProductLimits(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  const integral = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  await expect(integral.getByLabel('Exercise 1 statement', { exact: true })).toHaveValue(
    /\\int(?:\\nolimits)?_\{\s*0\s*\}\^\{\s*1\s*\}\$?\s*x dx/,
  );
  await expect(integral.locator('pre')).toContainText('∫');
  await expect(integral.getByRole('region', { name: 'Rendered preview' }).locator('msubsup')).toHaveCount(1);
  await expect(integral.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const product = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  await expect(product.getByLabel('Exercise 2 statement', { exact: true })).toHaveValue(
    /\\prod\\limits_\{\s*i\s*=\s*1\s*\}\^\{\s*n\s*\}\$?\s*i\./,
  );
  await expect(product.locator('pre')).toContainText('∏');
  await expect(
    product.getByRole('region', { name: 'Rendered preview' }).locator('.katex-html .op-limits'),
  ).toHaveCount(1);
  await expect(product.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  for (const [number, glyph, command] of [
    [3, '∫', 'int'],
    [4, '∏', 'prod'],
    [5, '∫', 'int'],
  ] as const) {
    const candidate = dialog.getByRole('region', { name: 'Extracted exercise ' + number });
    const review = candidate.getByRole('region', { name: 'Check PDF formulas' });
    await expect(review.locator('mark')).toContainText(glyph);
    await expect(review.getByRole('listitem')).toContainText(/limit|bound/i);
    await expect(candidate.getByLabel('Exercise ' + number + ' statement', { exact: true })).not.toHaveValue(
      new RegExp('\\\\' + command + '(?:\\\\(?:no)?limits)?[_^]\\{'),
    );
  }
});

test('reconstructs PDF limit approach conditions and flags competing rows', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic limits textbook');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Limit approaches');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'limit-approaches.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithLimitApproaches(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  for (const [number, latex, body, rendered] of [
    [1, /\\lim\\limits_\{\s*x\s*\\to\s*0\s*\}/, 'x.', '.op-limits'],
    [2, /\\limsup\\nolimits_\{\s*n\s*\\to\s*\\infty\s*\}/, 'a.', 'msub'],
    [3, /\\liminf\\limits_\{\s*n\s*\\to\s*\\infty\s*\}/, 'b.', '.op-limits'],
  ] as const) {
    const candidate = dialog.getByRole('region', { name: 'Extracted exercise ' + number });
    const statement = candidate.getByLabel('Exercise ' + number + ' statement', { exact: true });
    await expect(statement).toHaveValue(latex);
    expect((await statement.inputValue()).trimEnd().endsWith(body)).toBe(true);
    await expect(candidate.locator('pre')).toContainText('→');
    await expect(candidate.getByRole('region', { name: 'Rendered preview' }).locator(rendered)).toHaveCount(
      1,
    );
    await expect(candidate.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);
  }

  const ambiguous = dialog.getByRole('region', { name: 'Extracted exercise 4' });
  const review = ambiguous.getByRole('region', { name: 'Check PDF formulas' });
  await expect(review.locator('mark')).toContainText(/lim\s+x\s*→\s*0\s+x\s*→\s*1/);
  await expect(review.getByRole('listitem')).toContainText(/approach condition/i);
  await expect(ambiguous.getByLabel('Exercise 4 statement', { exact: true })).not.toHaveValue(
    /\\lim(?:\\(?:no)?limits)?_\{/,
  );

  const prose = dialog.getByRole('region', { name: 'Extracted exercise 5' });
  await expect(prose.getByLabel('Exercise 5 statement', { exact: true })).toHaveValue(
    'Read the word lim in this sentence.',
  );
  await expect(prose.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);
});

test('reconstructs PDF matrices and piecewise functions and flags uncertain rows', async ({ page }) => {
  await page.goto('/practice');
  await page.getByRole('button', { name: 'Import exercises', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Book title', { exact: true }).fill('Synthetic arrays textbook');
  await dialog.getByLabel('Chapter', { exact: true }).fill('Matrices and cases');
  await dialog.getByLabel('Textbook PDF', { exact: true }).setInputFiles({
    name: 'math-grids.pdf',
    mimeType: 'application/pdf',
    buffer: pdfWithMathGrids(),
  });
  await dialog.getByRole('button', { name: 'Preview exercises', exact: true }).click();

  const matrix = dialog.getByRole('region', { name: 'Extracted exercise 1' });
  await expect(matrix.getByLabel('Exercise 1 statement', { exact: true })).toHaveValue(
    /^Inspect\s*\$\\begin\{pmatrix\}\s*1\s*&\s*2\s*\\\\\s*3\s*&\s*4\s*\\end\{pmatrix\}\$\s*\.$/,
  );
  const matrixRows = matrix.getByRole('region', { name: 'Rendered preview' }).locator('mtable mtr');
  await expect(matrixRows).toHaveCount(2);
  await expect(matrixRows.nth(0).locator('mtd')).toHaveText(['1', '2']);
  await expect(matrixRows.nth(1).locator('mtd')).toHaveText(['3', '4']);
  await expect(matrix.locator('pre')).toContainText(/\(\s*1\s+2\s+3\s+4\s*\)/);
  await expect(matrix.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  const cases = dialog.getByRole('region', { name: 'Extracted exercise 2' });
  await expect(cases.getByLabel('Exercise 2 statement', { exact: true })).toHaveValue(
    /^Inspect\s*\$\\begin\{cases\}\s*x\s*&.*?if.*?x\s*>\s*0\s*\\\\\s*0\s*&.*?otherwise.*?\\end\{cases\}\$\s*\.$/s,
  );
  const casesRows = cases.getByRole('region', { name: 'Rendered preview' }).locator('mtable mtr');
  await expect(casesRows).toHaveCount(2);
  await expect(casesRows.nth(0).locator('mtd').nth(1)).toContainText('if');
  await expect(casesRows.nth(1).locator('mtd').nth(1)).toContainText('otherwise');
  await expect(cases.locator('pre')).toContainText(/\{\s*x\s+if x > 0\s+0\s+otherwise/);
  await expect(cases.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);

  for (const [number, reason, original] of [
    [3, /matrix|columns|rows/i, /\[\s*1\s+2\s+3\s*\]/],
    [4, /piecewise|condition|cases/i, /\{\s*x\s+if x > 0\s+0/],
  ] as const) {
    const candidate = dialog.getByRole('region', { name: 'Extracted exercise ' + number });
    const review = candidate.getByRole('region', { name: 'Check PDF formulas' });
    await expect(review.getByRole('list')).toContainText(reason);
    await expect(review.locator('mark').filter({ hasText: original }).first()).toBeVisible();
    await expect(candidate.locator('pre')).toContainText(original);
    await expect(candidate.getByLabel('Exercise ' + number + ' statement', { exact: true })).not.toHaveValue(
      /\\begin\{(?:[pbBvV]?matrix|cases)\}/,
    );
  }

  const ordinary = dialog.getByRole('region', { name: 'Extracted exercise 5' });
  await expect(ordinary.getByLabel('Exercise 5 statement', { exact: true })).toHaveValue(
    'Compare (1, 2) and {3, 4}.',
  );
  await expect(ordinary.getByRole('region', { name: 'Check PDF formulas' })).toHaveCount(0);
});

test('suggests an exercise linked to a difficult review', async ({ page, request, baseURL }) => {
  const noteId = randomUUID();
  const cardId = randomUUID();
  const notePath = `/api/v1/knowledge-items/${noteId}`;
  const title = 'Synthetic practice recall note';
  const headers = (id: string) => ({ Origin: baseURL!, 'Idempotency-Key': id });
  const created = await request.post('/api/v1/knowledge-items', {
    headers: headers(noteId),
    data: { id: noteId, title, type: 'definition', content: 'A synthetic definition for review.' },
  });
  expect(created.status()).toBe(201);
  try {
    const card = await request.post(`${notePath}/cards`, {
      headers: headers(cardId),
      data: {
        id: cardId,
        card_type: 'statement',
        prompt: 'Recall the synthetic definition.',
        answer: 'Reference answer.',
      },
    });
    expect(card.status()).toBe(201);
    await page.goto(`/review/session?card=${cardId}`);
    await page.getByRole('button', { name: 'Reveal answer' }).click();
    await page.getByRole('button', { name: /Hard.*Recalled with difficulty/ }).click();
    await expect(page.getByRole('heading', { name: 'Review complete' })).toBeVisible();

    await page.goto('/practice');
    const importDialog = await openTextImport(page);
    await importDialog.getByRole('button', { name: 'Save selected exercises', exact: true }).click();
    await expect(importDialog).toBeHidden();
    await page.getByRole('button', { name: /^Exercise 2\b/ }).click();
    await page.getByRole('button', { name: 'Edit exercise', exact: true }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Linked knowledge note (optional)').selectOption(noteId);
    await edit.getByRole('button', { name: 'Save exercise', exact: true }).click();
    await expect(page.getByText(`Recent review difficulty on ${title}`, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Start practice set', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Exercise 2', exact: true })).toBeVisible();
  } finally {
    const item = await (await request.get(notePath)).json();
    await request.delete(notePath, {
      headers: { ...headers(randomUUID()), 'If-Match': `"${item.version}"` },
    });
  }
});
