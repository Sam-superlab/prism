import Foundation
import Security

struct WebDAVSyncDestination: Codable {
    private struct Credential: Codable { let folder: URL; let authorization: String }
    let folder: URL
    let credentialAccount: String

    static func create(folder: URL, authorization: String?) throws -> Self {
        let folder = try WebDAVBackup.folder(folder.absoluteString)
        let account = UUID().uuidString.lowercased()
        let payload = try JSONEncoder().encode(Credential(folder: folder, authorization: authorization ?? ""))
        let values = Self.credential(account).merging([kSecValueData: payload]) { _, new in new }
        guard SecItemAdd(values as CFDictionary, nil) == errSecSuccess else { throw WebDAVSyncError.keychain }
        return Self(folder: folder, credentialAccount: account)
    }

    func authorization() throws -> String? {
        let query = Self.credential(credentialAccount).merging([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) { _, new in new }
        var value: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data, let payload = try? JSONDecoder().decode(Credential.self, from: data),
              payload.folder == folder, payload.authorization.isEmpty || payload.authorization.hasPrefix("Basic ") else {
            throw WebDAVSyncError.keychain
        }
        return payload.authorization.isEmpty ? nil : payload.authorization
    }

    func deleteCredential() {
        SecItemDelete(Self.credential(credentialAccount) as CFDictionary)
    }

    private static func credential(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword,
         kSecAttrService: (Bundle.main.bundleIdentifier ?? "app.prism.desktop.release") + ".webdav-attachment-sync",
         kSecAttrAccount: account]
    }
}

enum WebDAVSyncError: LocalizedError {
    case keychain, limit

    var errorDescription: String? {
        switch self {
        case .keychain: return "PRISM could not access the WebDAV credential in Keychain."
        case .limit: return "This WebDAV sync run reached its local library scan limit."
        }
    }
}

@MainActor final class WebDAVAttachmentSync {
    private struct State: Codable {
        var destination: WebDAVSyncDestination
        var verified: Set<String> = []
    }

    private let store: URL
    private let createDestination: (URL, String?) throws -> WebDAVSyncDestination
    private let readAuthorization: (WebDAVSyncDestination) throws -> String?
    private let deleteDestination: (WebDAVSyncDestination) -> Void
    private var state: State?
    private var interval: Timer?
    private var task: Task<Void, Never>?
    private var transfer: WebDAVAttachmentTransfer?
    private var scanCursor: String?
    private var pendingPage: [WebDAVAttachment] = []
    private var generation = UUID()
    private var failures = 0
    private var nextAttempt = Date.distantPast
    private(set) var status = "Automatic WebDAV attachment copies are off."

    init(dataDir: URL,
         createDestination: @escaping (URL, String?) throws -> WebDAVSyncDestination = WebDAVSyncDestination.create,
         readAuthorization: @escaping (WebDAVSyncDestination) throws -> String? = { try $0.authorization() },
         deleteDestination: @escaping (WebDAVSyncDestination) -> Void = { $0.deleteCredential() }) {
        store = dataDir.appendingPathComponent("webdav-attachment-sync-v1.json")
        self.createDestination = createDestination
        self.readAuthorization = readAuthorization
        self.deleteDestination = deleteDestination
        if let values = try? store.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
           values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size <= 2 * 1024 * 1024,
           let data = try? Data(contentsOf: store), let saved = try? JSONDecoder().decode(State.self, from: data),
           (try? WebDAVBackup.folder(saved.destination.folder.absoluteString)) != nil {
            state = saved
            status = "Waiting for PRISM to connect to your local workspace."
        }
    }

    var enabled: Bool { state != nil }
    var destination: URL? { state?.destination.folder }
    var verifiedCount: Int { state?.verified.count ?? 0 }

    func connect(_ connection: WebDAVAttachmentTransfer) {
        transfer = connection
        schedule()
    }

    func enable(folder: URL, authorization: String?) throws {
        let new = try createDestination(folder, authorization)
        let next = State(destination: new)
        do { try persist(next) }
        catch { deleteDestination(new); throw error }
        let previous = state
        stop()
        state = next
        if let previous { deleteDestination(previous.destination) }
        status = "Automatic WebDAV attachment copies are enabled."
        schedule()
    }

