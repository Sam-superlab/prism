import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var launcher: Process?
    var logHandle: FileHandle?
    var timer: Timer?
    var attempts = 0
    var checking = false
    var address = URL(string: "http://localhost:3000/today")!
    var failed = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let icon = Bundle.main.url(forResource: "AppIcon", withExtension: "icns").flatMap({ NSImage(contentsOf: $0) }) {
            NSApp.applicationIconImage = icon
        }
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About PRISM", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit PRISM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); menu.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "")
        NSApp.mainMenu = menu
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "prismAppearance")
        let appearanceScript = """
        (function(){function send(){try{window.webkit.messageHandlers.prismAppearance.postMessage({theme:document.documentElement.dataset.theme||'system'})}catch(e){}}function attach(){if(!document.documentElement)return false;send();new MutationObserver(send).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return true}if(!attach()){var observer=new MutationObserver(function(){if(attach())observer.disconnect()});observer.observe(document,{childList:true,subtree:true})}})();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: appearanceScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "PRISM"
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.backgroundColor = .windowBackgroundColor
        window.minSize = NSSize(width: 800, height: 600)
        window.contentView = web
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(displayOptionsChanged(_:)),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<html lang='en'><body style='background:#faf8f5;color:#715d92;font:18px -apple-system;padding:70px'><h1>PRISM</h1><p>Starting your personal workspace…</p><p style='font-size:13px'>First launch may take a moment.</p></body></html>", baseURL: nil)
        startServices()
    }
    func startServices() {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "PRISMProjectRoot") as? String,
              FileManager.default.isExecutableFile(atPath: root + "/start.command") else {
            fail("Project launcher not found. Run pnpm build:macos again from the project folder."); return
        }
        do {
            let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/PRISM", isDirectory: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let log = logs.appendingPathComponent("desktop.log")
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            logHandle = try FileHandle(forWritingTo: log); logHandle?.seekToEndOfFile()
            let process = Process(); process.executableURL = URL(fileURLWithPath: root + "/start.command")
            process.currentDirectoryURL = URL(fileURLWithPath: root)
            var env = ProcessInfo.processInfo.environment; env["PRISM_OPEN_BROWSER"] = "0"
            process.environment = env; process.standardOutput = logHandle; process.standardError = logHandle
            process.terminationHandler = { [weak self] process in
                if process.terminationStatus != 0 {
                    DispatchQueue.main.async { self?.fail("Services could not start. See ~/Library/Logs/PRISM/desktop.log.") }
                }
            }
            launcher = process; try process.run()
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch { fail("Unable to start services: \(error.localizedDescription)") }
    }
    func checkReady() {
        guard !checking else { return }
        attempts += 1
        if attempts > 180 { fail("Startup timed out. See ~/Library/Logs/PRISM/desktop.log."); return }
        guard let root = Bundle.main.object(forInfoDictionaryKey: "PRISMProjectRoot") as? String,
              let data = try? Data(contentsOf: URL(fileURLWithPath: root + "/.data/dev-launcher.json")),
              let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              record["root"] as? String == root, record["phase"] as? String == "ready",
              let value = record["webUrl"] as? String, let url = URL(string: value),
              url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? ""), url.port == 3000 else { return }
        address = url
        checking = true
        var request = URLRequest(url: URL(string: "/api/v1/me", relativeTo: address)!)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.failed else { return }; self.checking = false
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.timer?.invalidate(); self.timer = nil
                    self.web.load(URLRequest(url: self.address))
                }
            }
        }.resume()
    }
    func fail(_ message: String) {
        failed = true
        timer?.invalidate(); timer = nil
        let alert = NSAlert(); alert.messageText = "PRISM could not start"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.runModal()
    }
    @objc func reload() { web.reload() }
    @objc private func displayOptionsChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.syncReducedTransparency() }
    }
    private func syncReducedTransparency() {
        guard let url = web.url, url.scheme == "http", url.host == address.host, url.port == address.port else { return }
        // WebKit does not expose the macOS Reduce Transparency preference to CSS.
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        web.evaluateJavaScript("document.documentElement?.setAttribute('data-system-reduced-transparency', '\(reduced)')")
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? ""), url.port == 3000,
              let body = message.body as? [String: Any], let theme = body["theme"] as? String else { return }
        switch theme {
        case "light": window.appearance = NSAppearance(named: .aqua)
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        case "system": window.appearance = nil
        default: return
        }
        syncReducedTransparency()
    }
    @objc func openBrowser() { NSWorkspace.shared.open(address) }
    @objc func about() {
        let alert = NSAlert(); alert.messageText = "PRISM 0.2.0"
        alert.informativeText = "Personal Research, Intelligence & Self-Management\nLocal desktop app · AppKit + WebKit\nUses services and data in the current project folder."
        alert.runModal()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        timer?.invalidate()
        guard let process = launcher, process.isRunning else { return .terminateNow }
        // Only terminate the process this app started; a reused server's short-lived launcher has already exited.
        process.terminationHandler = { _ in DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) } }
        process.terminate()
        return .terminateLater
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let url = frame.request.url,
              url.scheme == "http", url.host == address.host, url.port == address.port,
              window.attachedSheet == nil else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let local = url.scheme == "http" && url.host == address.host && url.port == 3000
        let localBlob = url.absoluteString.hasPrefix("blob:http://\(address.host ?? "localhost"):3000/")
        if action.shouldPerformDownload && (local || localBlob) { decisionHandler(.download); return }
        if url.scheme == "about" || local {
            decisionHandler(.allow)
        } else {
            if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
