# PRISM macOS local desktop

This is a compiled AppKit application with a WebKit workspace, native menus, clipboard shortcuts, confirmation sheets and file-download destinations. It starts the same project's local API/Web services, or reuses the verified launcher already running for that project. No browser tab or terminal command is required when opening the installed app.

Build on macOS with Command Line Tools, Node.js 24 and pnpm 11:

```sh
pnpm build:macos
```

The build writes output/macos/PRISM.app, verifies an ad-hoc local code signature, and installs the result in ~/Applications/PRISM.app. Open it through Finder, Spotlight or Launchpad where available. It can be kept in the Dock. Quit through Cmd+Q; services owned by this app are stopped, while a reused external launcher's services are preserved.

This personal build embeds the current project path in Info.plist and requires that project, its installed dependencies and the local Node runtime to remain available. It is not yet a self-contained, notarized installer for other Macs. After moving the project, rebuild the app. Data stays in the existing project .data directory. Logs are in ~/Library/Logs/PRISM/desktop.log. The desktop window uses the existing local development Web server; production standalone packaging is a separate deliverable.

Before shipping beyond this local build, validate release service packaging, signing/notarization, native export and confirmation flows, and longer-running shutdown/recovery. The observed smoke check covers launch, real Today data, opening Quick Capture and dismissing it with Escape, without creating records.
