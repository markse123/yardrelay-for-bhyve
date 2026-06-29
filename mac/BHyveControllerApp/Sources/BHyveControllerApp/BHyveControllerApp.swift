import AppKit
import Combine
import CryptoKit
import Foundation
import SwiftUI
import WebKit

@main
struct BHyveControllerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller = ServerController()
    @StateObject private var helpWindowController = HelpWindowController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(controller)
                .environmentObject(helpWindowController)
                .frame(minWidth: 1020, minHeight: 700)
                .onAppear {
                    appDelegate.controller = controller
                }
        }
        .commands {
            CommandGroup(replacing: .help) {
                Button("YardRelay Help") {
                    helpWindowController.show()
                }
                .keyboardShortcut("?", modifiers: .command)
            }

            CommandMenu("Server") {
                Button("Start Server") {
                    controller.startServer()
                }
                .disabled(!controller.canStart)

                Button("Stop Server") {
                    controller.stopServer()
                }
                .disabled(!controller.canStop)

                Button("Restart Server") {
                    controller.restartServer()
                }
                .disabled(!controller.canRestart)

                Divider()

                Button("Reload Controller") {
                    controller.reloadController()
                }
                .disabled(!controller.canReload)
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var controller: ServerController?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdownRelatedServerForExit()
    }
}

