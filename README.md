# PRISM

PRISM is a local workspace for mathematical notes, spaced repetition, academic research, arXiv reading, and daily planning.

[Download for Mac](https://github.com/Sam-superlab/prism/releases/download/v0.2.17/PRISM-macOS-arm64.zip) · [Download for Windows](https://github.com/Sam-superlab/prism/releases/download/v0.2.17/PRISM-Windows-x64.zip) · [Release notes](https://github.com/Sam-superlab/prism/releases/tag/v0.2.17) · [Website](https://sam-superlab.github.io/prism/)

## Install

### macOS

Requires an Apple silicon Mac running macOS 13.5 or later.

1. Download and unzip `PRISM-macOS-arm64.zip`.
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

## Getting started

New empty workspaces show an English welcome guide. The Today checklist walks through creating a note, making a review card, and completing the first review. Skip it any time and reopen it from **Settings → Getting Started**.

The example stays temporary until you select **Keep this example**.

## Study and planning

- Write Markdown and LaTeX notes and organize them by subject and chapter.
- Add review cards for definitions, statements, hypotheses, or proofs.
- For Proof Recall, select **Proof** when editing a card and add ordered hints. Mark difficult steps during review to retain them in your review history.
- Today shows plan progress, time capacity, and seven days of review activity.
- Use the top navigation links to return to Today or the current section.

## Updates and local data

On Mac, choose **PRISM → Check for Updates…**. Sparkle verifies signatures on the feed and download. Updating replaces the app bundle.

Workspaces are stored separately from the program. Notes, review history, and preferences remain on the same computer when you replace the app. Appearance settings stay in the app's local browser profile.

- Mac workspace — `~/Library/Application Support/PRISM Desktop`.
- Windows workspace — the PRISM Desktop folder in your Windows application-data directory.

This public repository contains the download website, update feed, and release-verification tooling. Download packages start with a fresh workspace. Personal notes, databases, exports, and API keys are excluded.
