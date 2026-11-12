import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const version = '2.10.1';
const digest = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27';

export function runMacToolchain(args, options = { stdio: 'inherit' }) {
  // Xcode Command Line Tools on Apple silicon may contain only arm64 host binaries.
  const translated =
    process.arch === 'x64' &&
    execFileSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1';
  if (translated) return execFileSync('/usr/bin/arch', ['-arm64', '/usr/bin/xcrun', ...args], options);
  return execFileSync('/usr/bin/xcrun', args, options);
}

export async function installSparkle({ temporaryDirectory, frameworksDirectory, resourcesDirectory }) {
  const archiveName = `Sparkle-${version}.tar.xz`;
  const archivePath = join(temporaryDirectory, archiveName);
  const localArchive = process.env.PRISM_MACOS_SPARKLE_ARCHIVE;
  let bytes;
  if (localArchive) {
    bytes = readFileSync(localArchive);
  } else {
    const url = `https://github.com/sparkle-project/Sparkle/releases/download/${version}/${archiveName}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Failed to download the official Sparkle release.');
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error('Sparkle release checksum mismatch.');
  writeFileSync(archivePath, bytes);

  const source = join(temporaryDirectory, 'sparkle');
  mkdirSync(source);
  execFileSync(
    'tar',
    [
      '-xJf',
      archivePath,
      '-C',
      source,
      'Sparkle.framework',
      'LICENSE',
      'bin/sign_update',
      'bin/generate_keys',
    ],
    { stdio: 'inherit' },
  );

  const framework = join(frameworksDirectory, 'Sparkle.framework');
  mkdirSync(frameworksDirectory, { recursive: true });
  cpSync(join(source, 'Sparkle.framework'), framework, { recursive: true, verbatimSymlinks: true });
  // PRISM uses Sparkle's unsandboxed installation path.
  rmSync(join(framework, 'Versions/Current/XPCServices'), { recursive: true });
  rmSync(join(framework, 'XPCServices'));
  const license = join(resourcesDirectory, 'licenses/Sparkle.txt');
  mkdirSync(dirname(license), { recursive: true });
  cpSync(join(source, 'LICENSE'), license);
  return join(source, 'bin');
}

export function sparkleSwiftFlags(frameworksDirectory) {
  return [
    '-D',
    'PRISM_SPARKLE',
    '-F',
    frameworksDirectory,
    '-framework',
    'Sparkle',
    '-Xlinker',
    '-rpath',
    '-Xlinker',
    '@executable_path/../Frameworks',
  ];
}

export function signSparkle(frameworksDirectory, sign) {
  const framework = join(frameworksDirectory, 'Sparkle.framework');
  sign(realpathSync(join(framework, 'Autoupdate')));
  sign(realpathSync(join(framework, 'Updater.app')));
  sign(framework);
}
