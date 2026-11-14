import CryptoKit
import Foundation

enum WebDAVAttachmentError: LocalizedError {
    case unavailable, invalidResponse, permission, missing, integrity, failed, transient

    var errorDescription: String? {
        switch self {
        case .unavailable: return "The selected attachment is no longer available in this workspace."
        case .invalidResponse: return "The destination returned an unexpected response."
        case .permission: return "The WebDAV server refused access. Check the folder and app password."
        case .missing: return "The destination folder or attachment copy was not found."
        case .integrity: return "The copy did not match the selected attachment’s size and SHA-256 digest."
        case .failed: return "The transfer failed. Check the HTTPS address and your connection."
        case .transient: return "The WebDAV server is temporarily unavailable."
        }
    }
}

struct WebDAVAttachment: Decodable {
    enum Format: String, Decodable {
        case pdf, epub, webpage

        var fileExtension: String { self == .webpage ? "txt" : rawValue }
        var contentType: String {
            switch self {
            case .pdf: return "application/pdf"
            case .epub: return "application/epub+zip"
            case .webpage: return "text/plain; charset=utf-8"
            }
        }
    }

    static let maximumBytes = 32 * 1024 * 1024
    let id: UUID
    let referenceID: UUID
    let fileName: String?
    let size: Int
    let digest: String
    let format: Format
    let status: String?

    private enum CodingKeys: String, CodingKey {
        case id, status, format
        case referenceID = "reference_id", fileName = "file_name", size = "size_bytes", digest = "sha256"
    }

    private struct Listing: Decodable { let items: [WebDAVAttachment] }

    struct Page: Decodable {
        let items: [WebDAVAttachment]
        let nextCursor: String?
        enum CodingKeys: String, CodingKey { case items; case nextCursor = "next_cursor" }
    }

    static func selected(in listing: Data, referenceID: UUID, attachmentID: UUID) throws -> WebDAVAttachment {
        guard let rows = try? JSONDecoder().decode(Listing.self, from: listing),
              let entry = rows.items.first(where: { $0.id == attachmentID && $0.referenceID == referenceID }),
              entry.status == "ready", entry.validIdentity, let name = entry.fileName,
              name.count <= 200, name.lowercased().hasSuffix(".\(entry.format.fileExtension)"),
              name.rangeOfCharacter(from: .controlCharacters) == nil,
              !name.contains("/"), !name.contains("\\") else {
            throw WebDAVAttachmentError.unavailable
        }
        return entry
    }

    var validIdentity: Bool {
        (1...Self.maximumBytes).contains(size) && digest.count == 64 &&
            digest.range(of: "^[a-f0-9]+$", options: .regularExpression) != nil
    }

    var displayName: String { fileName ?? "Attachment.\(format.fileExtension)" }

    var remoteName: String { "prism-attachment-v1-\(digest).\(format.fileExtension)" }

    func verified(_ bytes: Data) throws -> Data {
        guard bytes.count == size,
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == digest else {
            throw WebDAVAttachmentError.integrity
        }
        return bytes
    }
}

struct WebDAVAttachmentTransfer {
    private let localOrigin: URL
    private let localToken: String
    private let configuration: URLSessionConfiguration

