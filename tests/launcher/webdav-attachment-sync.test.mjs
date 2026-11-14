import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('automatic WebDAV attachment copies require opt-in, persist verified digests and stop when disabled', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'prism-webdav-sync-'));
  try {
    const main = join(scratch, 'main.swift');
    writeFileSync(main, String.raw`
import CryptoKit
import Foundation

let bytes = Data("%PDF-1.7\nAutomatic sync fixture".utf8)
let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
let attachment = "11111111-1111-4111-8111-111111111111"
let reference = "22222222-2222-4222-8222-222222222222"
let token = String(repeating: "a", count: 64)

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var putCount = 0
    nonisolated(unsafe) static var pageCount = 0
    nonisolated(unsafe) static var uploaded = false
    static let lock = NSLock()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let url = request.url!
        let response: (Int, Data)
        if url.host == "127.0.0.1" {
            precondition(request.value(forHTTPHeaderField: "Cookie") == "prism_desktop=\(token)")
            precondition(request.value(forHTTPHeaderField: "Authorization") == nil)
            if url.path == "/api/v1/research/library/attachments" {
                Self.pageCount += 1
                response = (200, try! JSONSerialization.data(withJSONObject: [
                    "items": [["id": attachment, "reference_id": reference, "format": "pdf", "size_bytes": bytes.count, "sha256": digest]],
                    "next_cursor": NSNull(),
                ]))
            } else {
                precondition(url.path == "/api/v1/research/attachments/\(attachment)/download")
                response = (200, bytes)
            }
        } else {
            precondition(url.absoluteString == "https://dav.invalid/Fixture/prism-attachment-v1-\(digest).pdf")
            precondition(request.value(forHTTPHeaderField: "Cookie") == nil)
            if request.httpMethod == "PUT" {
                precondition(request.value(forHTTPHeaderField: "If-None-Match") == "*")
                Self.putCount += 1
                Self.uploaded = true
                response = (201, Data())
            } else {
                precondition(request.httpMethod == "GET")
                response = Self.uploaded ? (200, bytes) : (404, Data())
            }
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: response.0, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Length": String(response.1.count)])!, cacheStoragePolicy: .notAllowed)
        if !response.1.isEmpty { client?.urlProtocol(self, didLoad: response.1) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor func finish(_ sync: WebDAVAttachmentSync, containing phrase: String) async throws {
    for _ in 0..<150 {
        if sync.status.contains(phrase) { return }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    fatalError(sync.status)
}

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let configuration = URLSessionConfiguration.ephemeral
configuration.protocolClasses = [FixtureProtocol.self]
let transfer = try WebDAVAttachmentTransfer(origin: URL(string: "http://127.0.0.1:39999/today")!, token: token, configuration: configuration)
let folder = URL(string: "https://dav.invalid/Fixture/")!
let makeSync = { @MainActor in WebDAVAttachmentSync(dataDir: directory,
    createDestination: { folder, _ in WebDAVSyncDestination(folder: folder, credentialAccount: "fixture") },
    readAuthorization: { _ in nil }, deleteDestination: { _ in }) }
let sync = makeSync()
sync.connect(transfer)
try await Task.sleep(nanoseconds: 50_000_000)
precondition(FixtureProtocol.pageCount == 0)
try sync.enable(folder: folder, authorization: nil)
try await finish(sync, containing: "Verified 1 new")
precondition(FixtureProtocol.putCount == 1)
sync.stop()
let reopened = makeSync()
let known = reopened.verifiedCount
precondition(known == 1)
reopened.connect(transfer)
try await finish(reopened, containing: "No new attachment")
precondition(FixtureProtocol.putCount == 1)
try reopened.disable()
reopened.runNow()
try await Task.sleep(nanoseconds: 50_000_000)
precondition(FixtureProtocol.pageCount == 2)
`);
    const swift = (file) => fileURLToPath(new URL(`../../apps/macos/${file}.swift`, import.meta.url));
    const binary = join(scratch, 'check');
    execFileSync('xcrun', ['swiftc', main, swift('WebDAVBackup'), swift('WebDAVAttachment'), swift('WebDAVAttachmentSync'), '-o', binary], { timeout: 20000 });
    assert.doesNotThrow(() => execFileSync(binary, [scratch], { timeout: 8000, stdio: 'pipe' }));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
