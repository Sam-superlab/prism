import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('filters knowledge and due cards by subject and chapter without submitting ratings', async ({
  page,
  request,
  baseURL,
}) => {
  const algebra = 'Fixture Algebra & Modules';
  const geometry = 'Fixture Geometry';
  const itemIds: string[] = [];
  const cardIds: string[] = [];
  const headers = (key: string) => ({ Origin: baseURL!, 'Idempotency-Key': key });

  async function create(
    title: string,
    subject: string,
    prompt: string,
    chapter?: [number, string],
    type: 'definition' | 'theorem' = 'definition',
  ) {
    const id = randomUUID();
    const item = await request.post('/api/v1/knowledge-items', {
      headers: headers(id),
      data: {
        id,
        title,
        subject,
        type,
        content: 'A subject-specific note.',
        tags: chapter ? [`chapter:${chapter[0]}`, `chapter-title:${chapter[1]}`] : [],
      },
    });
    expect(item.status()).toBe(201);
    itemIds.push(id);
    const cardId = randomUUID();
    const card = await request.post(`/api/v1/knowledge-items/${id}/cards`, {
      headers: headers(cardId),
      data: { id: cardId, card_type: 'statement', prompt, answer: 'A reference answer.' },
    });
    expect(card.status()).toBe(201);
    cardIds.push(cardId);
  }

  try {
    await create('Fixture Algebra note', algebra, 'Recall the algebra definition.', [1, 'Groups']);
    await create(
      'Fixture Algebra chapter three',
      algebra,
      'Recall the rings theorem.',
      [3, 'Rings'],
      'theorem',
    );
    await create('Fixture Algebra chapter five', algebra, 'Recall the fields definition.', [5, 'Fields']);
    await create('Fixture Algebra unnumbered', algebra, 'Recall the unnumbered definition.');
    await create('Fixture Geometry note', geometry, 'Recall the geometry definition.', [1, 'Curves']);
    await create('Fixture unassigned note', '', 'Recall the unassigned definition.');
    const subjectQuery = () => new URL(page.url()).searchParams.get('subject');
    const chapterQuery = () => {
      const params = new URL(page.url()).searchParams;
      return [params.get('chapter_from'), params.get('chapter_to')];
    };
    await page.goto('/knowledge');
    const search = page.getByPlaceholder('Search knowledge titles or content…');
    const type = page.getByLabel('Knowledge type', { exact: true });
    await search.fill('Fixture');
    await type.selectOption('definition');
    await page.getByLabel('Knowledge subject', { exact: true }).selectOption({ label: algebra });
    await expect.poll(subjectQuery).toBe(algebra);
    await expect(page.locator('.knowledge-card')).toHaveCount(3);
    await expect(
      page.locator('.knowledge-card').filter({ hasText: 'Fixture Algebra chapter three' }),
    ).toHaveCount(0);
    const chapterFrom = page.getByLabel('From chapter', { exact: true });
    const chapterThrough = page.getByLabel('Through chapter', { exact: true });
    await chapterFrom.selectOption({ label: 'Chapter 1: Groups' });
    await expect.poll(chapterQuery).toEqual(['1', '1']);
    await expect(search).toHaveValue('Fixture');
    await expect(type).toHaveValue('definition');
    await expect(page.locator('.knowledge-card')).toHaveCount(1);
    await expect(page.locator('.knowledge-card')).toContainText('Fixture Algebra note');

    await page.getByRole('button', { name: 'New knowledge', exact: true }).click();
    const editor = page.getByRole('dialog');
    await expect(editor.getByLabel('Subject / course', { exact: true })).toHaveValue(algebra);
    await expect(editor.getByLabel('Chapter number (optional)', { exact: true })).toHaveValue('1');
    await expect(editor.locator(`datalist option[value="${geometry}"]`)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();

    await chapterThrough.selectOption({ label: 'Chapter 3: Rings' });
    await expect.poll(chapterQuery).toEqual(['1', '3']);
    await expect(page.locator('.knowledge-card')).toHaveCount(1);
    await expect(page.locator('.knowledge-card')).toContainText('Fixture Algebra note');
    await type.selectOption('theorem');
    await expect(page.locator('.knowledge-card')).toHaveCount(1);
    await expect(
      page.locator('.knowledge-card').filter({ hasText: 'Fixture Algebra chapter three' }),
    ).toBeVisible();
    await type.selectOption('');
    await expect(page.locator('.knowledge-card')).toHaveCount(2);

    await page.getByRole('link', { name: 'Start review', exact: true }).click();
    await expect.poll(subjectQuery).toBe(algebra);
    await expect.poll(chapterQuery).toEqual(['1', '3']);
    await expect(page.getByText('0 / 2 reviewed')).toBeVisible();
    await expect(page.locator('.recall-prompt')).toContainText('Recall the algebra definition.');
    await chapterFrom.selectOption({ label: 'Chapter 3: Rings' });
    await expect.poll(chapterQuery).toEqual(['3', '3']);
    await expect(page.locator('.recall-prompt')).toContainText('Recall the rings theorem.');
    await page.getByRole('link', { name: '← Back to knowledge', exact: true }).click();
    await expect.poll(chapterQuery).toEqual(['3', '3']);
    await expect(page.locator('.knowledge-card')).toHaveCount(1);
    await expect(page.locator('.knowledge-card')).toContainText('Fixture Algebra chapter three');
    await page.getByRole('link', { name: 'Start review', exact: true }).click();
    const reviewSubject = page.getByLabel('Review subject', { exact: true });
    await reviewSubject.selectOption({ label: geometry });
    await expect.poll(subjectQuery).toBe(geometry);
    await expect.poll(chapterQuery).toEqual([null, null]);
    await expect(page.locator('.recall-prompt')).toContainText('Recall the geometry definition.');
    await reviewSubject.selectOption({ label: 'Unassigned' });
    await expect.poll(subjectQuery).toBe('');
    const unassignedQueue = await request.get('/api/v1/review/queue?subject=&limit=500');
    expect(unassignedQueue.ok()).toBeTruthy();
    expect((await unassignedQueue.json()).items.map((card: { id: string }) => card.id)).toContain(cardIds.at(-1));
    await expect(page.locator('.recall-prompt')).not.toContainText('Recall the geometry definition.');

    await page.getByRole('link', { name: '← Back to knowledge', exact: true }).click();
    await expect.poll(subjectQuery).toBe('');
    await expect(
      page.locator('.knowledge-card').filter({ hasText: 'Fixture unassigned note' }),
    ).toBeVisible();
    await expect(page.locator('.knowledge-card').filter({ hasText: 'Fixture Algebra note' })).toHaveCount(0);
    for (const id of cardIds) {
      const history = await request.get(`/api/v1/review/history?card_id=${id}`);
      expect(history.ok()).toBeTruthy();
      expect((await history.json()).items).toHaveLength(0);
    }
  } finally {
    for (const id of itemIds) {
      const path = `/api/v1/knowledge-items/${id}`;
      const item = await (await request.get(path)).json();
      await request.delete(path, { headers: { ...headers(randomUUID()), 'If-Match': `"${item.version}"` } });
    }
  }
});
