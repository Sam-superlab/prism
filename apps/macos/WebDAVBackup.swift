import Foundation

enum WebDAVBackupError: LocalizedError {
    case invalidFolder, invalidCredentials, invalidArchive, tooLarge, invalidResponse, forbidden, unavailable, collision, failed

    var errorDescription: String? {
        switch self {
        case .invalidFolder: return "Enter an HTTPS folder address without credentials, a query, or a fragment."
        case .invalidCredentials: return "Enter both a username and an app password, or leave both blank."
        case .invalidArchive: return "Choose a readable ZIP archive."
        case .tooLarge: return "Choose a ZIP archive no larger than 512 MiB."
        case .invalidResponse: return "The destination did not confirm a successful upload."
        case .forbidden: return "The destination refused access. Check the folder and app password."
        case .unavailable: return "The destination folder was not found. Create it on the server and try again."
        case .collision: return "The destination already has this file. Try again to generate another name."
        case .failed: return "The transfer failed. Check the HTTPS address and your connection. The local file is still available."
        }
    }
}

private final class WebDAVTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let complete: (URLResponse?, Error?) -> Void

    init(complete: @escaping (URLResponse?, Error?) -> Void) {
        self.complete = complete
    }

    // Ignore response bodies so an untrusted WebDAV endpoint cannot allocate one in the app.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {}

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        complete(task.response, error)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum WebDAVBackup {
    static let maxBytes = 512 * 1024 * 1024

    static func folder(_ input: String) throws -> URL {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.count <= 2_000, !raw.contains("\\"), !raw.contains("?"), !raw.contains("#"),
              let components = URLComponents(string: raw), components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let url = components.url else { throw WebDAVBackupError.invalidFolder }
        return url
    }

    static func authorization(username: String, password: String) throws -> String? {
        if username.isEmpty && password.isEmpty { return nil }
        guard !username.isEmpty, !password.isEmpty, !username.contains(":"),
              username.utf8.count <= 256, password.utf8.count <= 1024,
              username.rangeOfCharacter(from: .controlCharacters) == nil,
              password.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw WebDAVBackupError.invalidCredentials
        }
        return "Basic " + Data((username + ":" + password).utf8).base64EncodedString()
    }

    static func archiveSize(_ archive: URL) throws -> Int {
        guard archive.isFileURL, archive.pathExtension.lowercased() == "zip",
              let values = try? archive.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size >= 22,
              let file = try? FileHandle(forReadingFrom: archive) else { throw WebDAVBackupError.invalidArchive }
        defer { try? file.close() }
        guard size <= maxBytes else { throw WebDAVBackupError.tooLarge }
        guard let signature = try? file.read(upToCount: 4),
              signature == Data([0x50, 0x4B, 0x03, 0x04]) else { throw WebDAVBackupError.invalidArchive }
        return size
    }

    static func request(folder: URL, authorization: String?, size: Int, id: UUID = UUID()) -> URLRequest {
        let target = folder.appendingPathComponent("PRISM-archive-" + id.uuidString.lowercased() + ".zip")
        var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpMethod = "PUT"
        request.setValue("application/zip", forHTTPHeaderField: "Content-Type")
        request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        request.setValue("*", forHTTPHeaderField: "If-None-Match")
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        return request
    }

    static func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw WebDAVBackupError.invalidResponse }
        switch http.statusCode {
        case 201, 204: return
        case 401, 403: throw WebDAVBackupError.forbidden
        case 404, 409: throw WebDAVBackupError.unavailable
        case 412: throw WebDAVBackupError.collision
        default: throw WebDAVBackupError.invalidResponse
        }
    }

    static func upload(archive: URL, folder: URL, authorization: String?) async throws -> String {
        let size = try archiveSize(archive)
        let request = request(folder: folder, authorization: authorization, size: size)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 10 * 60
        let transfer = WebDAVUploadTask()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let delegate = WebDAVTransfer { response, error in
                    if error != nil {
                        continuation.resume(throwing: WebDAVBackupError.failed)
                        return
                    }
                    do {
                        guard let response else { throw WebDAVBackupError.invalidResponse }
                        try validate(response)
                        continuation.resume()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
                let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
                transfer.start(session.uploadTask(with: request, fromFile: archive))
                session.finishTasksAndInvalidate()
            }
        } onCancel: {
            transfer.cancel()
        }
        return request.url!.lastPathComponent
    }
}

private final class WebDAVUploadTask: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionUploadTask?
    private var canceled = false

    func start(_ next: URLSessionUploadTask) {
        lock.lock()
        defer { lock.unlock() }
        task = next
        if canceled { next.cancel() }
        else { next.resume() }
    }

    func cancel() {
        lock.lock()
        defer { lock.unlock() }
        canceled = true
        task?.cancel()
    }
}
