import Darwin
import Foundation
import Security

enum WorkspaceBackupError: LocalizedError {
    case key, unavailable, invalid, invalidRecoveryCode, tooLarge, save

    var errorDescription: String? {
        switch self {
        case .key: return "The local backup key is unavailable. Unlock the login Keychain and try again."
        case .unavailable: return "The workspace backup service is unavailable. Try again after PRISM is ready."
        case .invalid: return "PRISM could not verify this backup. Check the file and use the original Keychain key or its recovery code."
        case .invalidRecoveryCode: return "Enter a PRISM recovery code containing 64 hexadecimal characters."
        case .tooLarge: return "The workspace database exceeds the current 128 MiB backup limit."
        case .save: return "PRISM could not save the backup in the selected location."
        }
    }
}

struct WorkspaceBackup {
    enum Operation: String, Encodable { case create, validate, restore, open }
    struct Result: Decodable {
        let ok: Bool
        let knowledgeItems: Int?
        let attachments: Int?
        let reason: String?
    }
    struct Request: Encodable {
        let type = "prism-workspace-backup"
        let operation: Operation
        let id: String
        let key: String
    }

    private static let maximumBytes = 128 * 1024 * 1024 + 256
    private static let fileManager = FileManager.default
    let root: URL

    init() throws {
        let temporary = Self.fileManager.temporaryDirectory.appendingPathComponent("prism-workspace-backup.XXXXXX")
        var name = Array(temporary.path.utf8CString)
        guard let folder = mkdtemp(&name) else { throw WorkspaceBackupError.unavailable }
        root = URL(fileURLWithPath: String(cString: folder), isDirectory: true)
    }

    func requestFolder() throws -> (String, URL) {
        let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let folder = root.appendingPathComponent(id, isDirectory: true)
        try Self.fileManager.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return (id, folder)
    }

    static func archive(in folder: URL) -> URL { folder.appendingPathComponent("archive.prismbackup") }

