import { expect, type Locator } from '@playwright/test';

// Read the source of the small, unvirtualized documents used by these fixtures.
export async function markdownSource(editor: Locator) {
  const lines = editor.locator('.cm-line');
  await expect(lines.first()).toBeAttached();
  return (await lines.allTextContents()).join('\n');
}

export async function expectMarkdownSource(editor: Locator, expected: string | RegExp) {
  const source = expect.poll(() => markdownSource(editor));
  if (typeof expected === 'string') await source.toBe(expected);
  else await source.toMatch(expected);
}
