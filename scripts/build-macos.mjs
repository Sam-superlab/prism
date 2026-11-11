import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Build the macOS desktop app on macOS.');
execFileSync(process.execPath, [resolve(root, 'scripts/generate-icons.mjs')], { stdio: 'inherit' });
const bundle = resolve(root, 'output/macos/PRISM.app');
mkdirSync(resolve(bundle, 'Contents/MacOS'), { recursive: true });
mkdirSync(resolve(bundle, 'Contents/Resources'), { recursive: true });
copyFileSync(
  resolve(root, 'apps/macos/Assets/AppIcon.icns'),
  resolve(bundle, 'Contents/Resources/AppIcon.icns'),
);
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
writeFileSync(
  resolve(bundle, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PRISM</string>
<key>CFBundleIdentifier</key><string>app.prism.desktop.local</string>
<key>CFBundleName</key><string>PRISM</string>
<key>CFBundleDisplayName</key><string>PRISM</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>PRISMProjectRoot</key><string>${xml(root)}</string>
</dict></plist>`,
);
execFileSync(
  'xcrun',
  [
    'swiftc',
    '-O',
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-framework',
    'Cocoa',
    '-framework',
    'WebKit',
    resolve(root, 'apps/macos/PRISM.swift'),
    '-o',
    resolve(bundle, 'Contents/MacOS/PRISM'),
  ],
  { stdio: 'inherit' },
);
execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'app.prism.desktop.local', bundle], {
  stdio: 'inherit',
});
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
const install = resolve(process.env.HOME, 'Applications/PRISM.app');
if (existsSync(install)) {
  const id = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', resolve(install, 'Contents/Info.plist')],
    { encoding: 'utf8' },
  ).trim();
  if (id !== 'app.prism.desktop.local')
    throw new Error('Another PRISM app exists; built output was preserved without overwriting it.');
  rmSync(install, { recursive: true });
}
mkdirSync(dirname(install), { recursive: true });
execFileSync('ditto', [bundle, install]);
console.log(`Built and installed local desktop app: ${install}`);
