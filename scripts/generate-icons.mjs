import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const nextRequire = createRequire(webRequire.resolve('next/package.json'));
const sharp = nextRequire('sharp');
const svg = readFileSync(resolve(root, 'assets/prism-icon.svg'), 'utf8');
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const mac = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><clipPath id="mask"><rect x="48" y="48" width="928" height="928" rx="208"/></clipPath><filter id="s"><feDropShadow dy="12" stdDeviation="12" flood-opacity=".16"/></filter></defs><rect x="48" y="48" width="928" height="928" rx="208" fill="#edf1f8" filter="url(#s)"/><g clip-path="url(#mask)"><svg x="48" y="48" width="928" height="928" viewBox="0 0 1024 1024">${inner}</svg></g></svg>`;
for (const dir of ['apps/mobile/assets', 'apps/web/public', 'apps/macos/Assets', 'apps/web/app'])
  mkdirSync(resolve(root, dir), { recursive: true });
await sharp(Buffer.from(svg))
  .flatten({ background: '#edf1f8' })
  .removeAlpha()
  .png()
  .toFile(resolve(root, 'apps/mobile/assets/icon.png'));
await sharp(Buffer.from(mac)).png().toFile(resolve(root, 'apps/web/public/app-icon.png'));
await sharp(Buffer.from(mac)).resize(192).png().toFile(resolve(root, 'apps/web/app/icon.png'));
await sharp(Buffer.from(mac)).resize(180).png().toFile(resolve(root, 'apps/web/app/apple-icon.png'));
copyFileSync(resolve(root, 'assets/prism-mark.svg'), resolve(root, 'apps/web/public/prism-mark.svg'));
writeFileSync(resolve(root, 'apps/macos/Assets/AppIcon.svg'), mac);
if (process.platform === 'darwin') {
  const iconset = resolve(root, '.data/prism-icon.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await sharp(Buffer.from(mac))
        .resize(size * scale)
        .png()
        .toFile(resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', resolve(root, 'apps/macos/Assets/AppIcon.icns')]);
}
console.log('Generated canonical SVG, opaque iOS icon, web icons and macOS icon family.');
