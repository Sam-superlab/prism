# PRISM for Mac

PRISM brings study notes, chapter review, research reading, and daily planning into one local workspace. The macOS preview is free to download and includes everything needed to run the app.

[Download PRISM 0.2.4 for Apple silicon](https://github.com/Sam-superlab/prism/releases/download/v0.2.4/PRISM-macOS-arm64.zip) · [Release notes](https://github.com/Sam-superlab/prism/releases/tag/v0.2.4) · [PRISM website](https://sam-superlab.github.io/prism/)

## Install

You need an Apple silicon Mac running macOS 13.5 or later.

1. Download and unzip `PRISM-macOS-arm64.zip`.
2. Move `PRISM.app` to **Applications**, then open it.
3. If macOS blocks the first launch and you trust the download, open **System Settings → Privacy & Security** and select **Open Anyway** if macOS offers it. Confirm the prompt to open PRISM. [Apple's first-launch instructions](https://support.apple.com/en-us/102445)

The preview has an ad-hoc macOS signature and has not been notarized by Apple. macOS decides whether the first-launch option is available.

## Getting started

The first time you open an empty workspace, the welcome guide shows how to create a note, turn it into a review card, and finish your first review. You can skip the guide and open it again from **Settings → Getting Started**. The sample stays temporary until you choose **Keep this example**.

## Updates and local data

Choose **PRISM → Check for Updates…** to look for newer builds. Sparkle verifies signatures on the update feed and ZIP. On a test Mac, the in-app upgrade from 0.2.0 to 0.2.1 relaunched PRISM and preserved a sample note, Dark appearance, and the daily review limit in an isolated workspace.

PRISM creates its workspace at `~/Library/Application Support/PRISM Desktop` on your Mac. Replacing the app in Applications leaves that workspace in place.
