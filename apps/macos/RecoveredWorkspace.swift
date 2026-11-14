import Cocoa
import WebKit

@MainActor final class RecoveredWorkspace: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private let scratch: URL
    private let window: NSWindow
    private let web: WKWebView
    private let process = Process()
    private let token = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    private var origin: URL?
    private var opening: Task<Void, Never>?
    private var dismissed = false
    var didClose: (() -> Void)?

    private struct Readiness: Decodable { let webOrigin: URL }

    init(scratch: URL, resources: URL, executable: URL) {
        self.scratch = scratch
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "PRISM · Recovered Workspace (Read Only)"
        window.minSize = NSSize(width: 740, height: 500)
        window.contentView = web
        super.init()
        window.delegate = self
        web.navigationDelegate = self
        process.executableURL = executable.deletingLastPathComponent().appendingPathComponent("node")
        process.arguments = [resources.appendingPathComponent("desktop/launch.mjs").path]
        process.currentDirectoryURL = resources
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.environment = ["PRISM_DATA_DIR": scratch.path, "PRISM_DESKTOP_TOKEN": token,
            "PRISM_DESKTOP_WEB_PORT": "0", "PRISM_DESKTOP_READY_FILE": scratch.appendingPathComponent("ready.json").path,
            "PRISM_DESKTOP_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier),
            "PRISM_RECOVERY_PREVIEW": "true", "TMPDIR": FileManager.default.temporaryDirectory.path]
    }

    func show() throws {
        let folder = scratch
        process.terminationHandler = { [weak self] _ in
            try? FileManager.default.removeItem(at: folder)
            DispatchQueue.main.async { [weak self] in self?.serviceEnded() }
        }
        try process.run()
        window.center()
        window.makeKeyAndOrderFront(nil)
        showMessage("Opening recovered workspace…")
        opening = Task { @MainActor [weak self] in
            do { try await self?.load() }
            catch { if !Task.isCancelled { self?.closeService(); self?.showMessage("The recovered workspace could not be opened.") } }
        }
    }

    private func load() async throws {
        let ready = scratch.appendingPathComponent("ready.json")
        for _ in 0..<340 {
            try Task.checkCancellation()
            guard process.isRunning else { throw WorkspaceBackupError.unavailable }
            if let data = try? Data(contentsOf: ready) {
                let address = try JSONDecoder().decode(Readiness.self, from: data).webOrigin
                guard address.scheme == "http", address.host == "127.0.0.1", let port = address.port,
                      port >= 1024, port <= 65535, address.user == nil, address.password == nil,
                      address.path.isEmpty, address.query == nil, address.fragment == nil else { throw WorkspaceBackupError.unavailable }
                // Block remote images and other subresources as well as external navigation.
                let rules = """
                [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
                 {"trigger":{"url-filter":"^http://127\\\\.0\\\\.0\\\\.1:\(port)/"},"action":{"type":"ignore-previous-rules"}}]
                """
                let list = try await WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: "prism-recovery-\(scratch.lastPathComponent)", encodedContentRuleList: rules)
                guard let list, !Task.isCancelled, process.isRunning else { throw WorkspaceBackupError.unavailable }
                web.configuration.userContentController.add(list)
                origin = address
                guard let cookie = HTTPCookie(properties: [.name: "prism_desktop", .value: token,
                    .domain: "127.0.0.1", .path: "/", .discard: "TRUE", .sameSitePolicy: "Strict",
                    HTTPCookiePropertyKey("HttpOnly"): "TRUE"]) else { throw WorkspaceBackupError.unavailable }
                await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                guard !Task.isCancelled else { return }
                web.load(URLRequest(url: address.appendingPathComponent("knowledge")))
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw WorkspaceBackupError.unavailable
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let local = origin.map { url.scheme == $0.scheme && url.host == $0.host && url.port == $0.port } ?? false
        decisionHandler((local || url.absoluteString == "about:blank") && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }

    private func showMessage(_ message: String) {
        web.loadHTMLString("<body style='font:17px -apple-system;padding:40px'>\(message)</body>", baseURL: nil)
    }

    private func serviceEnded() {
        removeContentRules()
        if !dismissed { showMessage("The recovered workspace has closed.") }
    }

    func close() { window.close() }

    private func closeService() {
        opening?.cancel()
        if process.isRunning { process.terminate() }
    }

    private func removeContentRules() {
        let rule = "prism-recovery-\(scratch.lastPathComponent)"
        WKContentRuleListStore.default().removeContentRuleList(forIdentifier: rule) { _ in }
    }

    func windowWillClose(_ notification: Notification) {
        dismissed = true
        web.stopLoading()
        removeContentRules()
        closeService()
        didClose?()
    }
}
