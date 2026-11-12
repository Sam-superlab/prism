import Cocoa
import UserNotifications
import WebKit
#if PRISM_SPARKLE
import Sparkle
#endif

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var launcher: Process?
    var logHandle: FileHandle?
    var timer: Timer?
    var attempts = 0
    var checking = false
    var address = URL(string: "http://localhost:3000/today")!
    var failed = false
    private let packaged = Bundle.main.object(forInfoDictionaryKey: "PRISMPackaged") as? Bool == true
    private var desktopToken: String?
    private var desktopReadyFile: URL?
    private let healthSession = URLSession(configuration: .ephemeral)
    private var markdownDownloads: [ObjectIdentifier: URL] = [:]
    private let focusNotificationID = "prism.focus-completion"
    private var focusReminder: FocusReminder?
    private var focusPetState: FocusState?
    private var focusPetPanel: NSPanel?
    private var focusPetWeb: WKWebView?
    private var focusPetLoaded = false
    private var focusPetHidden = false
    private var openFocusWhenReady = false
    private let focusPetOriginKey = "prism.focus-pet.origin"

    private struct FocusReminder: Equatable {
        let endsAt: Double
        let phase: String
        let sound: Bool
    }

    private struct FocusState: Encodable {
        let endsAt: Double?
        let phase: String
        let sound: Bool
        let pet: Bool
        let mood: String
        let reducedMotion: Bool

        init?(_ value: Any) {
            guard let body = value as? [String: Any],
                  let phase = body["phase"] as? String, ["focus", "break"].contains(phase),
                  let mood = body["mood"] as? String, ["ready", "running", "paused", "finished"].contains(mood),
                  let sound = body["sound"] as? Bool,
                  let pet = body["pet"] as? Bool,
                  let reducedMotion = body["reducedMotion"] as? Bool else { return nil }
            let deadline = (body["endsAt"] as? NSNumber)?.doubleValue
            let now = Date().timeIntervalSince1970 * 1000
            if mood == "running" {
                guard let deadline, deadline.isFinite,
                      deadline >= now - 60_000, deadline <= now + 86_400_000 else { return nil }
            }
            self.endsAt = mood == "running" ? deadline : nil
            self.phase = phase
            self.sound = sound
            self.pet = pet
            self.mood = mood
            self.reducedMotion = reducedMotion || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }
    }
    #if PRISM_SPARKLE
    private var updaterController: SPUStandardUpdaterController?
    #endif
    #if PRISM_UPDATE_TEST
    private let testWorkspace = Bundle.main.object(forInfoDictionaryKey: "PRISMUpdateTestWorkspace") as? String
    #endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let icon = Bundle.main.url(forResource: "AppIcon", withExtension: "icns").flatMap({ NSImage(contentsOf: $0) }) {
            NSApp.applicationIconImage = icon
        }
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About PRISM", action: #selector(about), keyEquivalent: "")
        #if PRISM_SPARKLE
        let updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        let updateItem = appMenu.addItem(withTitle: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        updateItem.target = updater
        updaterController = updater
        #endif
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(withTitle: "Quit PRISM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); menu.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        if !packaged { view.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "") }
        NSApp.mainMenu = menu
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "prismAppearance")
        configuration.userContentController.add(self, name: "prismPrint")
        configuration.userContentController.add(self, name: "prismFocus")
        UNUserNotificationCenter.current().delegate = self
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
        #if PRISM_SPARKLE
        if packaged { updaterController?.startUpdater() }
        #endif
    }
    func startServices() {
        do {
            let logs = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/PRISM", isDirectory: true)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            #if PRISM_UPDATE_TEST
            guard let testWorkspace, testWorkspace.range(of: "^[a-z0-9]{8,32}$", options: .regularExpression) != nil,
                  let webPort = Bundle.main.object(forInfoDictionaryKey: "PRISMUpdateTestWebPort") as? Int,
                  (1024...65535).contains(webPort) else { fail("The update test profile is invalid."); return }
            let log = logs.appendingPathComponent("update-test-\(testWorkspace).log")
            #else
            let webPort = 38741
            let log = logs.appendingPathComponent(packaged ? "release.log" : "desktop.log")
            #endif
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            logHandle = try FileHandle(forWritingTo: log); logHandle?.seekToEndOfFile()
            let process = Process()
            if packaged {
                guard let resources = Bundle.main.resourceURL,
                      let executable = Bundle.main.executableURL else { fail("The app bundle is incomplete."); return }
                let appSupport = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true)
                #if PRISM_UPDATE_TEST
                let dataDir = appSupport.appendingPathComponent("PRISM Desktop Update Tests", isDirectory: true)
                    .appendingPathComponent(testWorkspace, isDirectory: true)
                #else
                let dataDir = appSupport.appendingPathComponent("PRISM Desktop", isDirectory: true)
                #endif
                try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true,
                    attributes: [.posixPermissions: 0o700])
                let token = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
                desktopToken = token
                let readyFile = dataDir.appendingPathComponent(".ready-\(UUID().uuidString)")
                desktopReadyFile = readyFile
                address = URL(string: "http://127.0.0.1:\(webPort)/today")!
                process.executableURL = executable.deletingLastPathComponent().appendingPathComponent("node")
                process.arguments = [resources.appendingPathComponent("desktop/launch.mjs").path]
                process.currentDirectoryURL = resources
                process.environment = ["PRISM_DATA_DIR": dataDir.path, "PRISM_DESKTOP_TOKEN": token,
                    "PRISM_DESKTOP_WEB_PORT": String(webPort),
                    "PRISM_DESKTOP_READY_FILE": readyFile.path,
                    "PRISM_DESKTOP_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)]
            } else {
                guard let root = Bundle.main.object(forInfoDictionaryKey: "PRISMProjectRoot") as? String,
                      FileManager.default.isExecutableFile(atPath: root + "/start.command") else {
                    fail("Project launcher not found. Run pnpm build:macos again from the project folder."); return
                }
                process.executableURL = URL(fileURLWithPath: root + "/start.command")
                process.currentDirectoryURL = URL(fileURLWithPath: root)
                var env = ProcessInfo.processInfo.environment; env["PRISM_OPEN_BROWSER"] = "0"
                process.environment = env
            }
            process.standardOutput = logHandle; process.standardError = logHandle
            process.terminationHandler = { [weak self] process in
                if process.terminationStatus != 0 || self?.packaged == true {
                    DispatchQueue.main.async { self?.fail("Services could not start. See \(log.path).") }
                }
            }
            launcher = process; try process.run()
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch { fail("Unable to start services: \(error.localizedDescription)") }
    }
    func checkReady() {
        guard !checking else { return }
        attempts += 1
        if attempts > 180 { fail("Startup timed out. See ~/Library/Logs/PRISM."); return }
        if let readyFile = desktopReadyFile, !FileManager.default.fileExists(atPath: readyFile.path) { return }
        if !packaged {
            guard let root = Bundle.main.object(forInfoDictionaryKey: "PRISMProjectRoot") as? String,
                  let data = try? Data(contentsOf: URL(fileURLWithPath: root + "/.data/dev-launcher.json")),
                  let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  record["root"] as? String == root, record["phase"] as? String == "ready",
                  let value = record["webUrl"] as? String, let url = URL(string: value),
                  url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? ""), url.port == 3000 else { return }
            address = url
        }
        checking = true
        var request = URLRequest(url: URL(string: "/api/v1/me", relativeTo: address)!)
        request.timeoutInterval = 2
        if let token = desktopToken { request.setValue("prism_desktop=\(token)", forHTTPHeaderField: "Cookie") }
        healthSession.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.failed else { return }; self.checking = false
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.timer?.invalidate(); self.timer = nil
                    self.openWorkspace()
                }
            }
        }.resume()
    }
    private func openWorkspace() {
        #if PRISM_SPARKLE
        // The personal feed is served by the local launcher.
        if !packaged { updaterController?.startUpdater() }
        #endif
        let target = openFocusWhenReady ? URL(string: "/today#focus-timer", relativeTo: address)! : address
        openFocusWhenReady = false
        let request = URLRequest(url: target)
        if let token = desktopToken {
            guard let cookie = HTTPCookie(properties: [.name: "prism_desktop", .value: token,
                .domain: "127.0.0.1", .path: "/", .discard: "TRUE", .sameSitePolicy: "Strict",
                HTTPCookiePropertyKey("HttpOnly"): "TRUE"]) else { fail("Unable to open a private session."); return }
            web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                self?.web.load(request)
            }
        } else { web.load(request) }
    }
    func fail(_ message: String) {
        failed = true
        timer?.invalidate(); timer = nil
        let alert = NSAlert(); alert.messageText = "PRISM could not start"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.runModal()
    }
    @objc func reload() { web.reload() }
    @objc private func openSettings() {
        guard window.attachedSheet == nil, let url = web.url, url.scheme == "http",
              url.host == address.host, url.port == address.port else { return }
        web.evaluateJavaScript("window.dispatchEvent(new Event('prism:open-settings'))")
    }
    @objc private func displayOptionsChanged(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in self?.syncReducedTransparency() }
    }
    private func syncReducedTransparency() {
        guard let url = web.url, url.scheme == "http", url.host == address.host, url.port == address.port else { return }
        // WebKit does not expose the macOS Reduce Transparency preference to CSS.
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        web.evaluateJavaScript("document.documentElement?.setAttribute('data-system-reduced-transparency', '\(reduced)')")
    }
    private func syncFocusReminder(_ state: FocusState) {
        let center = UNUserNotificationCenter.current()
        let now = Date().timeIntervalSince1970 * 1000
        guard let endsAt = state.endsAt else {
            // The renderer and Notification Center can reach the deadline in either order.
            // Clearing a finished timer here could swallow the reminder just before it appears.
            if state.mood == "finished", (focusReminder?.endsAt ?? 0) <= now + 1000 { return }
            focusReminder = nil
            center.removePendingNotificationRequests(withIdentifiers: [focusNotificationID])
            return
        }
        let reminder = FocusReminder(endsAt: endsAt, phase: state.phase, sound: state.sound)
        if let previous = focusReminder, previous.endsAt == endsAt,
           previous.phase == state.phase, (previous == reminder || endsAt <= now + 1000) { return }
        focusReminder = reminder
        center.removePendingNotificationRequests(withIdentifiers: [focusNotificationID])
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self, granted, self.focusReminder == reminder else { return }
                let remaining = reminder.endsAt / 1000 - Date().timeIntervalSince1970
                // A permission prompt may outlast a timer. Avoid a stale alert long after it ended.
                guard remaining >= -30 else { return }
                let content = UNMutableNotificationContent()
                content.title = reminder.phase == "focus" ? "Focus complete" : "Break complete"
                content.body = reminder.phase == "focus" ? "Ready for a break?" : "Ready for your next focus session?"
                content.sound = reminder.sound ? .default : nil
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, remaining), repeats: false)
                center.add(UNNotificationRequest(identifier: self.focusNotificationID, content: content, trigger: trigger))
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        var options: UNNotificationPresentationOptions = [.banner, .list]
        if notification.request.content.sound != nil { options.insert(.sound) }
        completionHandler(options)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            if let self, response.notification.request.identifier == self.focusNotificationID,
               response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                self.openFocus()
            }
            completionHandler()
        }
    }

    private func openFocus() {
        guard let url = web?.url, url.scheme == address.scheme,
              url.host == address.host, url.port == address.port else {
            openFocusWhenReady = true
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        web.evaluateJavaScript("window.dispatchEvent(new Event('prism:open-focus'))")
    }

    private func syncFocusPet(_ state: FocusState) {
        focusPetState = state
        guard state.pet else {
            focusPetHidden = false
            rememberFocusPetPosition()
            focusPetPanel?.orderOut(nil)
            return
        }
        guard !focusPetHidden else { return }
        if focusPetPanel == nil, let url = URL(string: "/focus-pet", relativeTo: address) {
            let configuration = WKWebViewConfiguration()
            configuration.userContentController.add(self, name: "prismPet")
            let petWeb = WKWebView(frame: .zero, configuration: configuration)
            petWeb.navigationDelegate = self
            petWeb.underPageBackgroundColor = .clear
            if petWeb.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
                petWeb.setValue(false, forKey: "drawsBackground")
            }
            let size = NSSize(width: 190, height: 210)
            let frame = (window.screen ?? NSScreen.main)?.visibleFrame ?? window.frame
            var origin = NSPoint(x: frame.maxX - size.width - 22, y: frame.minY + 26)
            if let saved = UserDefaults.standard.array(forKey: focusPetOriginKey) as? [Double],
               saved.count == 2, saved.allSatisfy(\.isFinite) {
                origin = NSPoint(x: saved[0], y: saved[1])
            }
            let panel = NSPanel(contentRect: NSRect(origin: origin, size: size),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "PRISM Focus Companion"
            panel.isFloatingPanel = true
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            panel.hidesOnDeactivate = false
            panel.canHide = false
            panel.becomesKeyOnlyIfNeeded = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.appearance = window.appearance
            panel.contentView = petWeb
            focusPetWeb = petWeb
            focusPetPanel = panel
            moveFocusPet(to: origin)
            petWeb.load(URLRequest(url: url))
        }
        if focusPetLoaded {
            focusPetPanel?.orderFrontRegardless()
            publishFocusPetState()
        }
    }

    private func publishFocusPetState() {
        guard let state = focusPetState, state.pet, !focusPetHidden,
              let data = try? JSONEncoder().encode(state),
              let literal = String(data: data, encoding: .utf8) else { return }
        focusPetWeb?.evaluateJavaScript("""
            window.prismFocusState = \(literal);
            window.dispatchEvent(new CustomEvent('prism:focus-state', { detail: window.prismFocusState }));
            """)
    }

    private func moveFocusPet(to origin: NSPoint, followingPointer: Bool = false) {
        guard let panel = focusPetPanel else { return }
        let center = NSPoint(x: origin.x + panel.frame.width / 2, y: origin.y + panel.frame.height / 2)
        let anchor = followingPointer ? NSEvent.mouseLocation : center
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) })
            ?? panel.screen ?? NSScreen.main else { return }
        let frame = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(
            x: max(frame.minX, min(origin.x, frame.maxX - panel.frame.width)),
            y: max(frame.minY, min(origin.y, frame.maxY - panel.frame.height))
        ))
    }

    private func rememberFocusPetPosition() {
        guard let origin = focusPetPanel?.frame.origin else { return }
        UserDefaults.standard.set([Double(origin.x), Double(origin.y)], forKey: focusPetOriginKey)
    }

    private func receiveFocusPetAction(_ value: Any) {
        guard let body = value as? [String: Any], let action = body["action"] as? String,
              let panel = focusPetPanel else { return }
        switch action {
        case "ready":
            focusPetLoaded = true
            if focusPetState?.pet == true && !focusPetHidden { panel.orderFrontRegardless() }
            publishFocusPetState()
        case "hide":
            focusPetHidden = true
            rememberFocusPetPosition()
            panel.orderOut(nil)
            web.evaluateJavaScript("window.dispatchEvent(new Event('prism:hide-pet'))")
        case "open":
            openFocus()
        case "drag":
            guard let dx = (body["dx"] as? NSNumber)?.doubleValue,
                  let dy = (body["dy"] as? NSNumber)?.doubleValue,
                  dx.isFinite, dy.isFinite, abs(dx) <= 500, abs(dy) <= 500 else { return }
            let origin = panel.frame.origin
            moveFocusPet(to: NSPoint(x: origin.x + dx, y: origin.y - dy), followingPointer: true)
        default:
            break
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == address.host, url.port == address.port else { return }
        if message.name == "prismPet", message.webView === focusPetWeb, url.path == "/focus-pet" {
            receiveFocusPetAction(message.body)
            return
        }
        guard message.webView === web else { return }
        if message.name == "prismFocus", let state = FocusState(message.body) {
            syncFocusReminder(state)
            syncFocusPet(state)
            return
        }
        if message.name == "prismPrint" {
            guard url.path == "/knowledge/export", window.attachedSheet == nil,
                  let info = NSPrintInfo.shared.copy() as? NSPrintInfo else { return }
            info.paperSize = NSSize(width: 595.28, height: 841.89)
            info.orientation = .portrait
            let operation = web.printOperation(with: info)
            operation.showsPrintPanel = true
            operation.showsProgressPanel = true
            operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
            return
        }
        guard message.name == "prismAppearance",
              let body = message.body as? [String: Any], let theme = body["theme"] as? String else { return }
        switch theme {
        case "light": window.appearance = NSAppearance(named: .aqua)
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        case "system": window.appearance = nil
        default: return
        }
        focusPetPanel?.appearance = window.appearance
        syncReducedTransparency()
    }
    @objc func openBrowser() { NSWorkspace.shared.open(address) }
    @objc func about() {
        let alert = NSAlert(); alert.messageText = "PRISM \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")"
        alert.informativeText = "Personal Research, Intelligence & Self-Management\n" + (packaged
            ? "Stores your workspace on this Mac under Application Support."
            : "Uses services and data in the current project folder.")
        alert.runModal()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        timer?.invalidate()
        rememberFocusPetPosition()
        guard let process = launcher, process.isRunning else { return .terminateNow }
        // Only terminate the process this app started; a reused server's short-lived launcher has already exited.
        process.terminationHandler = { _ in DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) } }
        process.terminate()
        return .terminateLater
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let local = url.scheme == "http" && url.host == address.host && url.port == address.port
        if webView === focusPetWeb {
            decisionHandler(local && url.path == "/focus-pet" && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
            return
        }
        let localBlob = url.absoluteString.hasPrefix("blob:http://\(address.host ?? "localhost"):\(address.port ?? 3000)/")
        if action.shouldPerformDownload && (local || localBlob) { decisionHandler(.download); return }
        if url.scheme == "about" || local {
            decisionHandler(.allow)
        } else {
            if action.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === focusPetWeb else { return }
        focusPetLoaded = true
        guard focusPetState?.pet == true, !focusPetHidden else { return }
        focusPetPanel?.orderFrontRegardless()
        publishFocusPetState()
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
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
        let hasMarkdownExtension = (suggestedFilename as NSString).pathExtension.lowercased() == "md"
        if hasMarkdownExtension || response.mimeType?.lowercased() == "text/markdown" {
            let files = FileManager.default
            if let folder = files.urls(for: .downloadsDirectory, in: .userDomainMask).first {
                let filename = (suggestedFilename as NSString).lastPathComponent
                let stem = hasMarkdownExtension ? (filename as NSString).deletingPathExtension : filename
                let name = stem.isEmpty || stem.hasPrefix(".") ? "PRISM Knowledge" : stem
                for index in 1...1000 {
                    let suffix = index == 1 ? "" : " (\(index))"
                    let url = folder.appendingPathComponent(name + suffix + ".md", isDirectory: false)
                    if !files.fileExists(atPath: url.path) && !markdownDownloads.values.contains(url) {
                        markdownDownloads[ObjectIdentifier(download)] = url
                        completionHandler(url)
                        return
                    }
                }
            }
            reportMarkdownDownload("Could not save the Markdown file to Downloads.")
            completionHandler(nil)
            return
        }
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let url = markdownDownloads.removeValue(forKey: ObjectIdentifier(download)) {
            reportMarkdownDownload("Saved to Downloads as \(url.lastPathComponent).")
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if markdownDownloads.removeValue(forKey: ObjectIdentifier(download)) != nil {
            reportMarkdownDownload("Could not save the Markdown file to Downloads.")
        }
    }
    private func reportMarkdownDownload(_ message: String) {
        guard let data = try? JSONEncoder().encode(message), let literal = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('prism-markdown-download', { detail: \(literal) }))")
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
