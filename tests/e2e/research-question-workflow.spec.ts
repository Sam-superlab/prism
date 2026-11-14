import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { pdfDocument } from './pdf-fixture';

const pageTwoText = 'Fixture proposition on the colon ideal of consecutive powers.';

function checkPolynomialFixture() {
  // For I=(x²,xy), the generators of I^k have exponent pairs (2k-j,j).
  function inPower(x: number, y: number, power: number) {
    for (let j = 0; j <= power; j++) {
      if (x >= 2 * power - j && y >= j) return true;
    }
    return false;
  }

  let cases = 0;
  let mismatches = 0;
  for (const power of [1, 2, 3]) {
    for (let x = 0; x <= 6; x++) {
      for (let y = 0; y <= 6; y++) {
        const inColon = inPower(x + 2, y, power + 1) && inPower(x + 1, y + 1, power + 1);
        if (inColon !== inPower(x, y, power)) mismatches++;
        cases++;
      }
    }
  }
  return { cases, mismatches };
}

function syntheticPaper() {
  const pageText = [
    'Strong Persistence Property - synthetic literature fixture',
    pageTwoText,
    'Appendix - synthetic examples and open questions',
  ];
  const pageObjects = pageText.flatMap((text, index) => {
    const stream = `BT /F1 15 Tf 55 720 Td (${text}) Tj ET`;
    const contents = 4 + index * 2;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${contents} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
  });
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    ...pageObjects,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

test('traces a Strong Persistence Property question from a PDF page to a result and Dashboard action', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(12_000);
  const projectId = randomUUID();
  const attemptId = randomUUID();
  const experimentId = randomUUID();
  const resultId = randomUUID();
  const referenceId = randomUUID();
  const attachmentId = randomUUID();
  const questionTitle = 'Which additional generators preserve the colon equality?';
  const attemptTitle = 'Try divisibility in consecutive powers';
  const experimentTitle = 'Check a bounded family of monomials';
  const resultTitle = 'Bounded cases agree with the proposed equality';
  const referenceTitle = 'Strong Persistence Property - synthetic paper';
  const filename = 'synthetic-strong-persistence.pdf';
  const expectedScope = 'Fixture: I = (x², xy), k = 1–3, with monomial test exponents 0–6.';
  const calculation = checkPolynomialFixture();
  expect(calculation).toEqual({ cases: 147, mismatches: 0 });
  const evidence = `Compared colon and power membership in ${calculation.cases} cases. Mismatches: ${calculation.mismatches}.`;
  const taskTitle = 'Test the boundary cases for the additional generator';
  const plannedDate = '2046-11-15';
  const projectPath = `/research/${projectId}`;
  const researchObjects = `/research/projects/${projectId}/objects`;
  const resultPath = `${projectPath}?object=${resultId}`;
  const pdfHref = `/research/library?reference=${referenceId}&pdf=${attachmentId}&page=2`;
  const pdf = syntheticPaper();

  async function write(path: string, data: object, method = 'POST') {
    const response = await request.fetch(`/api/v1${path}`, {
      method,
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  }

  await page.clock.setFixedTime(new Date(`${plannedDate}T12:00:00Z`));
  await write('/research/projects', { id: projectId, title: 'Strong Persistence Property · Synthetic' });
  await write(researchObjects, {
    id: attemptId,
    title: attemptTitle,
    object_type: 'proof_attempt',
    content: 'The argument stalls when the new generator divides only one of the products.',
  });
  await write(researchObjects, {
    id: experimentId,
    title: experimentTitle,
    object_type: 'experiment',
    claim_status: 'computationally_verified',
    content: 'Compare monomial membership on a finite grid.',
    evidence_metadata: { scope: expectedScope, result: evidence },
  });
  await write(researchObjects, {
    id: resultId,
    title: resultTitle,
    object_type: 'observation',
    claim_status: 'computationally_verified',
    content: 'The finite grid suggests testing larger exponents and a second family of generators.',
    evidence_metadata: { scope: expectedScope, result: evidence },
  });
  await write('/research/references', { id: referenceId, title: referenceTitle });
  await write(`/research/references/${referenceId}/attachments`, {
    id: attachmentId,
    format: 'pdf',
    file_name: filename,
    size_bytes: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex'),
  });
  await write(
    `/research/attachments/${attachmentId}/chunk`,
    { offset: 0, data: pdf.toString('base64') },
    'PUT',
  );
  await write(`/research/attachments/${attachmentId}/complete`, {});

  await page.goto(pdfHref);
  await expect(page.getByRole('region', { name: 'PDF page viewer' }).getByText(pageTwoText)).toBeVisible();
  await page.getByRole('button', { name: 'Use page in research', exact: true }).click();
  const pdfLinkDialog = page.getByRole('dialog').filter({
    has: page.getByLabel('Research project', { exact: true }),
  });
  await pdfLinkDialog.getByLabel('Research project', { exact: true }).selectOption(projectId);
  await pdfLinkDialog.getByRole('link', { name: 'New question from this page', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'New research question', exact: true });
  await draft.getByLabel('Title', { exact: true }).fill(questionTitle);
  await draft
    .getByLabel('Question statement', { exact: true })
    .fill('For which additional generators can the equality be recovered by monomial divisibility?');
  await draft.getByLabel('Question status', { exact: true }).selectOption('investigating');
  await draft.getByRole('button', { name: 'Save question', exact: true }).click();
  await expect(page.getByRole('heading', { name: questionTitle, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/questions\/[\da-f-]{36}$/);
  const questionPath = new URL(page.url()).pathname;
  const questionId = questionPath.split('/').at(-1)!;
  const sourceLabel = `${referenceTitle} · PDF page 2`;
  const source = page.getByRole('link', { name: sourceLabel, exact: true });
  const sources = page.getByRole('button', { name: 'Sources', exact: true });
  const nextActions = page.getByRole('button', { name: 'Next actions', exact: true });
  const addSource = page.getByRole('button', { name: 'Add source', exact: true });
  const addNextAction = page.getByRole('button', { name: 'Add next action', exact: true });
  await expect(sources).toHaveAttribute('aria-expanded', 'false');
  await expect(nextActions).toHaveAttribute('aria-expanded', 'false');
  await expect(source).toBeHidden();
  await expect(addSource).toBeHidden();
  await expect(addNextAction).toBeHidden();
  await sources.click();
  await expect(sources).toHaveAttribute('aria-expanded', 'true');
  await expect(source).toHaveAttribute('href', pdfHref);
  await expect(addSource).toBeVisible();
  await sources.click();
  await expect(sources).toHaveAttribute('aria-expanded', 'false');
  await expect(source).toBeHidden();
  await page.goto(projectPath);
  await page.getByRole('link', { name: questionTitle, exact: true }).click();
  await expect(page).toHaveURL(new URL(questionPath, baseURL).href);
  await expect(page.getByRole('heading', { name: questionTitle, exact: true })).toBeVisible();

  async function linkRecord(button: string, relation: string, title: string, id: string) {
    await page.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({
      has: page.getByRole('button', { name: 'Save link', exact: true }),
    });
    await dialog.getByLabel('Relationship', { exact: true }).selectOption(relation);
    await dialog.getByLabel('Search records', { exact: true }).fill(title);
    await dialog.getByLabel('Research record', { exact: true }).selectOption(id);
    await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  }

  await linkRecord('Link investigation', 'attempt', attemptTitle, attemptId);
  await linkRecord('Link investigation', 'experiment', experimentTitle, experimentId);
  await linkRecord('Link result', 'result', resultTitle, resultId);
  const linksResponse = await request.get(`/api/v1/research/question-links?question_id=${questionId}`);
  expect(linksResponse.ok()).toBe(true);
  const { items } = await linksResponse.json();
  expect(items).toHaveLength(4);
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relation_type: 'motivates',
        reference_id: referenceId,
        attachment_id: attachmentId,
        page: 2,
      }),
      expect.objectContaining({ relation_type: 'attempt', research_object_id: attemptId }),
      expect.objectContaining({ relation_type: 'experiment', research_object_id: experimentId }),
      expect.objectContaining({ relation_type: 'result', research_object_id: resultId }),
    ]),
  );
  await page.reload();
  await expect(sources).toHaveAttribute('aria-expanded', 'false');
  await sources.click();
  await expect(source).toHaveAttribute('href', pdfHref);
  await expect(page.getByRole('link', { name: attemptTitle, exact: true })).toBeVisible();

  await page.getByRole('link', { name: experimentTitle, exact: true }).click();
  const experiment = page.getByRole('dialog', { name: experimentTitle, exact: true });
  await expect(experiment.getByRole('heading', { name: 'Computational evidence and scope' })).toBeVisible();
  await expect(experiment).toContainText(expectedScope);
  await expect(experiment).toContainText(evidence);
  await experiment.getByRole('link', { name: questionTitle, exact: true }).click();
  await expect(page.getByRole('heading', { name: questionTitle, exact: true })).toBeVisible();

  await page.getByRole('link', { name: resultTitle, exact: true }).click();
  await expect(page).toHaveURL(new URL(resultPath, baseURL).href);
  const result = page.getByRole('dialog', { name: resultTitle, exact: true });
  await expect(result.getByText('Computationally verified', { exact: true })).toBeVisible();
  const originalSource = result.getByRole('link', { name: sourceLabel, exact: true });
  await expect(originalSource).toHaveAttribute('href', pdfHref);
  await originalSource.click();
  await expect(page.getByRole('region', { name: 'PDF page viewer' }).getByText(pageTwoText)).toBeVisible();
  await page.goto(resultPath);
  await result.getByRole('link', { name: questionTitle, exact: true }).click();
  await expect(page.getByRole('heading', { name: questionTitle, exact: true })).toBeVisible();

  await expect(nextActions).toHaveAttribute('aria-expanded', 'false');
  await nextActions.press('Space');
  await expect(nextActions).toHaveAttribute('aria-expanded', 'true');
  await addNextAction.click();
  const task = page.getByRole('dialog', { name: 'Next step', exact: true });
  await task.getByLabel('Task title', { exact: true }).fill(taskTitle);
  await task.getByLabel('Estimated minutes', { exact: true }).fill('20');
  await expect(task.getByLabel('Planned date (optional)', { exact: true })).toHaveValue(plannedDate);
  await task.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(task).toBeHidden();
  const questionTask = page.getByRole('button', { name: taskTitle, exact: true });
  await expect(questionTask).toBeVisible();
  await nextActions.click();
  await expect(nextActions).toHaveAttribute('aria-expanded', 'false');
  await expect(questionTask).toBeHidden();
  await page.goto('/today');
  const plan = page.getByRole('region', { name: 'Today’s plan' });
  const taskRow = plan.locator('.task-row').filter({ hasText: taskTitle });
  await expect(taskRow).toBeVisible();
  await taskRow.getByRole('link', { name: 'Open research record', exact: true }).click();
  await expect(page).toHaveURL(new URL(questionPath, baseURL).href);
  await expect(page.getByRole('heading', { name: questionTitle, exact: true })).toBeVisible();
  await expect(page.getByText('Investigating', { exact: true })).toBeVisible();
});
