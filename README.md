# PRISM

PRISM is a local workspace for mathematical notes, spaced repetition, academic research, arXiv reading, and daily planning.

[Download for Apple silicon](https://github.com/Sam-superlab/prism/releases/download/v0.2.20/PRISM-macOS-arm64.zip) · [Download for Intel Mac](https://github.com/Sam-superlab/prism/releases/download/v0.2.20/PRISM-macOS-x64.zip) · [Download for Windows](https://github.com/Sam-superlab/prism/releases/download/v0.2.20/PRISM-Windows-x64.zip) · [Release notes](https://github.com/Sam-superlab/prism/releases/tag/v0.2.20) · [Website](https://sam-superlab.github.io/prism/)

## Install

### macOS

Requires macOS 13.5 or later. Check **Apple menu → About This Mac** for your chip or processor.

1. Download and unzip `PRISM-macOS-arm64.zip` for Apple silicon or `PRISM-macOS-x64.zip` for Intel.
2. Move `PRISM.app` to **Applications**, then open it.
3. If macOS blocks the first launch and you trust the download, open **System Settings → Privacy & Security** and choose **Open Anyway** if offered. [Apple's first-launch instructions](https://support.apple.com/en-us/102445)

This free preview uses an ad-hoc signature and is not notarized by Apple. macOS decides whether first-launch approval is available.

### Windows

Requires Windows 10 or 11 (64-bit x64).

1. Download `PRISM-Windows-x64.zip`.
2. Extract the entire ZIP into a folder you can keep, then open `PRISM.exe`.
3. The preview is unsigned. If Windows shows a SmartScreen prompt, only continue if you trust this GitHub release. Your organization may restrict unsigned apps.

Windows 0.2.6 adds in-app updates. If you have 0.2.5, close PRISM and download/extract the current version once. Keep the AppData directory to retain your notes and settings.

Starting with 0.2.16, PRISM checks for updates once an hour while running on Mac and Windows. If a check was due while the app was closed, it checks when reopened. Installation requires confirmation.

From 0.2.6 onward, choose **File → Check for Updates…**, download the available update, then select **Install and Restart**. PRISM verifies signed update information and the download before replacing the application. Save open edits before installing. Keep PRISM in its own writable folder with the extracted program files together.

The updater replaces the program folder and retains the AppData workspace and browser profile. If the updated application fails to start, it attempts to restore the prior program.

#### Updating from an older Windows build with the desktop companion

If **Check for Updates…** reports extra files after the desktop companion has run, hide Pip from its right-click menu if it is visible. With PRISM open, move `resources/desktop/web/apps/web/.next/server/route-cache` from the extracted PRISM program folder to a temporary location outside it, if present. Then choose **File → Check for Updates…** again. This folder holds generated previews. The new version keeps them in memory.

You can also extract the current ZIP into a fresh folder and open `PRISM.exe`. It uses the existing `%APPDATA%\PRISM Desktop` workspace and appearance settings. Keep that AppData folder.

## Getting started

Pip helps you choose subjects and arXiv research areas by name, then opens your first round of papers. The guide is available in English, Simplified Chinese, and Japanese. Knowledge, Practice, and Research each have a short walkthrough the first time you open them. You can skip a guide and resume it from the section or **Settings → Getting Started**.

The Dashboard checklist walks through creating a note, making a review card, and completing the first review. The example stays temporary until you select **Keep this example**.

## Study and planning

- Write Markdown and LaTeX notes and organize them by subject and chapter.
- Add review cards for definitions, statements, hypotheses, or proofs.
- For Proof Recall, select **Proof** when editing a card and add ordered hints. Mark difficult steps during review to retain them in your review history.
- Dashboard shows your daily plan, time capacity, and seven days of review activity.
- Open **Workspace Graph** in the sidebar to explore links between notes, projects, research objects, and papers. Knowledge and Research also show local graphs.
- In Discover, organize Saved, Interested, and Liked papers into optional folders stored on your device. In Research, search for materials by title or narrow the results to those folders.
- Add References to a project and insert citations from the editor. With the Zotero desktop app open and its local API enabled, PRISM can read its reference metadata on the same computer.

## Updates and local data

On Mac, choose **PRISM → Check for Updates…**. Sparkle verifies signatures on the feed and download. Updating replaces the app bundle.

Workspaces are stored separately from the program. Notes, review history, and preferences remain on the same computer when you replace the app. Appearance settings stay in the app's local browser profile.

- Mac workspace — `~/Library/Application Support/PRISM Desktop`.
- Windows workspace — the PRISM Desktop folder in your Windows application-data directory.

This public repository contains the download website, update feed, and release-verification tooling. Download packages start with a fresh workspace. Personal notes, databases, exports, and API keys are excluded.
