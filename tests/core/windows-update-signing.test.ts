import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const publicKey = Buffer.alloc(32).toString('base64');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(version = '0.2.6', embeddedKey = publicKey) {
  const directory = mkdtempSync(join(tmpdir(), 'prism-signing-test-'));
  directories.push(directory);
  const archive = join(directory, 'PRISM-Windows-x64.zip');
  const files = {
    'PRISM/prism-install.json': JSON.stringify({
      format: 'prism-portable-v1',
      version,
      files: [],
      directories: [],
    }),
    'PRISM/resources/app/package.json': JSON.stringify({ version }),
    'PRISM/resources/app/update-config.json': JSON.stringify({
      feedUrl: 'https://sam-superlab.github.io/prism/windows-update.json',
      publicKey: embeddedKey,
    }),
  };
  execFileSync('python3', [
    '-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,data in json.loads(sys.argv[2]).items(): z.writestr(name,data)',
    archive,
    JSON.stringify(files),
  ]);
  const tool = join(directory, 'bad-signature');
  writeFileSync(tool, '#!/bin/sh\nprintf "%s" "' + 'A'.repeat(86) + '=="\n', { mode: 0o700 });
  return { directory, archive, tool };
}
function sign(data: ReturnType<typeof fixture>, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      resolve('scripts/sign-windows-update.mjs'),
      '--sign-update',
      data.tool,
      '--archive',
      data.archive,
      '--public-key',
      publicKey,
      '--output',
      join(data.directory, 'windows-update.json'),
      ...extra,
    ],
    { encoding: 'utf8' },
  );
}

describe.skipIf(process.platform !== 'darwin')('Windows release signing', () => {
  it('rejects a version different from the app inside the archive', () => {
    const result = sign(fixture(), ['--version', '0.2.7']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must match');
  });

  it('rejects a public key different from the app trust configuration', () => {
    const result = sign(fixture('0.2.6', Buffer.alloc(32, 1).toString('base64')));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('matching signing key');
  });

  it('rejects a noncanonical download origin', () => {
    const result = sign(fixture(), ['--download-url', 'https://example.com/PRISM-Windows-x64.zip']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('versioned PRISM GitHub ZIP');
  });

  it('checks the signing tool output against the embedded public key', () => {
    const result = sign(fixture());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match');
  });
});