    static func key(create: Bool) throws -> Data {
        let service = (Bundle.main.bundleIdentifier ?? "app.prism.desktop.release") + ".workspace-backup"
        let identity: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "local-v1"]
        var lookup = identity
        lookup[kSecReturnData] = true
        lookup[kSecMatchLimit] = kSecMatchLimitOne
        var output: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &output)
        if status == errSecSuccess, let key = output as? Data, key.count == 32 { return key }
        guard status == errSecItemNotFound, create else { throw WorkspaceBackupError.key }
        var key = Data(count: 32)
        let random = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
        guard random == errSecSuccess else { throw WorkspaceBackupError.key }
        var record = identity
        record[kSecValueData] = key
        let added = SecItemAdd(record as CFDictionary, nil)
        if added == errSecDuplicateItem { return try Self.key(create: false) }
        guard added == errSecSuccess else { throw WorkspaceBackupError.key }
        return key
    }

    static func parseRecoveryCode(_ input: String) throws -> Data {
        guard input.utf8.count <= 256 else { throw WorkspaceBackupError.invalidRecoveryCode }
        let digits = Array(input.utf8.filter { ![9, 10, 13, 32, 45].contains($0) })
        guard digits.count == 64, digits.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else {
            throw WorkspaceBackupError.invalidRecoveryCode
        }
        var key = Data(capacity: 32)
        for index in stride(from: 0, to: digits.count, by: 2) {
            guard let value = UInt8(String(decoding: digits[index...index + 1], as: UTF8.self), radix: 16) else {
                throw WorkspaceBackupError.invalidRecoveryCode
            }
            key.append(value)
        }
        return key
    }

    static func exportRecoveryCode(to destination: URL) throws {
        var key = try Self.key(create: false)
        defer { key.resetBytes(in: key.startIndex..<key.endIndex) }
        var text = Data((key.map { String(format: "%02x", $0) }.joined() + "\n").utf8)
        defer { text.resetBytes(in: text.startIndex..<text.endIndex) }
        try saveExclusively(to: destination) { output in try output.write(contentsOf: text) }
    }

    static func stage(_ source: URL, in folder: URL) throws {
        let descriptor = open(source.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw WorkspaceBackupError.invalid }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size > 0, info.st_size <= maximumBytes else { throw WorkspaceBackupError.invalid }
        let target = open(archive(in: folder).path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard target >= 0 else { throw WorkspaceBackupError.unavailable }
        let output = FileHandle(fileDescriptor: target, closeOnDealloc: true)
        defer { try? output.close() }
        var total = 0
        while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            total += chunk.count
            guard total <= maximumBytes else { throw WorkspaceBackupError.invalid }
            try output.write(contentsOf: chunk)
        }
        guard total == info.st_size else { throw WorkspaceBackupError.invalid }
    }

    static func save(from folder: URL, to destination: URL) throws {
        let archive = archive(in: folder)
        let values = try archive.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= maximumBytes else { throw WorkspaceBackupError.save }
        try saveExclusively(to: destination) { output in
            let input = try FileHandle(forReadingFrom: archive)
            defer { try? input.close() }
            var total = 0
            while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty {
                total += chunk.count
                guard total <= size else { throw WorkspaceBackupError.save }
                try output.write(contentsOf: chunk)
            }
            guard total == size else { throw WorkspaceBackupError.save }
        }
    }

    private static func saveExclusively(to destination: URL, write: (FileHandle) throws -> Void) throws {
        var stagingName = Array(destination.deletingLastPathComponent().appendingPathComponent(".prism-workspace.XXXXXX").path.utf8CString)
        let descriptor = mkstemp(&stagingName)
        guard descriptor >= 0 else { throw WorkspaceBackupError.save }
        let staging = URL(fileURLWithPath: String(cString: stagingName))
        defer { try? fileManager.removeItem(at: staging) }
        let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? output.close() }
        try write(output)
        try output.synchronize()
        guard renamex_np(staging.path, destination.path, UInt32(RENAME_EXCL)) == 0 else { throw WorkspaceBackupError.save }
    }

    static func saveRestoredWorkspace(from folder: URL, to destination: URL) throws {
        let database = folder.appendingPathComponent("database", isDirectory: true)
        let values = try database.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw WorkspaceBackupError.invalid }
        var stagingName = Array(destination.deletingLastPathComponent().appendingPathComponent(".prism-recovery.XXXXXX").path.utf8CString)
        guard let stagingPath = mkdtemp(&stagingName) else { throw WorkspaceBackupError.save }
        let staging = URL(fileURLWithPath: String(cString: stagingPath), isDirectory: true)
        defer { try? fileManager.removeItem(at: staging) }
        try fileManager.copyItem(at: database, to: staging.appendingPathComponent("database", isDirectory: true))
        guard renamex_np(staging.path, destination.path, UInt32(RENAME_EXCL)) == 0 else { throw WorkspaceBackupError.save }
    }

    static func send(_ operation: Operation, id: String, key: Data, using channel: FileHandle) throws {
        let hex = key.map { String(format: "%02x", $0) }.joined()
        var bytes = try JSONEncoder().encode(Request(operation: operation == .open ? .restore : operation, id: id, key: hex))
        bytes.append(10)
        defer { bytes.resetBytes(in: bytes.startIndex..<bytes.endIndex) }
        try channel.write(contentsOf: bytes)
    }

    static func wait(in folder: URL, launcher: Process) async throws -> Result {
        let path = folder.appendingPathComponent("result.json")
        for _ in 0..<1200 {
            try Task.checkCancellation()
            guard launcher.isRunning else { throw WorkspaceBackupError.unavailable }
            if let values = try? path.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
               values.isRegularFile == true, values.isSymbolicLink != true, let size = values.fileSize, size <= 1024 {
                return try JSONDecoder().decode(Result.self, from: Data(contentsOf: path))
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw WorkspaceBackupError.unavailable
    }
}
