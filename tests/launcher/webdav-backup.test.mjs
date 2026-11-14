import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test(
  'macOS WebDAV archive requests validate destinations, archive bytes, and server responses',
  {
    skip: process.platform !== 'darwin',
    timeout: 30000,
  },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), 'prism-webdav-test-'));
    try {
      const fixture = join(scratch, 'fixture.zip');
      writeFileSync(fixture, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]));
      const wrong = join(scratch, 'invalid.zip');
      writeFileSync(wrong, Buffer.alloc(30));
      const main = join(scratch, 'main.swift');
      writeFileSync(
        main,
        String.raw`
import Foundation

func rejects(_ block: () throws -> Void) {
    do { try block(); fatalError("Expected request to be rejected") } catch {}
}

let folder = try WebDAVBackup.folder("https://dav.test.invalid/Research%20backup/")
for invalid in ["http://dav.test.invalid/dav", "https://user:pass@dav.test.invalid/",
                "https://dav.test.invalid/dav?secret=bad", "https://dav.test.invalid/dav#other"] {
    rejects { _ = try WebDAVBackup.folder(invalid) }
}
rejects { _ = try WebDAVBackup.authorization(username: "a:b", password: "test") }
rejects { _ = try WebDAVBackup.authorization(username: "test", password: "test\n") }
let auth = try WebDAVBackup.authorization(username: "fixture", password: "temporary")
let size = try WebDAVBackup.archiveSize(URL(fileURLWithPath: CommandLine.arguments[1]))
rejects { _ = try WebDAVBackup.archiveSize(URL(fileURLWithPath: CommandLine.arguments[2])) }
let request = WebDAVBackup.request(folder: folder, authorization: auth, size: size,
                                   id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!)
precondition(request.url?.absoluteString ==
    "https://dav.test.invalid/Research%20backup/PRISM-archive-11111111-1111-4111-8111-111111111111.zip")
precondition(request.httpMethod == "PUT")
precondition(request.value(forHTTPHeaderField: "If-None-Match") == "*")
precondition(request.value(forHTTPHeaderField: "Content-Length") == "30")
precondition(request.value(forHTTPHeaderField: "Authorization") ==
    "Basic " + Data("fixture:temporary".utf8).base64EncodedString())
for status in [201, 204] {
    try WebDAVBackup.validate(HTTPURLResponse(url: folder, statusCode: status, httpVersion: nil, headerFields: nil)!)
}
for status in [200, 301, 307, 401, 404, 412, 500] {
    rejects {
        try WebDAVBackup.validate(HTTPURLResponse(url: folder, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
`,
      );
      const swift = fileURLToPath(new URL('../../apps/macos/WebDAVBackup.swift', import.meta.url));
      const binary = join(scratch, 'check');
      execFileSync('xcrun', ['swiftc', main, swift, '-o', binary], { timeout: 20000 });
      execFileSync(binary, [fixture, wrong], { timeout: 5000 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
