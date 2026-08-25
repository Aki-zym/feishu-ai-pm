import AppKit
import Darwin
import Foundation

final class StatusItemController: NSObject {
    private let taskBoardURL: URL
    private let statusItem: NSStatusItem
    private let shutdownItem: NSMenuItem
    private let parentPID: pid_t
    private var parentMonitor: Timer?
    private var shutdownInFlight = false

    init(taskBoardURL: URL) {
        self.taskBoardURL = taskBoardURL
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        self.shutdownItem = NSMenuItem()
        self.parentPID = getppid()
        super.init()

        if let button = statusItem.button {
            let image = NSImage(
                systemSymbolName: "checkmark.circle.fill",
                accessibilityDescription: "TooManyTasks 后台运行中"
            )
            image?.isTemplate = true
            button.image = image
            button.toolTip = "TooManyTasks 后台运行中"
        }

        let menu = NSMenu()
        let openItem = NSMenuItem(
            title: "打开任务台",
            action: #selector(openTaskBoard(_:)),
            keyEquivalent: ""
        )
        openItem.target = self
        menu.addItem(openItem)

        shutdownItem.title = "退出后台"
        shutdownItem.action = #selector(shutdownRuntime(_:))
        shutdownItem.keyEquivalent = ""
        shutdownItem.target = self
        menu.addItem(shutdownItem)
        statusItem.menu = menu

        parentMonitor = Timer.scheduledTimer(
            timeInterval: 1.0,
            target: self,
            selector: #selector(checkParentProcess(_:)),
            userInfo: nil,
            repeats: true
        )
    }

    deinit {
        parentMonitor?.invalidate()
    }

    @objc private func checkParentProcess(_ timer: Timer) {
        guard getppid() == parentPID else {
            timer.invalidate()
            NSApp.terminate(nil)
            return
        }
    }

    @objc private func openTaskBoard(_ sender: Any?) {
        NSWorkspace.shared.open(taskBoardURL)
    }

    @objc private func shutdownRuntime(_ sender: Any?) {
        guard !shutdownInFlight else { return }
        shutdownInFlight = true
        shutdownItem.isEnabled = false

        var request = URLRequest(url: taskBoardURL.appendingPathComponent("api/runtime/shutdown"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let succeeded = (response as? HTTPURLResponse)?.statusCode == 200
            OperationQueue.main.addOperation {
                guard let self else { return }
                if succeeded {
                    NSApp.terminate(nil)
                } else {
                    self.shutdownInFlight = false
                    self.shutdownItem.isEnabled = true
                }
            }
        }.resume()
    }
}

let taskBoardURLString = CommandLine.arguments.dropFirst().first ?? "http://127.0.0.1:4310"
guard let taskBoardURL = URL(string: taskBoardURLString) else {
    exit(2)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let controller = StatusItemController(taskBoardURL: taskBoardURL)
withExtendedLifetime(controller) {
    application.run()
}
