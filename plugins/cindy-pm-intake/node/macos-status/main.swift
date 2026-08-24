import AppKit

final class StatusItemController: NSObject {
    private let taskBoardURL: URL
    private let statusItem: NSStatusItem

    init(taskBoardURL: URL) {
        self.taskBoardURL = taskBoardURL
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
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
        statusItem.menu = menu
    }

    @objc private func openTaskBoard(_ sender: Any?) {
        NSWorkspace.shared.open(taskBoardURL)
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
