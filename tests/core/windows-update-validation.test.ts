import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { checkManifest, isNewer, zipEntries, validateInstallation } = createRequire(import.meta.url)(
  '../../apps/windows/updater.cjs',
);
const feed = 'https://sam-superlab.github.io/prism/windows-update.json';

function signedManifest(url?: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'jwk' });
  const config = { feedUrl: feed, publicKey: Buffer.from(key.x!, 'base64url').toString('base64') };
  const entry = {
    version: '0.2.7',
    url: url ?? 'https://github.com/Sam-superlab/prism/releases/download/v0.2.7/PRISM-Windows-x64.zip',
    size: 120,
    sha256: 'a'.repeat(64),
    signature: Buffer.alloc(64).toString('base64'),
  };
  const payload = Buffer.from(JSON.stringify(entry));
  return {
    config,
    entry,
    envelope: {
      payload: payload.toString('base64'),
      signature: sign(null, payload, privateKey).toString('base64'),
    },
  };
}

function archive(names: string[]) {
  return execFileSync('python3', [
    '-c',
    'import io,json,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for name in json.loads(sys.argv[1]): z.writestr(name,b"test")\nsys.stdout.buffer.write(b.getvalue())',
    JSON.stringify(names),
  ]);
}

describe('Windows update trust and staging', () => {
  it('accepts authentic metadata and rejects a changed signature or payload', () => {
    const { config, entry, envelope } = signedManifest();
    expect(checkManifest(envelope, config, feed)).toEqual(entry);
    const signature = Buffer.from(envelope.signature, 'base64');
    signature[0] ^= 1;
    expect(() =>
      checkManifest({ ...envelope, signature: signature.toString('base64') }, config, feed),
    ).toThrow(/signature/i);
    const payload = Buffer.from(JSON.stringify({ ...entry, version: '9.0.0' })).toString('base64');
    expect(() => checkManifest({ ...envelope, payload }, config, feed)).toThrow(/signature/i);
  });

  it('rejects authentic metadata that sends the downloader to another host or release', () => {
    for (const url of [
      'https://example.com/PRISM-Windows-x64.zip',
      'http://127.0.0.1:38744/PRISM-Windows-x64.zip',
      'https://github.com/Sam-superlab/prism/releases/download/v0.2.6/PRISM-Windows-x64.zip',
    ]) {
      const { config, envelope } = signedManifest(url);
      expect(() => checkManifest(envelope, config, feed)).toThrow(/address/i);
    }
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.2.6', '0.2.6')).toBe(false);
    expect(isNewer('0.2.5', '0.2.6')).toBe(false);
  });

  it('rejects traversal, absolute paths, Windows alternate streams, and case collisions before extraction', () => {
    expect(zipEntries(archive(['PRISM/PRISM.exe']))).toHaveLength(1);
    for (const names of [
      ['PRISM/../outside.txt'],
      ['/PRISM/file.txt'],
      ['PRISM/file.txt:secret'],
      ['PRISM/CON.txt'],
      ['PRISM/file.txt', 'PRISM/FILE.txt'],
    ]) {
      expect(() => zipEntries(archive(names))).toThrow();
    }
  });

  it('refuses to replace a program folder containing extra user files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-install-inventory-'));
    try {
      await mkdir(join(root, 'resources/app'), { recursive: true });
      await writeFile(join(root, 'PRISM.exe'), '');
      await writeFile(join(root, 'resources/app/package.json'), JSON.stringify({ version: '0.2.6' }));
      await writeFile(
        join(root, 'prism-install.json'),
        JSON.stringify({
          format: 'prism-portable-v1',
          version: '0.2.6',
          files: ['PRISM.exe', 'resources/app/package.json'],
          directories: ['resources', 'resources/app'],
        }),
      );
      await expect(validateInstallation(root, '0.2.6')).resolves.toBeTruthy();
      await writeFile(join(root, 'my-note.md'), 'A file outside the application inventory.');
      await expect(validateInstallation(root, '0.2.6')).rejects.toThrow(/extra files/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