    init(origin: URL, token: String, configuration: URLSessionConfiguration = .ephemeral) throws {
        guard origin.scheme == "http", origin.host == "127.0.0.1", origin.port != nil,
              origin.user == nil, origin.password == nil,
              token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw WebDAVAttachmentError.unavailable
        }
        localOrigin = origin
        localToken = token
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 3 * 60
        self.configuration = configuration
    }

    func localRequest(path: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: localOrigin)?.absoluteURL,
              url.scheme == localOrigin.scheme, url.host == localOrigin.host, url.port == localOrigin.port,
              url.user == nil, url.password == nil else { throw WebDAVAttachmentError.unavailable }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("prism_desktop=\(localToken)", forHTTPHeaderField: "Cookie")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        return request
    }

    func selected(referenceID: UUID, attachmentID: UUID) async throws -> WebDAVAttachment {
        let request = try localRequest(path: "/api/v1/research/references/\(referenceID.uuidString.lowercased())/attachments")
        let reply = try await fetch(request, limit: 512 * 1024, collectStatus: 200)
        guard reply.status == 200 else { throw WebDAVAttachmentError.unavailable }
        return try WebDAVAttachment.selected(in: reply.data, referenceID: referenceID, attachmentID: attachmentID)
    }

    func attachmentPage(cursor: String?) async throws -> WebDAVAttachment.Page {
        var target = URLComponents()
        target.path = "/api/v1/research/library/attachments"
        target.queryItems = [URLQueryItem(name: "limit", value: "100")]
        if let cursor { target.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        guard let path = target.string else { throw WebDAVAttachmentError.unavailable }
        let reply = try await fetch(localRequest(path: path), limit: 64 * 1024, collectStatus: 200)
        guard reply.status == 200, let page = try? JSONDecoder().decode(WebDAVAttachment.Page.self, from: reply.data),
              page.items.count <= 100, page.items.allSatisfy(\.validIdentity),
              page.nextCursor.map({ $0.count <= 4096 && $0 != cursor }) ?? true else { throw WebDAVAttachmentError.unavailable }
        return page
    }

    private func localCopy(_ attachment: WebDAVAttachment) async throws -> Data {
        let request = try localRequest(path: "/api/v1/research/attachments/\(attachment.id.uuidString.lowercased())/download")
        let reply = try await fetch(request, limit: attachment.size, collectStatus: 200)
        if reply.status == 404 { throw WebDAVAttachmentError.unavailable }
        guard reply.status == 200 else { throw WebDAVAttachmentError.transient }
        return try attachment.verified(reply.data)
    }

    func remoteRequest(_ attachment: WebDAVAttachment, folder: URL, authorization: String?, upload: Bool) throws -> URLRequest {
        let target = try WebDAVBackup.folder(folder.absoluteString).appendingPathComponent(attachment.remoteName)
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if upload {
            request.httpMethod = "PUT"
            request.setValue("*", forHTTPHeaderField: "If-None-Match")
            request.setValue(attachment.format.contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(String(attachment.size), forHTTPHeaderField: "Content-Length")
        }
        return request
    }

    func retrieve(_ attachment: WebDAVAttachment, folder: URL, authorization: String?) async throws -> Data {
        let request = try remoteRequest(attachment, folder: folder, authorization: authorization, upload: false)
        let reply = try await fetch(request, limit: attachment.size, collectStatus: 200)
        guard reply.status == 200 else { throw remoteError(reply.status) }
        return try attachment.verified(reply.data)
    }

    func send(_ attachment: WebDAVAttachment, folder: URL, authorization: String?) async throws {
        // Confirm an existing object before issuing PUT, even when the server ignores preconditions.
        do { _ = try await retrieve(attachment, folder: folder, authorization: authorization); return }
        catch WebDAVAttachmentError.missing { }
        let data = try await localCopy(attachment)
        let request = try remoteRequest(attachment, folder: folder, authorization: authorization, upload: true)
        let reply = try await fetch(request, limit: 0, collectStatus: nil, upload: data)
        guard [201, 204, 412].contains(reply.status) else { throw remoteError(reply.status) }
        _ = try await retrieve(attachment, folder: folder, authorization: authorization)
    }

    private func remoteError(_ status: Int) -> WebDAVAttachmentError {
        switch status {
        case 401, 403: return .permission
        case 404, 409: return .missing
        case 408, 425, 429, 500...599: return .transient
        default: return .invalidResponse
        }
    }

    private func fetch(_ request: URLRequest, limit: Int, collectStatus: Int?, upload: Data? = nil) async throws -> (status: Int, data: Data) {
        let cancellation = MirrorCancellation()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let delegate = MirrorResponse(limit: limit, collectStatus: collectStatus) { result in
                    continuation.resume(with: result)
                }
                let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
                let task = upload.map { session.uploadTask(with: request, from: $0) } ?? session.dataTask(with: request)
                cancellation.start(task)
                session.finishTasksAndInvalidate()
            }
        } onCancel: {
            cancellation.cancel()
        }
    }
}

private final class MirrorResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int
    private let collectStatus: Int?
    private let complete: (Result<(status: Int, data: Data), Error>) -> Void
    private var status: Int?
    private var exceeded = false
    private var received = Data()

    init(limit: Int, collectStatus: Int?, complete: @escaping (Result<(status: Int, data: Data), Error>) -> Void) {
        self.limit = limit
        self.collectStatus = collectStatus
        self.complete = complete
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode
        exceeded = status == collectStatus && response.expectedContentLength > Int64(limit)
        completionHandler(exceeded || status == nil ? .cancel : .allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard status == collectStatus, !exceeded else { return }
        guard data.count <= limit - received.count else {
            exceeded = true
            dataTask.cancel()
            return
        }
        received.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if exceeded { complete(.failure(WebDAVAttachmentError.integrity)) }
        else if error != nil { complete(.failure(WebDAVAttachmentError.failed)) }
        else if let status { complete(.success((status, received))) }
        else { complete(.failure(WebDAVAttachmentError.invalidResponse)) }
    }
}

private final class MirrorCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false

    func start(_ task: URLSessionTask) {
        lock.lock()
        defer { lock.unlock() }
        self.task = task
        if cancelled { task.cancel() }
        else { task.resume() }
    }

    func cancel() {
        lock.lock()
        defer { lock.unlock() }
        cancelled = true
        task?.cancel()
    }
}