struct ContentView: View {
    @EnvironmentObject private var controller: ServerController
    @EnvironmentObject private var helpWindowController: HelpWindowController

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("YardRelay")
                    .font(.headline)
                Text(controller.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            StatusPill(mode: controller.mode)

            Spacer(minLength: 16)

            Button {
                controller.startServer()
            } label: {
                Label("Start", systemImage: "play.fill")
            }
            .disabled(!controller.canStart)

            Button {
                controller.stopServer()
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .disabled(!controller.canStop)

            Button {
                controller.restartServer()
            } label: {
                Label("Restart", systemImage: "arrow.clockwise")
            }
            .disabled(!controller.canRestart)

            Divider()
                .frame(height: 24)

            Button {
                controller.reloadController()
            } label: {
                Label("Reload", systemImage: "arrow.clockwise.circle")
            }
            .disabled(!controller.canReload)

            Button {
                helpWindowController.show()
            } label: {
                Label("Help", systemImage: "questionmark.circle")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var content: some View {
        if controller.serverReachable {
            ControllerWebView(url: controller.browserURL, reloadToken: $controller.reloadToken)
        } else {
            VStack(spacing: 14) {
                Image(systemName: "sprinkler.and.droplets")
                    .font(.system(size: 42))
                    .foregroundStyle(.secondary)
                Text("Controller server is stopped")
                    .font(.title3.weight(.semibold))
                Text(controller.projectRootDescription)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button {
                    controller.startServer()
                } label: {
                    Label("Start Server", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!controller.canStart)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(32)
        }
    }
}

@MainActor
final class HelpWindowController: NSObject, ObservableObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var windowController: NSWindowController?
    private weak var webView: WKWebView?
    private var helpIndexURL: URL?

    func show() {
        if let windowController {
            windowController.showWindow(nil)
            windowController.window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        guard let helpIndexURL = AppConfiguration.resolveHelpIndexURL() else {
            let alert = NSAlert()
            alert.messageText = "Help is unavailable"
            alert.informativeText = "The bundled user guide could not be found."
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "YardRelay Help"
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = webView
        window.center()
        window.delegate = self

        let controller = NSWindowController(window: window)
        self.windowController = controller
        self.webView = webView
        self.helpIndexURL = helpIndexURL

        webView.loadFileURL(helpIndexURL, allowingReadAccessTo: helpIndexURL.deletingLastPathComponent())
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView = nil
        helpIndexURL = nil
        windowController = nil
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        if isAllowedManualNavigation(navigationAction.request.url) {
            return .allow
        }

        if navigationAction.navigationType == .linkActivated,
           AppConfiguration.openAllowedExternalURL(navigationAction.request.url)
        {
            return .cancel
        }

        return .cancel
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        AppConfiguration.openAllowedExternalURL(navigationAction.request.url)
        return nil
    }

    private func isAllowedManualNavigation(_ candidate: URL?) -> Bool {
        guard let candidate, let helpIndexURL else {
            return false
        }
        return candidate.isFileURL && candidate.standardizedFileURL.path == helpIndexURL.standardizedFileURL.path
    }
}

struct StatusPill: View {
    let mode: ServerMode

    var body: some View {
        Text(mode.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(mode.foregroundColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(mode.backgroundColor, in: Capsule())
    }
}

struct ControllerWebView: NSViewRepresentable {
    let url: URL
    @Binding var reloadToken: UUID

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastURL != url || context.coordinator.lastReloadToken != reloadToken else {
            return
        }

        context.coordinator.lastURL = url
        context.coordinator.lastReloadToken = reloadToken
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastURL: URL?
        var lastReloadToken: UUID?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            if AppConfiguration.isControllerNavigationURL(navigationAction.request.url) {
                return .allow
            }
            if navigationAction.navigationType == .linkActivated,
               AppConfiguration.openAllowedExternalURL(navigationAction.request.url)
            {
                return .cancel
            }
            return .cancel
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            AppConfiguration.openAllowedExternalURL(navigationAction.request.url)
            return nil
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable () -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: "OK")
            present(alert, for: webView) { _ in
                completionHandler()
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            present(alert, for: webView) { response in
                completionHandler(response == .alertFirstButtonReturn)
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping @MainActor @Sendable (String?) -> Void
        ) {
            let alert = NSAlert()
            alert.messageText = prompt
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")

            let input = NSTextField(string: defaultText ?? "")
            input.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
            alert.accessoryView = input

            present(alert, for: webView) { response in
                completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
            }
        }

        private func present(
            _ alert: NSAlert,
            for webView: WKWebView,
            completion: @escaping (NSApplication.ModalResponse) -> Void
        ) {
            if let window = webView.window {
                alert.beginSheetModal(for: window) { response in
                    completion(response)
                }
                return
            }

            completion(alert.runModal())
        }
    }
}

enum ServerMode: Equatable {
    case checking
    case stopped
    case starting
    case runningManaged
    case runningExternal
    case stopping
    case error

    var label: String {
        switch self {
        case .checking:
            "Checking"
        case .stopped:
            "Stopped"
        case .starting:
            "Starting"
        case .runningManaged:
            "Running"
        case .runningExternal:
            "External"
        case .stopping:
            "Stopping"
        case .error:
            "Needs attention"
        }
    }

    var foregroundColor: Color {
        switch self {
        case .runningManaged, .runningExternal:
            Color.green
        case .starting, .checking, .stopping:
            Color.orange
        case .stopped:
            Color.secondary
        case .error:
            Color.red
        }
    }

    var backgroundColor: Color {
        foregroundColor.opacity(0.14)
    }
}

@MainActor
final class ServerController: ObservableObject {
    @Published private(set) var mode: ServerMode = .checking
    @Published private(set) var message = "Checking local server..."
    @Published private(set) var serverReachable = false
    @Published var reloadToken = UUID()

    let controllerURL = AppConfiguration.controllerURL
    let appToken = AppConfiguration.appToken
    private let projectRoot: URL?
    private let nodeExecutable: URL?
    private var managedProcess: Process?
    private var outputPipe: Pipe?
    private var monitorTask: Task<Void, Never>?

    var browserURL: URL {
        AppConfiguration.browserURL(appToken: appToken)
    }

    init() {
        projectRoot = AppConfiguration.resolveProjectRoot()
        nodeExecutable = AppConfiguration.resolveNodeExecutable()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshStatus()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    deinit {
        monitorTask?.cancel()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        if managedProcess?.isRunning == true {
            managedProcess?.terminate()
        }
    }

    var canStart: Bool {
        projectRoot != nil && nodeExecutable != nil && managedProcess == nil && !serverReachable && mode != .starting
    }

    var canStop: Bool {
        guard mode != .checking && mode != .stopping else {
            return false
        }
        return managedProcess?.isRunning == true || serverReachable
    }

    var canRestart: Bool {
        guard projectRoot != nil && nodeExecutable != nil else {
            return false
        }
        return mode != .checking && mode != .starting && mode != .stopping
    }

    var canReload: Bool {
        serverReachable
    }

    var projectRootDescription: String {
        if let projectRoot {
            return "Server root: \(projectRoot.path)"
        }
        return "Set BHYVE_CONTROLLER_ROOT to the folder containing package.json and server/app.js."
    }

    func startServer() {
        guard managedProcess == nil else {
            message = "Server is already managed by this app."
            return
        }

        guard !serverReachable else {
            mode = .runningExternal
            message = "A YardRelay server is already reachable. Use Stop to shut it down."
            return
        }

        guard let projectRoot else {
            mode = .error
            message = "Could not find the controller project root."
            return
        }

        guard let nodeExecutable else {
            mode = .error
            message = "Could not find Node.js. Set BHYVE_NODE_PATH to your node executable."
            return
        }

        let process = Process()
        process.executableURL = nodeExecutable
        process.arguments = ["server/app.js"]
        process.currentDirectoryURL = projectRoot

        var environment = AppConfiguration.sanitizedServerEnvironment(from: ProcessInfo.processInfo.environment)
        environment["HOST"] = "127.0.0.1"
        environment["PORT"] = "\(AppConfiguration.port)"
        environment["APP_TOKEN"] = appToken
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                return
            }
            Task { @MainActor in
                self?.message = text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }

        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                self?.outputPipe?.fileHandleForReading.readabilityHandler = nil
                self?.outputPipe = nil
                self?.managedProcess = nil
                self?.message = "Server exited with status \(process.terminationStatus)."
                await self?.refreshStatus()
            }
        }

        do {
            try process.run()
            managedProcess = process
            outputPipe = pipe
            mode = .starting
            message = "Starting controller server..."
            Task { [weak self] in
                await self?.waitForStartup()
            }
        } catch {
            mode = .error
            message = "Could not start server: \(error.localizedDescription)"
        }
    }

    func stopServer() {
        if let managedProcess, managedProcess.isRunning {
            mode = .stopping
            message = "Stopping controller server..."
            managedProcess.terminate()
            return
        }

        guard serverReachable else {
            return
        }

        mode = .stopping
        message = "Stopping controller server..."
        Task { [weak self, appToken] in
            let stopped = await AppConfiguration.requestControllerShutdown(appToken: appToken)
            try? await Task.sleep(nanoseconds: 500_000_000)
            await self?.refreshStatus()
            if !stopped {
                self?.mode = .error
                self?.message = "Could not stop the reachable YardRelay server."
            }
        }
    }

    func restartServer() {
        if managedProcess?.isRunning == true {
            stopServer()
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await self?.refreshStatus()
                self?.startServer()
            }
            return
        }

        if serverReachable {
            mode = .stopping
            message = "Restarting controller server..."
            Task { [weak self, appToken] in
                let stopped = await AppConfiguration.requestControllerShutdown(appToken: appToken)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await self?.refreshStatus()
                if stopped {
                    self?.startServer()
                } else {
                    self?.mode = .error
                    self?.message = "Could not stop the reachable YardRelay server."
                }
            }
            return
        }

        startServer()
    }

    func reloadController() {
        reloadToken = UUID()
    }

    func shutdownRelatedServerForExit() {
        monitorTask?.cancel()
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil

        guard let process = managedProcess else {
            return
        }

        process.terminationHandler = nil
        managedProcess = nil
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
    }

    private func waitForStartup() async {
        for _ in 0..<24 {
            if await AppConfiguration.isServerReachable(appToken: appToken) {
                await refreshStatus()
                reloadController()
                return
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        if managedProcess?.isRunning == true {
            mode = .error
            message = "Server started but did not become reachable on \(controllerURL.absoluteString)."
        }
    }

    private func refreshStatus() async {
        let reachable = await AppConfiguration.isServerReachable(appToken: appToken)
        serverReachable = reachable

        if reachable {
            if managedProcess?.isRunning == true {
                mode = .runningManaged
                message = "Server is running from this app."
            } else {
                mode = .runningExternal
                message = "YardRelay is already running outside this app. This app can stop it."
            }
            return
        }

        if managedProcess?.isRunning == true {
            mode = .starting
            message = "Waiting for controller server..."
            return
        }

        if projectRoot == nil {
            mode = .error
            message = "Could not find the controller project root."
            return
        }

        if nodeExecutable == nil {
            mode = .error
            message = "Could not find Node.js. Set BHYVE_NODE_PATH to your node executable."
            return
        }

        mode = .stopped
        message = "Server is stopped."
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        var normalized = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        normalized.append(String(repeating: "=", count: (4 - normalized.count % 4) % 4))
        self.init(base64Encoded: normalized)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum AppConfiguration {
    static let port = Int(ProcessInfo.processInfo.environment["BHYVE_CONTROLLER_PORT"] ?? "3030") ?? 3030
    static let controllerURL = URL(string: "http://127.0.0.1:\(port)")!
    static let appToken = resolveAppToken()

    private static let serviceName = "bhyve-local-controller"
    private static let protocolVersion = 1
    private static let identityPurpose = "identity"
    private static let shutdownPurpose = "shutdown"
    private static let allowedExternalHosts: Set<String> = [
        "developer.microsoft.com",
        "github.com",
        "nodejs.org",
    ]

    private struct ControllerIdentity: Decodable {
        let service: String
        let protocolVersion: Int
        let challenge: String
        let proof: String
    }

    static func sanitizedServerEnvironment(from source: [String: String]) -> [String: String] {
        let allowedKeys: Set<String> = [
            "APP_TOKEN",
            "HOME",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "MAX_JSON_BODY_BYTES",
            "MAX_SSE_BUFFER_BYTES",
            "MAX_SSE_CLIENTS",
            "ORBIT_EMAIL",
            "ORBIT_PASSWORD",
            "PATH",
            "TEMP",
            "TMP",
            "TMPDIR",
            "TRUSTED_HOSTS",
            "SSE_DRAIN_TIMEOUT_MS",
            "WRITE_ACCESS_MODE",
        ]

        var environment: [String: String] = [:]
        for (key, value) in source {
            if allowedKeys.contains(key) || key.hasPrefix("LC_") {
                environment[key] = value
            }
        }
        return environment
    }

    static func resolveHelpIndexURL() -> URL? {
        let fileManager = FileManager.default
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("Help/index.html"),
            resolveProjectRoot()?.appendingPathComponent("public/help/index.html"),
        ]

        for candidate in candidates.compactMap({ $0 }) where fileManager.fileExists(atPath: candidate.path) {
            return candidate.standardizedFileURL
        }
        return nil
    }

    @discardableResult
    static func openAllowedExternalURL(_ candidate: URL?) -> Bool {
        guard
            let candidate,
            candidate.scheme?.lowercased() == "https",
            candidate.user == nil,
            candidate.password == nil,
            let host = candidate.host?.lowercased(),
            allowedExternalHosts.contains(host)
        else {
            return false
        }

        return NSWorkspace.shared.open(candidate)
    }

    static func browserURL(appToken: String) -> URL {
        var components = URLComponents(url: controllerURL, resolvingAgainstBaseURL: false)!
        var tokenComponents = URLComponents()
        tokenComponents.queryItems = [URLQueryItem(name: "token", value: appToken)]
        components.percentEncodedFragment = tokenComponents.percentEncodedQuery
        return components.url!
    }

    static func isControllerNavigationURL(_ candidate: URL?) -> Bool {
        guard
            let candidate,
            let expected = URLComponents(url: controllerURL, resolvingAgainstBaseURL: false),
            let actual = URLComponents(url: candidate, resolvingAgainstBaseURL: false)
        else {
            return false
        }

        return actual.scheme?.lowercased() == expected.scheme?.lowercased()
            && actual.host?.lowercased() == expected.host?.lowercased()
            && actual.port == expected.port
            && actual.user == nil
            && actual.password == nil
    }

    static func isServerReachable(appToken: String = appToken) async -> Bool {
        await verifiedControllerChallenge(appToken: appToken) != nil
    }

    private static func verifiedControllerChallenge(appToken: String) async -> String? {
        let challenge = randomBytes(count: 32).base64URLEncodedString()
        var components = URLComponents(url: controllerURL.appendingPathComponent("api/identity"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        guard let url = components?.url else {
            return nil
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard
                let httpResponse = response as? HTTPURLResponse,
                httpResponse.statusCode == 200,
                httpResponse.url == url,
                data.count <= 4096,
                let identity = try? JSONDecoder().decode(ControllerIdentity.self, from: data),
                identity.service == serviceName,
                identity.protocolVersion == protocolVersion,
                identity.challenge == challenge,
                let proof = Data(base64URLEncoded: identity.proof)
            else {
                return nil
            }

            let key = SymmetricKey(data: Data(appToken.utf8))
            let message = controllerProofMessage(purpose: identityPurpose, challenge: challenge)
            return HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: message, using: key)
                ? challenge
                : nil
        } catch {
            return nil
        }
    }

    static func requestControllerShutdown(appToken: String = appToken) async -> Bool {
        guard
            let challenge = await verifiedControllerChallenge(appToken: appToken),
            let url = URL(string: "\(controllerURL.absoluteString)/api/shutdown")
        else {
            return false
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(challenge, forHTTPHeaderField: "X-Controller-Challenge")
        request.setValue(
            controllerProof(appToken: appToken, purpose: shutdownPurpose, challenge: challenge),
            forHTTPHeaderField: "X-Controller-Proof")
        request.httpBody = Data("{}".utf8)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard
                let httpResponse = response as? HTTPURLResponse,
                httpResponse.url == url
            else {
                return false
            }
            return (200..<300).contains(httpResponse.statusCode)
        } catch {
            return false
        }
    }

    private static func controllerProof(appToken: String, purpose: String, challenge: String) -> String {
        let key = SymmetricKey(data: Data(appToken.utf8))
        let code = HMAC<SHA256>.authenticationCode(
            for: controllerProofMessage(purpose: purpose, challenge: challenge),
            using: key)
        return Data(code).base64URLEncodedString()
    }

    private static func controllerProofMessage(purpose: String, challenge: String) -> Data {
        Data("\(serviceName)\n\(protocolVersion)\n\(purpose)\n\(challenge)".utf8)
    }

    private static func resolveAppToken() -> String {
        if let token = ProcessInfo.processInfo.environment["APP_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            return token
        }

        if
            let projectRoot = resolveProjectRoot(),
            let contents = try? String(contentsOf: projectRoot.appendingPathComponent(".env"), encoding: .utf8),
            let token = parseEnvValue(named: "APP_TOKEN", from: contents),
            !token.isEmpty
        {
            return token
        }

        return randomBytes(count: 32).map { String(format: "%02x", $0) }.joined()
    }

    private static func parseEnvValue(named name: String, from contents: String) -> String? {
        for rawLine in contents.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#"), let separator = line.firstIndex(of: "=") else {
                continue
            }
            let key = line[..<separator].trimmingCharacters(in: .whitespaces)
            guard key == name else {
                continue
            }
            var value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"") || value.hasPrefix("'") && value.hasSuffix("'"))
            {
                value.removeFirst()
                value.removeLast()
            }
            return value
        }
        return nil
    }

    private static func randomBytes(count: Int) -> Data {
        let key = SymmetricKey(size: .bits256)
        return key.withUnsafeBytes { Data($0.prefix(count)) }
    }

    static func resolveProjectRoot() -> URL? {
        let fileManager = FileManager.default

        if let explicitRoot = ProcessInfo.processInfo.environment["BHYVE_CONTROLLER_ROOT"] {
            let url = URL(fileURLWithPath: explicitRoot, isDirectory: true)
            if isControllerRoot(url, fileManager: fileManager) {
                return url
            }
        }

        if let bundledRoot = Bundle.main.object(forInfoDictionaryKey: "BHyveControllerRoot") as? String {
            let url = URL(fileURLWithPath: bundledRoot, isDirectory: true)
            if isControllerRoot(url, fileManager: fileManager) {
                return url
            }
        }

        let candidates = [
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true),
            Bundle.main.bundleURL,
            URL(fileURLWithPath: #filePath).deletingLastPathComponent(),
        ]

        for candidate in candidates {
            if let root = findControllerRoot(startingAt: candidate, fileManager: fileManager) {
                return root
            }
        }

        return nil
    }

    static func resolveNodeExecutable() -> URL? {
        let fileManager = FileManager.default

        if let explicitNode = ProcessInfo.processInfo.environment["BHYVE_NODE_PATH"] {
            let url = URL(fileURLWithPath: explicitNode)
            if fileManager.isExecutableFile(atPath: url.path) {
                return url
            }
        }

        if let bundledNode = Bundle.main.object(forInfoDictionaryKey: "BHyveNodePath") as? String {
            let url = URL(fileURLWithPath: bundledNode)
            if fileManager.isExecutableFile(atPath: url.path) {
                return url
            }
        }

        let home = fileManager.homeDirectoryForCurrentUser.path
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.nvm/versions/node/v24.15.0/bin/node",
        ]

        for candidate in candidates {
            if fileManager.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }

        if let nvmNode = newestNvmNode(in: URL(fileURLWithPath: "\(home)/.nvm/versions/node", isDirectory: true), fileManager: fileManager) {
            return nvmNode
        }

        return nil
    }

    private static func findControllerRoot(startingAt url: URL, fileManager: FileManager) -> URL? {
        var current = url.standardizedFileURL

        for _ in 0..<12 {
            if isControllerRoot(current, fileManager: fileManager) {
                return current
            }

            let parent = current.deletingLastPathComponent()
            if parent.path == current.path {
                return nil
            }
            current = parent
        }

        return nil
    }

    private static func isControllerRoot(_ url: URL, fileManager: FileManager) -> Bool {
        fileManager.fileExists(atPath: url.appendingPathComponent("package.json").path)
            && fileManager.fileExists(atPath: url.appendingPathComponent("server/app.js").path)
    }

    private static func newestNvmNode(in versionsURL: URL, fileManager: FileManager) -> URL? {
        guard let versions = try? fileManager.contentsOfDirectory(at: versionsURL, includingPropertiesForKeys: nil) else {
            return nil
        }

        return versions
            .map { $0.appendingPathComponent("bin/node") }
            .filter { fileManager.isExecutableFile(atPath: $0.path) }
            .sorted { $0.path > $1.path }
            .first
    }
}
