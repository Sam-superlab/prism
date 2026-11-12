# PRISM Windows preview

Windows 10 or Windows 11, x64. Extract the entire ZIP and open `PRISM.exe`. Keep the files beside it together. The preview is unsigned.

While running, PRISM checks for updates automatically once an hour. If it was closed when a check was due, it checks after the next launch. Current-version and network-error results stay quiet. New versions prompt for download, and installation requires confirmation.

The application uses a persistent browser profile and local database under `%APPDATA%\PRISM Desktop`. Choose **File → Check for Updates…** to check the signed update manifest, download a newer release, and install it after PRISM closes. The application reopens with the same local profile and database. The updater verifies the manifest and archive with the public Ed25519 release key, and replaces only a known PRISM installation. Keep the AppData directory to retain notes and settings.

Version 0.2.5 predates the updater. Install the updater-enabled preview manually once by closing PRISM and replacing its extracted application folder, then use the File menu for later releases.

Build on macOS with Node 24 from a verified public Mac package that contains the corresponding shared API and Web build:

```sh
PRISM_WINDOWS_RELEASE_VERSION=0.2.6 node scripts/package-windows.mjs PUBLIC_MAC_ZIP OUTPUT_DIRECTORY
```

The packager derives the public update key from the verified Mac archive. The optional Windows version override supports Windows-only releases. It downloads checksum-verified Windows Electron and Node releases, materializes dependency links, and adds the Windows esbuild native executable. It copies the shared runtime, frontend, and licenses from the clean public package. It never copies the development workspace or local database.

Run the native startup and persistence check on Windows:

```powershell
./apps/windows/smoke.ps1 -Archive ./PRISM-Windows-x64.zip -WorkspaceRoot "$env:RUNNER_TEMP/prism-windows-smoke"
```

The test requires a new isolated directory. It launches the actual native app, creates synthetic data, checks appearance, closes the services gracefully, and verifies that the note, review preference, and appearance survive reopening. It uses a separate Electron profile and database.
