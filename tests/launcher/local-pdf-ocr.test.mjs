import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

test(
  'macOS Vision recognizes a synthetic PDF scan raster and rejects non-PNG bytes',
  {
    skip: process.platform !== 'darwin',
    timeout: 65_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-ocr-test-'));
    try {
      const main = join(dir, 'main.swift');
      await writeFile(
        main,
        `
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let colors = CGColorSpaceCreateDeviceRGB()
let canvas = CGContext(data: nil, width: 1200, height: 300, bitsPerComponent: 8, bytesPerRow: 0,
                       space: colors, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
canvas.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
canvas.fill(CGRect(x: 0, y: 0, width: 1200, height: 300))
let font = CTFontCreateWithName("Helvetica" as CFString, 68, nil)
let line = CTLineCreateWithAttributedString(NSAttributedString(string: "PRISM synthetic theorem scan", attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1)
]))
canvas.textPosition = CGPoint(x: 45, y: 162)
CTLineDraw(line, canvas)
let png = NSMutableData()
let destination = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, canvas.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not create the synthetic scan") }
let recognized = try recognizeLocalPdfPage(png as Data)
guard recognized.lowercased().contains("synthetic theorem") else { fatalError("Unexpected OCR result: \\(recognized)") }
do {
    _ = try recognizeLocalPdfPage(Data("not a PNG".utf8))
    fatalError("Accepted non-PNG data")
} catch LocalPdfOcrError.invalidImage {}
print("Synthetic scan recognized")
`,
      );
      const native = fileURLToPath(new URL('../../apps/macos/LocalPdfOcr.swift', import.meta.url));
      const target = (process.arch === 'arm64' ? 'arm64' : 'x86_64') + '-apple-macos13.0';
      const binary = join(dir, 'recognize');
      await run('xcrun', ['swiftc', '-target', target, native, main, '-o', binary], { timeout: 20_000 });
      const { stdout } = await run(binary, [], { timeout: 45_000 });
      assert.match(stdout, /Synthetic scan recognized/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
