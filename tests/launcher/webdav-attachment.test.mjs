import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('macOS WebDAV mirror confines credentials and verifies only the selected immutable file', {
  skip: process.platform !== 'darwin', timeout: 30000,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'prism-attachment-mirror-test-'));
  try {
    const main = join(scratch, 'main.swift');
    writeFileSync(main, String.raw`
import CryptoKit
import Foundation

let local = URL(string: "http://127.0.0.1:39999/research")!
let folder = try WebDAVBackup.folder("https://dav.invalid/Fixture%20folder/")
let reference = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
let attachment = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
let other = UUID(uuidString: "33333333-3333-4333-8333-333333333333")!
let token = String(repeating: "a", count: 64)
let authorization = try WebDAVBackup.authorization(username: "fixture", password: "example-only")!
let bytes = Data("%PDF-1.7\nSynthetic immutable content".utf8)
let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
let filename = "prism-attachment-v1-\(digest).pdf"

func listing(status: String = "ready", size: Int = bytes.count, hash: String = digest, name: String = "Fixture.pdf") throws -> Data {
    try JSONSerialization.data(withJSONObject: ["items": [["id": attachment.uuidString,
        "reference_id": reference.uuidString, "file_name": name, "size_bytes": size,
        "sha256": hash, "format": "pdf", "status": status]]])
}

func reject(_ error: WebDAVAttachmentError, _ work: () throws -> Void) {
    do { try work(); fatalError("Expected mirror validation error") }
    catch let caught as WebDAVAttachmentError { precondition(caught == error) }
    catch { fatalError("Unexpected error type") }
}

final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var visits: [String] = []
    nonisolated(unsafe) static var status = 201
    nonisolated(unsafe) static var remoteBytes = bytes
    nonisolated(unsafe) static var remoteExists = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let method = request.httpMethod!
        FixtureProtocol.lock.lock()
        FixtureProtocol.visits.append("\(method) \(url.host!)\(url.path)")
        let uploadStatus = FixtureProtocol.status
        let remoteBytes = FixtureProtocol.remoteBytes
        let remoteExists = FixtureProtocol.remoteExists
        if method == "PUT" { FixtureProtocol.remoteExists = true }
        FixtureProtocol.lock.unlock()

        let response: (Int, Data)
        if url.host == "127.0.0.1" {
            precondition(request.value(forHTTPHeaderField: "Cookie") == "prism_desktop=\(token)")
            precondition(request.value(forHTTPHeaderField: "Authorization") == nil)
            if url.path == "/api/v1/research/references/\(reference.uuidString.lowercased())/attachments" {
                response = (200, try! listing())
            } else {
                precondition(url.path == "/api/v1/research/attachments/\(attachment.uuidString.lowercased())/download")
                response = (200, bytes)
            }
        } else {
            precondition(url.absoluteString == "https://dav.invalid/Fixture%20folder/\(filename)")
            precondition(request.value(forHTTPHeaderField: "Cookie") == nil)
            precondition(request.value(forHTTPHeaderField: "Authorization") == authorization)
            if method == "PUT" {
                precondition(request.value(forHTTPHeaderField: "If-None-Match") == "*")
                precondition(request.value(forHTTPHeaderField: "Content-Type") == "application/pdf")
                response = (uploadStatus, Data())
            } else { response = remoteExists ? (200, remoteBytes) : (404, Data()) }
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: response.0,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Length": String(response.1.count)])!, cacheStoragePolicy: .notAllowed)
        if !response.1.isEmpty { client?.urlProtocol(self, didLoad: response.1) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

let configuration = URLSessionConfiguration.ephemeral
configuration.protocolClasses = [FixtureProtocol.self]
let transfer = try WebDAVAttachmentTransfer(origin: local, token: token, configuration: configuration)
reject(.unavailable) { _ = try transfer.localRequest(path: "https://dav.invalid/fixture") }
reject(.unavailable) { _ = try transfer.localRequest(path: "http://127.0.0.1:40000/fixture") }
reject(.unavailable) { _ = try WebDAVAttachment.selected(in: listing(), referenceID: other, attachmentID: attachment) }
reject(.unavailable) { _ = try WebDAVAttachment.selected(in: listing(), referenceID: reference, attachmentID: other) }
for invalid in try [listing(status: "uploading"), listing(size: 33 * 1024 * 1024), listing(hash: "invalid"), listing(name: "../fixture.pdf")] {
    reject(.unavailable) { _ = try WebDAVAttachment.selected(in: invalid, referenceID: reference, attachmentID: attachment) }
}
let entry = try await transfer.selected(referenceID: reference, attachmentID: attachment)
precondition(entry.remoteName == filename)
reject(.integrity) { _ = try entry.verified(Data(repeating: 32, count: bytes.count)) }
try await transfer.send(entry, folder: folder, authorization: authorization)
FixtureProtocol.status = 412
FixtureProtocol.remoteExists = false
try await transfer.send(entry, folder: folder, authorization: authorization)
try await transfer.send(entry, folder: folder, authorization: authorization)
let restored = try await transfer.retrieve(entry, folder: folder, authorization: authorization)
precondition(restored == bytes)
for wrongBytes in [Data(repeating: 0, count: bytes.count), bytes + Data([0])] {
    FixtureProtocol.remoteBytes = wrongBytes
    do { _ = try await transfer.retrieve(entry, folder: folder, authorization: authorization); fatalError("Corrupt copy accepted") }
    catch let error as WebDAVAttachmentError { precondition(error == .integrity) }
}
let davVisits = FixtureProtocol.visits.filter { $0.contains(" dav.invalid/") }
precondition(davVisits.map { $0.split(separator: " ")[0] } == ["GET", "PUT", "GET", "GET", "PUT", "GET", "GET", "GET", "GET", "GET"])
precondition(FixtureProtocol.visits.filter { $0.hasPrefix("GET 127.0.0.1/api/v1/research/attachments/") }.count == 2)
`);
    const swift = (file) => fileURLToPath(new URL(`../../apps/macos/${file}.swift`, import.meta.url));
    const binary = join(scratch, 'check');
    execFileSync('xcrun', ['swiftc', main, swift('WebDAVBackup'), swift('WebDAVAttachment'), '-o', binary], { timeout: 20000 });
    execFileSync(binary, { timeout: 8000 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
