import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { pdfWithImageAndRepeatedMargins } from './pdf-fixture';

test('renders the hosted team library roles and copies selected bibliographic metadata', async ({ page }) => {
  const teamId = randomUUID();
  const memberId = randomUUID();
  const personalId = randomUUID();
  const personalPdf = randomUUID();
  const sharedPdf = randomUUID();
  const team = { id: teamId, name: 'Fixture research group', description: '', role: 'admin', created_by: memberId,
    updated_by: memberId, version: '1' };
  let shared: Record<string, unknown> | null = null;
  let copiedFile = false;
  let sharedNote: Record<string, unknown> | null = null;
  let sharedAnnotation: Record<string, unknown> | null = null;
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), team_libraries_enabled: true } });
  });
  await page.route('**/api/v1/team-libraries', (route) => route.fulfill({ json: { items: [team] } }));
  await page.route(`**/api/v1/team-libraries/${teamId}/members`, (route) => route.fulfill({ json: {
    items: [{ user_id: memberId, display_name: 'Fixture Reader', role: 'admin', version: '1' }],
  } }));
  await page.route(`**/api/v1/team-libraries/${teamId}/references?*`, (route) =>
    route.fulfill({ json: { items: shared ? [shared] : [], next_cursor: null } }));
  await page.route(`**/api/v1/team-libraries/${teamId}/references`, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.reference_id).toBe(personalId);
      expect(Object.keys(body).sort()).toEqual(['id', 'reference_id']);
      shared = { id: body.id, title: 'Synthetic paper', authors: ['Fixture Author'], year: 2025, created_by: memberId,
        updated_by: memberId, created_by_name: 'Fixture Reader', updated_by_name: 'Fixture Reader', version: '1' };
      return route.fulfill({ status: 201, json: shared });
    }
    return route.fulfill({ json: { items: shared ? [shared] : [], next_cursor: null } });
  });
  await page.route(`**/api/v1/team-libraries/${teamId}/references/*/attachments`, (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().attachment_id).toBe(personalPdf);
      copiedFile = true;
      return route.fulfill({ status: 201, json: { id: sharedPdf } });
    }
    return route.fulfill({ json: { items: copiedFile ? [{ id: sharedPdf, file_name: 'fixture.pdf',
      size_bytes: 100, created_by_name: 'Fixture Reader', version: '1' }] : [] } });
  });
  await page.route(`**/api/v1/team-libraries/${teamId}/references/*/notes`, (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body.title).toBe('Reading notes');
      expect(body.content).toBe('A **synthetic** claim.');
      sharedNote = { ...body, created_by_name: 'Fixture Reader', updated_by_name: 'Fixture Reader', version: '1' };
      return route.fulfill({ status: 201, json: sharedNote });
    }
    return route.fulfill({ json: { items: sharedNote ? [sharedNote] : [] } });
  });
  await page.route(`**/api/v1/team-libraries/${teamId}/references/*/attachments/${sharedPdf}/download`, (route) =>
    route.fulfill({ contentType: 'application/pdf', body: pdfWithImageAndRepeatedMargins() }));
  await page.route(new RegExp(`/team-libraries/${teamId}/references/[^/]+/attachments/${sharedPdf}/annotations(?:\\?|$)`), (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      expect(body).toMatchObject({ kind: 'note', page: 1, comment: 'Review with the team', tags: ['discussion'] });
      sharedAnnotation = { ...body, created_by: memberId, created_by_name: 'Fixture Reader', version: '1' };
      return route.fulfill({ status: 201, json: sharedAnnotation });
    }
    expect(new URL(route.request().url()).searchParams.get('page')).toBe('1');
    return route.fulfill({ json: { items: sharedAnnotation ? [sharedAnnotation] : [], next_cursor: null } });
  });
  await page.route(`**/api/v1/research/references/${personalId}/pdfs`, (route) => route.fulfill({ json: {
    items: [{ id: personalPdf, file_name: 'fixture.pdf', status: 'ready' }],
  } }));
  await page.route('**/api/v1/research/library?*', (route) => {
    if (new URL(route.request().url()).searchParams.get('native') !== 'true') return route.fallback();
    return route.fulfill({ json: { items: [{ id: personalId, title: 'Synthetic paper', kind: 'reference', version: '1' }], next_cursor: null } });
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Team libraries', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Team libraries' });
  await dialog.getByLabel('Team library', { exact: true }).selectOption(teamId);
  await expect(dialog.getByRole('region', { name: 'Team members' }).getByText('Fixture Reader')).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy from my library' }).click();
  await dialog.getByLabel('Personal reference').selectOption(personalId);
  await dialog.getByRole('button', { name: 'Save team reference' }).click();
  await expect(dialog.getByRole('region', { name: 'Team references' }).getByText('Synthetic paper', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Added by Fixture Reader · Updated by Fixture Reader')).toBeVisible();
  await dialog.getByRole('button', { name: 'Shared PDFs', exact: true }).click();
  const files = dialog.getByRole('region', { name: 'Shared PDFs' });
  await files.getByRole('button', { name: 'Copy a PDF from my library' }).click();
  await files.getByLabel('PDF source reference').selectOption(personalId);
  await files.getByLabel('PDF to share').selectOption(personalPdf);
  const share = files.getByRole('button', { name: 'Share PDF', exact: true });
  await expect(share).toBeDisabled();
  await files.getByRole('checkbox', { name: /Share a copy of this PDF/ }).check();
  await share.click();
  await expect(files.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', new RegExp(`/${sharedPdf}/download$`));
  await files.getByRole('button', { name: 'Read shared PDF' }).click();
  const reader = page.getByRole('dialog', { name: 'fixture.pdf' });
  const annotations = reader.getByRole('region', { name: 'Shared PDF annotations' });
  await reader.getByRole('button', { name: 'Add page note' }).click();
  await reader.getByRole('region', { name: 'PDF page viewer' }).locator('canvas').click({ position: { x: 120, y: 120 } });
  await annotations.getByLabel('Comment').fill('Review with the team');
  await annotations.getByLabel('Annotation tags').fill('discussion');
  await annotations.getByRole('button', { name: 'Save shared annotation' }).click();
  await expect(annotations.getByText('Review with the team', { exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Open page note' })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.getByRole('button', { name: 'Shared notes', exact: true }).click();
  const notes = dialog.getByRole('region', { name: 'Shared notes' });
  await notes.getByRole('button', { name: 'Add shared note' }).click();
  await notes.getByLabel('Shared note title').fill('Reading notes');
  await notes.getByRole('textbox', { name: 'Shared note', exact: true }).fill('A **synthetic** claim.');
  await notes.getByRole('button', { name: 'Save shared note' }).click();
  await notes.getByText('Reading notes', { exact: true }).click();
  await expect(notes.locator('strong')).toHaveText('synthetic');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  team.role = 'reader';
  await page.getByRole('button', { name: 'Team libraries', exact: true }).click();
  await dialog.getByLabel('Team library', { exact: true }).selectOption(teamId);
  await expect(dialog.getByRole('region', { name: 'Team references' }).getByText('Synthetic paper', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy from my library' })).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: 'Team members' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Shared PDFs', exact: true }).click();
  await expect(files.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expect(files.getByRole('button', { name: 'Copy a PDF from my library' })).toHaveCount(0);
  await files.getByRole('button', { name: 'Read shared PDF' }).click();
  await expect(annotations.getByText('Review with the team', { exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Add page note' })).toHaveCount(0);
  await expect(annotations.getByRole('button', { name: 'Edit annotation' })).toHaveCount(0);
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.getByRole('button', { name: 'Shared notes', exact: true }).click();
  await expect(notes.getByText('Reading notes', { exact: true })).toBeVisible();
  await expect(notes.getByRole('button', { name: 'Add shared note' })).toHaveCount(0);
  await expect(notes.getByRole('button', { name: 'Edit note' })).toHaveCount(0);
});

test('requires explicit publication confirmation and shows the separate public projection', async ({ page }) => {
  const id = randomUUID();
  const team = { id, name: 'Public fixture library', description: 'A synthetic public description', role: 'admin',
    created_by: randomUUID(), updated_by: randomUUID(), version: '1', visibility: 'private' };
  await page.route('**/api/v1/me', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), team_libraries_enabled: true } });
  });
  await page.route('**/api/v1/team-libraries', (route) => route.fulfill({ json: { items: [team] } }));
  await page.route(`**/api/v1/team-libraries/${id}`, (route) => {
    expect(route.request().method()).toBe('PATCH');
    expect(route.request().postDataJSON().visibility).toBe('public_open');
    team.visibility = 'public_open';
    team.version = '2';
    return route.fulfill({ json: team });
  });
  await page.route(`**/api/v1/team-libraries/${id}/members`, (route) => route.fulfill({ json: { items: [] } }));
  await page.route(`**/api/v1/team-libraries/${id}/references?*`, (route) => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.route(`**/api/v1/team-library-discovery/${id}`, (route) => route.fulfill({ json: {
    id, name: team.name, description: team.description, visibility: team.visibility,
  } }));
  await page.route(`**/api/v1/team-library-discovery/${id}/references?*`, (route) => route.fulfill({ json: {
    items: [{ id: randomUUID(), title: 'Published paper', authors: ['Synthetic Author'], year: 2025, publication: {} }], next_cursor: null,
  } }));
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Team libraries', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Team libraries' });
  await dialog.getByLabel('Team library', { exact: true }).selectOption(id);
  await dialog.getByRole('button', { name: 'Edit library' }).click();
  await dialog.getByLabel('Visibility', { exact: true }).selectOption('public_open');
  await dialog.getByRole('button', { name: 'Save library' }).click();
  expect(team.visibility).toBe('private');
  await dialog.getByRole('checkbox', { name: /Publish this library/ }).check();
  await dialog.getByRole('button', { name: 'Save library' }).click();
  await dialog.getByRole('link', { name: 'View public bibliography' }).click();
  await expect(page.getByRole('region', { name: 'Public team bibliography' }).getByText('Published paper')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Team members' })).toHaveCount(0);
});