    func disable() throws {
        let previous = state
        stop()
        do { if FileManager.default.fileExists(atPath: store.path) { try FileManager.default.removeItem(at: store) } }
        catch { state = previous; schedule(); throw error }
        state = nil
        if let previous { deleteDestination(previous.destination) }
        status = "Automatic WebDAV attachment copies are off."
    }

    func stop() {
        interval?.invalidate()
        interval = nil
        task?.cancel()
        task = nil
        generation = UUID()
        failures = 0
        nextAttempt = .distantPast
        scanCursor = nil
        pendingPage = []
    }

    func runNow() {
        guard task == nil else { return }
        failures = 0
        nextAttempt = .distantPast
        scanCursor = nil
        pendingPage = []
        startIfDue()
    }

    private func schedule() {
        guard enabled, transfer != nil, interval == nil else { return }
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.startIfDue() }
        }
        RunLoop.main.add(timer, forMode: .common)
        interval = timer
        startIfDue()
    }

    private func persist(_ saved: State) throws {
        let data = try JSONEncoder().encode(saved)
        guard data.count <= 2 * 1024 * 1024 else { throw WebDAVSyncError.limit }
        try data.write(to: store, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: store.path)
    }

    private func startIfDue() {
        guard let saved = state, let transfer, task == nil, Date() >= nextAttempt else { return }
        let active = generation
        status = "Checking for new attachment copies…"
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if self.generation == active { self.task = nil } }
            do {
                let auth = try self.readAuthorization(saved.destination)
                let (copied, more) = try await self.mirror(transfer, folder: saved.destination.folder, authorization: auth, active: active)
                guard self.generation == active, !Task.isCancelled else { return }
                self.failures = 0
                self.nextAttempt = Date().addingTimeInterval(more ? 60 : 15 * 60)
                self.status = more ? "Verified \(copied) new copies. The scan will continue shortly." :
                    copied == 0 ? "No new attachment copies were needed." : "Verified \(copied) new attachment copies."
            } catch {
                guard self.generation == active, !Task.isCancelled else { return }
                let transient = (error as? WebDAVAttachmentError).map { [.failed, .transient, .unavailable].contains($0) } ?? false
                self.failures += 1
                if transient && self.failures <= 3 {
                    self.nextAttempt = Date().addingTimeInterval(TimeInterval(60 * (1 << (self.failures - 1))))
                    self.status = "WebDAV sync paused briefly. Retry \(self.failures) of 3 is scheduled."
                } else {
                    self.nextAttempt = .distantFuture
                    self.status = error.localizedDescription + " Use Sync Now to retry."
                }
            }
        }
    }

    private func mirror(_ transfer: WebDAVAttachmentTransfer, folder: URL, authorization: String?, active: UUID) async throws -> (Int, Bool) {
        var copied = 0
        for step in 0..<100 {
            try Task.checkCancellation()
            if pendingPage.isEmpty {
                if step > 0 && scanCursor == nil { return (copied, false) }
                let page = try await transfer.attachmentPage(cursor: scanCursor)
                guard generation == active, !Task.isCancelled else { throw CancellationError() }
                pendingPage = page.items
                scanCursor = page.nextCursor
            }
            while let attachment = pendingPage.first {
                guard let current = state, generation == active, !Task.isCancelled else { throw CancellationError() }
                if current.verified.contains(attachment.remoteName) { pendingPage.removeFirst(); continue }
                do { try await transfer.send(attachment, folder: folder, authorization: authorization) }
                catch WebDAVAttachmentError.unavailable {
                    guard generation == active, !Task.isCancelled else { throw CancellationError() }
                    pendingPage.removeFirst()
                    continue
                }
                guard var next = state, generation == active, !Task.isCancelled else { throw CancellationError() }
                next.verified.insert(attachment.remoteName)
                try persist(next)
                state = next
                pendingPage.removeFirst()
                copied += 1
                if copied >= 20 { return (copied, !pendingPage.isEmpty || scanCursor != nil) }
            }
        }
        return (copied, scanCursor != nil)
    }
}
