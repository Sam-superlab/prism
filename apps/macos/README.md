# PRISM macOS local desktop

This is a compiled AppKit application with a WebKit workspace, native menus, clipboard shortcuts, confirmation sheets and file-download destinations. It starts the same project's local API/Web services, or reuses the verified launcher already running for that project. No browser tab or terminal command is required when opening the installed app.

Build on macOS with Command Line Tools, Node.js 24 and pnpm 11:

```sh
pnpm build:macos
```

The build writes output/macos/PRISM.app, verifies an ad-hoc local code signature, and installs the result in ~/Applications/PRISM.app. Open it through Finder, Spotlight or Launchpad where available. It can be kept in the Dock. Quit through Cmd+Q; services owned by this app are stopped, while a reused external launcher's services are preserved.

This personal build embeds the current project path in Info.plist and requires that project, its installed dependencies and the local Node runtime to remain available. After moving the project, rebuild the app. Data stays in the project's `.data` directory. Logs are in `~/Library/Logs/PRISM/desktop.log`.

## Personal in-app updates

On this Mac, use **PRISM → Check for Updates…** in the macOS menu bar. When a new personal build is ready, choose **Install Update** and let PRISM reopen. The update replaces the app bundle. Your workspace, notes, and appearance settings live outside that bundle and stay on this Mac.

PRISM checks for updates once an hour while open, including after launch when a check is due. Installation requires your confirmation. The personal version starts checking once its local launcher is ready.

To add Sparkle to an older personal install, quit PRISM and run `pnpm build:macos --with-updater` once from the same checkout. This creates a Sparkle signing key in the local Keychain account `prism-macos-personal`. Keep that key for future builds. The personal channel uses ad-hoc macOS signing and Sparkle signatures without an Apple Developer membership.

To make a newer app available in the menu, stage it from the same checkout with a higher build number. For example, after 0.2.2 (build 5):

```sh
pnpm build:macos --stage-update --version 0.2.3 --build 6
```

The launcher serves the signed feed and archives on `127.0.0.1:38743` while PRISM is running. Keep `.data/macos-updates` on this Mac. The private archives contain the project path. The desktop wrapper continues to use the source and dependencies in your checkout, so prepare any underlying project changes before staging the wrapper. The downloadable GitHub build has its own update channel.

## Daily AI review drafts

Select **Include this note in AI review drafts** in the Knowledge editor to include a study note. When you open Today the following day, PRISM can send excerpts from up to eight selected notes to OpenAI and show up to twelve drafts for you to edit and approve. Daily Reflection and research workspace entries stay outside this flow.

The feature is hidden and generation is disabled by default. To use promotional credits exclusively, verify that the API organization for the PRISM key has an active Pro credit grant, no purchased balance or paid billing, and Auto Recharge off. Then set `NEXT_PUBLIC_PRISM_AI_REVIEW_DRAFTS=true` and `PRISM_AI_PROMO_ONLY=true` in the project’s local `.env` and restart PRISM. Remove both settings if the organization's billing configuration changes. PRISM pauses on an API billing or quota error. After confirming that the promotional grant is available again, retry from Today. [OpenAI API credit benefits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)

## Downloadable package

Build with Node.js 24, pnpm 11 and Apple Command Line Tools on macOS 13.5 or newer.

```sh
node scripts/package-macos.mjs
```

This builds the Web and API services in a clean temporary directory and includes a checksum-verified Node.js runtime. It runs a fresh-workspace smoke test. Build with arm64 Node.js and pnpm for `output/macos/PRISM-macOS-arm64.zip`, or use x64 Node.js and run pnpm under that same x64 runtime for `output/macos/PRISM-macOS-x64.zip`. The x64 build also works on an Apple silicon build machine with Rosetta installed. Check `node -p 'process.arch'` and `pnpm exec node -p 'process.env.npm_config_user_agent'` before building.

Download the ZIP for the processor shown in **Apple menu → About This Mac**, extract it, and move `PRISM.app` to Applications. Both versions require macOS 13.5 or later. The release uses `~/Library/Application Support/PRISM Desktop` for its workspace and `~/Library/Logs/PRISM/release.log` for logs. Replacing `PRISM.app` retains the existing workspace.

Sparkle uses the public `appcast.xml` for Apple silicon and `appcast-intel.xml` for Intel. Set `PRISM_MACOS_UPDATE_FEED_URL` to the corresponding feed on `https://sam-superlab.github.io/prism/` and `PRISM_MACOS_UPDATE_PUBLIC_KEY` to the release signing key's public value when building for distribution. Stage the matching signed archive and appcast together with `scripts/sign-macos-appcast.mjs`.

The default build is an ad-hoc signed preview. For Developer ID signing and Apple notarization, set `PRISM_MACOS_SIGN_IDENTITY` to the installed Developer ID Application identity and `PRISM_MACOS_NOTARY_PROFILE` to a keychain profile previously saved with `notarytool`. `PRISM_RELEASE_VERSION` sets the numeric app version.
