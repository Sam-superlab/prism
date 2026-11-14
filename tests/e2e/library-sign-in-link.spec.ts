import { expect, test } from '@playwright/test';

test('sign-in link carries the requested library PDF path', async ({ page }) => {
  const reference = '11111111-1111-4111-8111-111111111111';
  const pdf = '22222222-2222-4222-8222-222222222222';
  const reader = `/research/library?reference=${reference}&pdf=${pdf}`;
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Sign in to PRISM to continue.' } },
    }),
  );
  await page.route('**/auth/login*', (route) => route.fulfill({ body: 'Sign-in request fixture' }));
  await page.goto(reader);
  const login = page.getByRole('link', { name: 'Sign in to PRISM' }).first();
  const navigation = page.waitForRequest((request) => new URL(request.url()).pathname === '/auth/login');
  await login.click();
  expect(new URL((await navigation).url()).searchParams.get('returnTo')).toBe(reader);
});
