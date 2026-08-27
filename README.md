# Distila

Chrome extension that uses the **on-device Summarizer API** (Gemini Nano) to summarize the article on the current page, with the ability to copy the summary to the clipboard. The article's language is detected automatically (on-device **LanguageDetector API**) and the summary is produced in that language; unsupported languages fall back to an on-device translation round-trip (**Translator API**).

## Requirements

- Chrome 138+ (stable); summaries in Spanish, Japanese, German, or French require Chrome 149+ (older versions use the translation fallback instead)
- Windows 10/11, macOS 13+, Linux, or ChromeOS on a Chromebook Plus
- At least 22 GB of free space on the Chrome profile volume (for the one-time Gemini Nano model download)
- GPU with more than 4 GB of VRAM, or CPU with 16 GB RAM and 4+ cores
- Node.js 18+ (only needed for local builds / CI, not for using the extension)

## Project structure

```
project/
├── src/                        ← extension code (package root)
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.js
│   ├── background.js           ← coordinator service worker
│   ├── offscreen.html
│   ├── offscreen.js            ← summarization pipeline (offscreen document)
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── assets/
│   ├── logo.svg                ← editable source (not packaged)
│   └── logo-512.png            ← large version for store listings
├── scripts/
│   ├── build-zip.js            ← packages src/ into extension.zip
│   └── sync-version.js         ← syncs package.json version -> manifest.json
├── package.json
├── .release-please-config.json ← release-please settings
├── .release-please-manifest.json ← release-please version tracking
├── CHANGELOG.md                ← generated automatically by release-please
├── .github/workflows/
│   ├── release-please.yml      ← opens the release PR / creates tags+releases
│   └── publish.yml             ← builds & publishes to the stores (dispatched by release-please)
├── RELEASE.md                  ← release & publishing process
└── README.md
```

## Installation (developer mode)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `src/` folder (not the project root)
5. The extension icon will appear in the toolbar

## Usage

1. Open an article/page with text
2. Click the extension icon
3. Choose summary type (key points, TL;DR), length (short, medium, long), and format (Markdown, plain text)
4. Click "Summarize article"
5. On first use, Chrome may download the on-device models — Gemini Nano, the language detector, and (for unsupported languages) the translation model for the detected pair (you'll see a progress %)
6. The summary comes back in the article's language; if the language isn't supported by the model, a notice appears and the summary is produced via translation (article → English → summary → back)
7. Click "Copy summary" to copy it to the clipboard

## How it works

- `popup.js` injects a function into the page (`chrome.scripting.executeScript`) that extracts the article text (`<article>`, common containers, or a fallback on `body`), using `innerText` to avoid HTML markup
- The popup hands the extracted text off to the background service worker, which ensures an **offscreen document** exists and forwards the job to it — the actual summarization pipeline runs there (in `offscreen.js`), not in the popup, so it survives the popup closing. The Summarizer API still requires a document context (not a service worker), which is exactly what the offscreen document provides
- The article's language is detected **once per page** with the on-device **LanguageDetector API**; the result is cached per tab (`chrome.storage.session`) and dropped when the tab closes. If the detected language is supported by the model (English, Spanish, Japanese, German, French — subject to a runtime availability check), it's used as the Summarizer's `outputLanguage`
- If the language is **not** supported, a notice is shown in the popup and the **Translator API** kicks in: the article is translated to English (chunk by chunk), summarized in English, and the summary is translated back to the detected language. If the translation pair isn't available, the extension still summarizes in English and keeps the notice
- If the text is very long, the **"summary of summaries"** technique is applied: the text is split into ~3000-character chunks, each chunk is summarized individually (`tldr` type, `plain-text`, `long`), the partial summaries are concatenated and, if needed, recursively re-compressed
- The final summary is generated using the options chosen by the user (`type`, `length`, `format`)
- Job progress/results are relayed back to the service worker and stored in `chrome.storage.session`; the popup renders from there and re-syncs on every open via `chrome.storage.onChanged`
- The "Copy" button uses `navigator.clipboard.writeText()`

## Notes

- No data leaves the device: the model runs on-device
- The model cache is shared across extensions/sites that use the same API

## Privacy policy (GitHub Pages)

The privacy policy required by both the Chrome Web Store and Microsoft Edge Add-ons lives at `docs/privacy.html` and is meant to be served via **GitHub Pages**.

### One-time setup

1. Push this repository to GitHub (if you haven't already)
2. Go to your repo → **Settings → Pages**
3. Under **Source**, select **Deploy from a branch**
4. Branch: `main` (or whichever is your default), folder: **`/docs`**
5. Click **Save**

GitHub will publish the site at:
```
https://<your-github-username>.github.io/<repo-name>/privacy.html
```
It can take a minute or two for the first deploy to go live.

### Before submitting to the stores

Open `docs/privacy.html` and replace the placeholder contact email:
```html
<a href="mailto:your-email@example.com">your-email@example.com</a>
```
with a real address you control. This is the only placeholder in the document.

### Using it in the submissions

Paste the published URL (e.g. `https://yourname.github.io/distila/privacy.html`) into:
- **Chrome Web Store**: Privacy tab → "Privacy policy URL"
- **Microsoft Edge Add-ons**: Properties page → "Privacy policy URL"



## Local build

```bash
npm install
npm run build     # creates extension.zip from src/, cross-platform (no system `zip` needed)
```

`npm run build` uses the `archiver` package under the hood, so it works the same way on Windows, macOS, and Linux.

## Commit message convention

Commits (and PR titles, if you squash-merge — see below) must follow [Conventional Commits](https://www.conventionalcommits.org/), since [release-please](RELEASE.md) parses them to decide the next version and to build the changelog:

| Prefix | Effect |
|---|---|
| `feat:` | Triggers a **minor** bump |
| `fix:` | Triggers a **patch** bump |
| `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer | Triggers a **major** bump |
| `chore:`, `ci:`, `docs:`, `refactor:`, `test:`, `style:` | No version bump, excluded from the changelog |

A `commit-msg` git hook (via `husky` + `commitlint`, installed automatically by `npm install`) rejects non-conforming commit messages locally.

**Squash-merge caveat:** if a PR is merged with GitHub's "Squash and merge", the resulting commit on `main` uses the **PR title**, not the individual commits inside it — make sure the PR title itself follows the convention above, since that's what release-please actually reads.

## Releasing & publishing

The full release process — the two-step release-please flow (open the release PR, merge it, run the workflow again to cut the tag/Release and dispatch the publish), the store publishing workflow, the required secrets, and the manual fallback — is documented in **[RELEASE.md](RELEASE.md)**.