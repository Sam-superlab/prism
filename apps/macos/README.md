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

For an isolated local preview, also set `PRISM_MACOS_LOCAL_PREVIEW_ID` to a new
8–32 character lowercase alphanumeric ID and `PRISM_MACOS_LOCAL_PREVIEW_PORT`
to an unused loopback port other than `38741`. `PRISM_MACOS_OUTPUT_DIR` can point
to a separate package directory. The resulting PRISM Literature Preview uses a
separate workspace and update checks are disabled.

## Back up an archive to WebDAV

Create a workspace export in **Settings → Export your data**, or select a ZIP you
made from a complete local backup. In the Mac menu, choose **File → Back Up
Archive to WebDAV…**. Select the archive, enter an existing HTTPS WebDAV folder,
and supply your server’s username and app password if required. **Upload ZIP**
sends only the chosen file. PRISM uses a new filename for each transfer and
requests that the server refuse overwrites. Credentials are held for this transfer
only. Your WebDAV server can read the uploaded archive. For an encrypted remote
copy, encrypt the archive before uploading.

The workspace export includes attachment metadata and can optionally include
up to 1,000 original attachment files and 64 MiB total. For a complete local backup
with original attachments, quit PRISM before copying and archiving its data
directory. The transfer supports ZIPs up to 512 MiB and requires the server to
accept WebDAV PUT with normal HTTPS certificate validation. There is no scheduled
upload, restore, or cross-device attachment sync in this feature.

## Send or retrieve an attachment copy with WebDAV

In the packaged Mac app, open a reference's **Attachments** and choose **WebDAV…**
next to the file. Select **Send copy…** or **Retrieve copy…** and enter the
existing HTTPS folder and any app password. PRISM uploads only the selected
attachment and checks the remote bytes against its SHA-256 digest. It requests
that the server refuse overwrites and checks a pre-existing copy before accepting
it. Use the same folder to retrieve a copy and choose where to save it after
verification. PDF, EPUB, and plain-text snapshots up to 32 MiB are supported.

The folder receives the attachment's bytes and a digest-based filename. Your
WebDAV server can read that copy. Credentials are held for the individual
transfer, and the local workspace remains authoritative. This manual mirror does
not synchronize the library, annotation metadata, or reading positions.

## Automatically mirror attachments to WebDAV

In the packaged Mac app, choose **File → WebDAV Attachment Sync…** to explicitly
enable automatic copies for one HTTPS folder. The server receives your personal
library's completed attachment files and digest-based names. PRISM keeps the
destination and credentials pinned together in Keychain. It remembers which
copies it has verified for that destination. Configure a WebDAV folder that
honors conditional PUT. PRISM checks for existing copies before uploading and
verifies downloaded bytes before it marks a copy complete.

The sync menu shows status and offers **Sync Now** and **Turn Off**. A completed
scan checks again in 15 minutes while PRISM is open. Temporary errors retry up to
three times before pausing. Turning sync off stops background transfers and
leaves existing remote copies available. Use the **WebDAV… → Retrieve copy…**
action on a reference to save a verified file from its known digest. This
mirrors attachment bytes. Library metadata and annotations stay in the canonical
workspace, and devices on that backend already share those records and files.

## Create and validate a local workspace backup

In the packaged Mac app, choose **File → Create Workspace Backup…** and save to
a new `.prismbackup` file. The backup includes knowledge, research, database
settings, and original attachment bytes. PRISM uses the Mac Keychain to verify
and encrypt new backups with AES-256-GCM. Keep access to that Keychain alongside
the backup. Earlier v1 backups are authenticated plaintext and can still be opened.

Use **File → Validate Workspace Backup…** to open a verified copy in an isolated
database and count knowledge items and completed attachments. Your current
workspace stays open. **File → Restore Workspace as Copy…** creates a new
`.prismworkspace` folder containing an independently opened and closed local
database. The copy has a new sync generation, and previously generated export
downloads are marked expired. Keep the recovered folder private. The archive is specific to the
bundled PGlite/PostgreSQL format and supports database snapshots up to 128 MiB.
Appearance, open tabs, macOS preferences, and generated export ZIPs are stored
outside this database.

Use **File → Open Recovered Workspace…** to open an authenticated `.prismbackup`
in a separate, temporary, read-only PRISM window. It starts isolated local services
with a fresh session and without background jobs or update checks. Close the
window to discard the temporary database. A `.prismworkspace` folder saved for
manual recovery is a separate durable copy.

To inspect a recovered directory using the packaged runtime in a separate
session, run the following commands in a terminal. Set both paths to your
actual bundle and recovered folder. This starts a separate loopback workspace
with an ephemeral token. Use a disposable browser profile if you want to open
its UI. Do not point these commands at a workspace already in use.

```sh
prism_bundle="/path/to/PRISM.app"
prism_recovered="/path/to/Recovered.prismworkspace"
prism_scratch=$(mktemp -d)
prism_token=$(openssl rand -hex 32)
PRISM_DATA_DIR="$prism_recovered" PRISM_DESKTOP_TOKEN="$prism_token" \
PRISM_DESKTOP_READY_FILE="$prism_scratch/ready" PRISM_DESKTOP_WEB_PORT=38891 \
PRISM_WORKER_ENABLED=false "$prism_bundle/Contents/MacOS/node" \
  "$prism_bundle/Contents/Resources/desktop/launch.mjs" &
prism_recovery_pid=$!
# Wait for the launcher to report readiness, then check the isolated copy.
curl --cookie "prism_desktop=$prism_token" http://127.0.0.1:38891/api/v1/knowledge-items
kill "$prism_recovery_pid"
wait "$prism_recovery_pid"
rmdir "$prism_scratch"
unset prism_token
```

To inspect a backup on another Mac, explicitly export its code with
**File → Export Backup Recovery Code…** and transfer the code separately from
the backup. On the other Mac choose **File → Open with Recovery Code…**. PRISM
asks for the code in a secure field, uses it for that read-only session, and
leaves the other Mac's backup key intact. The exported code file is itself a
secret and should be kept private. Live workspace replacement is separate.

Run the synthetic database check with
`pnpm --filter @prism/api exec vitest run ../../tests/api/local-workspace-backup.test.ts`.
