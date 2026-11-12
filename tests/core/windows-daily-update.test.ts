import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const { startAutomaticChecks } = createRequire(import.meta.url)('../../apps/windows/updater.cjs');
const hour = 60 * 60 * 1000;

it('checks once per hour across relaunches and catches up after time away', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-daily-check-'));
  let now = Date.UTC(2026, 10, 11);
  const check = vi.fn();
  const options = { file: join(root, 'check.json'), check, now: () => now };
  let scheduler = startAutomaticChecks(options);
  try {
    await scheduler.ready;
    expect(check).toHaveBeenCalledTimes(1);
    now += hour - 1;
    await scheduler.tick();
    expect(check).toHaveBeenCalledTimes(1);
    scheduler.stop();

    scheduler = startAutomaticChecks(options);
    await scheduler.ready;
    expect(check).toHaveBeenCalledTimes(1);
    now += 1;
    await scheduler.tick();
    expect(check).toHaveBeenCalledTimes(2);
    scheduler.stop();

    now += 3 * hour;
    scheduler = startAutomaticChecks(options);
    await scheduler.ready;
    expect(check).toHaveBeenCalledTimes(3);
    scheduler.stop();
    now += hour;
    await scheduler.tick();
    expect(check).toHaveBeenCalledTimes(3);
  } finally {
    scheduler.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not repeatedly retry a failed automatic check after relaunch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prism-daily-offline-'));
  const check = vi.fn().mockRejectedValue(new Error('Offline'));
  const options = { file: join(root, 'check.json'), check, now: () => Date.UTC(2026, 10, 11) };
  let scheduler = startAutomaticChecks(options);
  try {
    await scheduler.ready;
    scheduler.stop();
    scheduler = startAutomaticChecks(options);
    await scheduler.ready;
    expect(check).toHaveBeenCalledTimes(1);
  } finally {
    scheduler.stop();
    await rm(root, { recursive: true, force: true });
  }
});
