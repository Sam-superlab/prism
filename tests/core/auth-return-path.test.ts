import { describe, expect, it } from 'vitest';
import { authReturnPath } from '../../apps/web/lib/auth-return-path';

const ref = '11111111-1111-4111-8111-111111111111';
const pdf = '22222222-2222-4222-8222-222222222222';
const deepLink = `/research/library?reference=${ref}&pdf=${pdf}`;

describe('sign-in return path', () => {
  it('keeps the authenticated reader path and optional page', () => {
    expect(authReturnPath(deepLink)).toBe(deepLink);
    expect(authReturnPath(deepLink + '&page=5')).toBe(deepLink + '&page=5');
    expect(authReturnPath('/research/library')).toBe('/research/library');
  });

  it('drops unrelated or malformed parameters', () => {
    expect(authReturnPath(deepLink + '&returnTo=https://outside.example&page=invalid')).toBe(deepLink);
    expect(authReturnPath('/research/library?reference=bad&pdf=' + pdf)).toBe('/research/library');
    expect(authReturnPath('/research/library?reference=' + ref + '&pdf=bad&page=7')).toBe(
      '/research/library?reference=' + ref,
    );
  });

  it.each([
    null,
    'https://outside.example/research/library',
    '//outside.example/research/library',
    '/\\outside.example/research/library',
    '/%2f%2foutside.example/research/library',
    '/research/library/../../auth/logout',
    '/auth/logout',
    '/research/library#outside',
    '/research/library?name=' + 'x'.repeat(1001),
  ])('falls back to Dashboard for invalid destination %s', (value) => {
    expect(authReturnPath(value)).toBe('/today');
  });
});
