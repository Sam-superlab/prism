import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const helper = resolve('apps/windows/update-helper.cjs');

async function fakeApp(directory: string, version: string, executable: string) {
  await mkdir(join(directory, 'resources/app'), { recursive: true });
  await writeFile(join(directory, 'PRISM.exe'), executable, { mode: 0o755 });
  await writeFile(join(directory, 'resources/app/package.json'), JSON.stringify({ version }));
  await writeFile(
    join(directory, 'prism-install.json'),
    JSON.stringify({
      format: 'prism-portable-v1',
      version,
      files: ['PRISM.exe', 'resources/app/package.json'],
      directories: ['resources', 'resources/app'],
    }),
  );
}

// POSIX executable fixtures exercise the same helper transaction without replacing a real application.
// The native Windows CI exercises the complete signed update and relaunch separately.
describe.skipIf(process.platform === 'win32')('Windows update helper recovery', () => {
  it('restores and reopens the original app when the replacement exits before acknowledging startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-helper-rollback-'));
    try {
      const installDir = join(root, 'PRISM');
      const staging = join(root, '.prism-update-fixture');
      const candidate = join(staging, 'PRISM');
      const session = join(root, 'session');
      const restored = join(root, 'old-reopened');
      const stateFile = join(root, 'state.json');
      await mkdir(session);
      await fakeApp(installDir, '0.2.6', '#!/bin/sh\nprintf restored > "$PRISM_OLD_STARTED_FILE"\n');
      await fakeApp(candidate, '0.2.7', '#!/bin/sh\nexit 3\n');
      const job = {
        installDir,
        staging,
        candidate,
        backup: join(staging, 'previous'),
        parentPid: 2147483647,
        previousVersion: '0.2.6',
        version: '0.2.7',
        ack: join(session, 'ack.json'),
        ackToken: 'a'.repeat(64),
        stateFile,
        environment: { PATH: process.env.PATH, PRISM_OLD_STARTED_FILE: restored },
      };
      const file = join(session, 'job.json');
      await writeFile(file, JSON.stringify(job));
      await expect(run(process.execPath, [helper, file], { timeout: 15000 })).rejects.toMatchObject({
        code: 1,
      });
      expect(JSON.parse(await readFile(join(installDir, 'resources/app/package.json'), 'utf8')).version).toBe(
        '0.2.6',
      );
      expect(JSON.parse(await readFile(stateFile, 'utf8')).status).toBe('rolled-back');
      await expect.poll(() => readFile(restored, 'utf8').catch(() => '')).toBe('restored');
      expect(await readFile(join(staging, 'failed/PRISM.exe'), 'utf8')).toContain('exit 3');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
