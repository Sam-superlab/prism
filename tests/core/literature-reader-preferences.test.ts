import { describe, expect, it } from 'vitest';
import {
  defaultLiteratureReaderPreferences,
  normalizeLiteratureReaderPreferences,
} from '../../apps/web/lib/literature-reader-preferences';

describe('literature reader preferences', () => {
  it('accepts the provided reader options', () => {
    const preferences = { font: 'sans-serif', fontSize: 28, lineHeight: '2', theme: 'sepia' };
    expect(normalizeLiteratureReaderPreferences(preferences)).toEqual(preferences);
  });

  it('defaults invalid options independently and leaves unknown data out', () => {
    const preferences = { font: 'serif', fontSize: '21', lineHeight: 1.4, theme: 'dark', unknown: 'x' };
    expect(normalizeLiteratureReaderPreferences(preferences)).toEqual({
      ...defaultLiteratureReaderPreferences,
      theme: 'dark',
    });
    expect(normalizeLiteratureReaderPreferences(null)).toEqual(defaultLiteratureReaderPreferences);
  });
});
