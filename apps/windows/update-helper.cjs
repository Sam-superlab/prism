const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { validateInstallation } = require('./updater.cjs');

async function renameWithRetry(from, to) {
  let last;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      last = error;
      await delay(500);
    }
  }
  throw last;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function start(installDir, environment, ack) {
  const env = { ...environment };
  delete env.PRISM_WINDOWS_UPDATE_ACK;
  if (ack) env.PRISM_WINDOWS_UPDATE_ACK = JSON.stringify(ack);
  const child = spawn(path.join(installDir, 'PRISM.exe'), [], {
    cwd: installDir,
    env,
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child;
}
async function killTree(pid) {
  if (!pid || !alive(pid)) return;
  await new Promise((resolve) =>
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, resolve),
  );
}
async function main() {
  const jobFile = path.resolve(process.argv[2]);
  const session = path.dirname(jobFile);
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const log = (message) =>
    fs.appendFile(path.join(session, 'install.log'), new Date().toISOString() + ' ' + message + '\n');
  const state = (status, message) =>
    job.stateFile
      ? fs.writeFile(job.stateFile, JSON.stringify({ status, version: job.version, message }))
      : Promise.resolve();
  let swapped = false,
    movedOld = false,
    committed = false,
    child;
  try {
    if (!Number.isSafeInteger(job.parentPid) || job.parentPid <= 1 || !/^[a-f0-9]{64}$/.test(job.ackToken))
      throw new Error('Invalid update job.');
    for (const name of ['installDir', 'candidate', 'staging', 'backup', 'ack'])
      if (!path.isAbsolute(job[name])) throw new Error('Invalid update path.');
    if (
      job.candidate !== path.join(job.staging, 'PRISM') ||
      job.backup !== path.join(job.staging, 'previous') ||
      path.dirname(job.staging) !== path.dirname(job.installDir) ||
      !path.basename(job.staging).startsWith('.prism-update-') ||
      job.ack !== path.join(session, 'ack.json')
    )
      throw new Error('Invalid update folder relationship.');
    for (let attempt = 0; alive(job.parentPid) && attempt < 120; attempt++) await delay(250);
    if (alive(job.parentPid)) throw new Error('PRISM did not close. The installation was left untouched.');
    await validateInstallation(job.installDir, job.previousVersion);
    await validateInstallation(job.candidate, job.version);
    await log('Replacing program folder.');
    await renameWithRetry(job.installDir, job.backup);
    movedOld = true;
    await validateInstallation(job.backup, job.previousVersion);
    await renameWithRetry(job.candidate, job.installDir);
    swapped = true;
    child = await start(job.installDir, job.environment, { path: job.ack, token: job.ackToken });
    let acknowledged = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const ack = JSON.parse(await fs.readFile(job.ack, 'utf8'));
        if (ack.token === job.ackToken && ack.pid === child.pid && ack.version === job.version) {
          acknowledged = true;
          break;
        }
      } catch {
        /* Replacement may still be starting. */
      }
      if (!alive(child.pid)) break;
      await delay(1000);
    }
    if (!acknowledged)
      throw new Error('The replacement did not become ready. Restoring the previous version.');
    committed = true;
    await log('Replacement started and acknowledged.').catch(() => {});
    await state('installed').catch(() => {});
    try {
      await validateInstallation(job.backup, job.previousVersion);
      await fs.rm(job.backup, { recursive: true, force: true });
      await fs.rm(job.staging, { recursive: true, force: true });
    } catch (error) {
      await log('Old program cleanup deferred: ' + error.message).catch(() => {});
    }
    // Keep only the small diagnostic log. Private job data and acknowledgement are no longer needed.
    await fs.unlink(jobFile).catch(() => {});
    await fs.unlink(job.ack).catch(() => {});
  } catch (error) {
    await log(error.message).catch(() => {});
    if (committed) return;
    await killTree(child?.pid);
    try {
      if (movedOld) {
        if (swapped) await renameWithRetry(job.installDir, path.join(job.staging, 'failed'));
        await renameWithRetry(job.backup, job.installDir);
        if (job.userData)
          await fs
            .writeFile(
              path.join(job.userData, 'updates', 'rollback.json'),
              JSON.stringify({ message: error.message }),
            )
            .catch(() => {});
        await start(job.installDir, job.environment);
        await state('rolled-back', error.message);
      } else await state('error', error.message);
    } catch (restoreError) {
      await log('Restoration needs attention: ' + restoreError.message);
      await state(
        'error',
        'Automatic restoration could not finish. The previous app remains in ' + job.backup,
      );
    }
    process.exitCode = 1;
  }
}
if (require.main === module)
  main().catch(() => {
    process.exitCode = 1;
  });
module.exports = { main, renameWithRetry, start };
