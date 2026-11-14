import { expect, it, vi } from 'vitest';
import { createBrowserCaptureConnection, isCaptureExtensionOrigin } from '../../apps/web/lib/browser-capture-connection';

const first = `chrome-extension://${'a'.repeat(32)}`;
const second = 'moz-extension://11111111-1111-1111-1111-111111111111';
const token = (code: string) => code.split('.')[2];

it('allows only exact extension origins and binds the code to one workspace launch', async () => {
  const connection = createBrowserCaptureConnection();
  const issued = connection.issue('launch A', '43831');
  expect(issued.code).toMatch(/^prism1\.43831\.[A-Za-z0-9_-]{43}$/);
  for (const origin of ['https://example.test', 'null', `${first}/`, `${first}.example.test`, 'moz-extension://abc'])
    expect(isCaptureExtensionOrigin(origin)).toBe(false);
  expect(isCaptureExtensionOrigin(second)).toBe(true);
  const save = vi.fn(async () => 'saved' as const);
  expect(await connection.submit('launch B', first, token(issued.code), '{}', save)).toBe('unavailable');
  expect(await connection.submit('launch A', 'https://example.test', token(issued.code), '{}', save)).toBe('unavailable');
  expect(await connection.submit('launch A', first, 'A'.repeat(43), '{}', save)).toBe('unavailable');
  expect(save).not.toHaveBeenCalled();
  expect(await connection.submit('launch A', first, token(issued.code), '{}', save)).toBe('saved');
  expect(await connection.submit('launch A', second, token(issued.code), '{}', save)).toBe('unavailable');
  expect(await connection.submit('launch A', first, token(issued.code), '{"changed":true}', save)).toBe('unavailable');
  expect(save).toHaveBeenCalledTimes(1);
});

it('reuses the same command for a lost response or concurrent retry and forgets a revoked or expired code', async () => {
  let time = 0;
  const connection = createBrowserCaptureConnection(() => time);
  const launch = 'synthetic workspace';
  const code = token(connection.issue(launch, '43831').code);
  const save = vi.fn<(id: string) => Promise<'saved'>>().mockRejectedValueOnce(new Error('Lost response')).mockResolvedValue('saved');
  await expect(connection.submit(launch, first, code, '{}', save)).rejects.toThrow('Lost response');
  await expect(Promise.all([
    connection.submit(launch, first, code, '{}', save), connection.submit(launch, first, code, '{}', save),
  ])).resolves.toEqual(['saved', 'saved']);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  expect(await connection.submit(launch, first, code, '{}', save)).toBe('saved');
  expect(save).toHaveBeenCalledTimes(2);
  connection.revoke(launch);
  expect(await connection.submit(launch, first, code, '{}', save)).toBe('unavailable');
  const newer = token(connection.issue(launch, '43831').code);
  time = 10 * 60_000;
  expect(await connection.submit(launch, first, newer, '{}', save)).toBe('unavailable');
});
