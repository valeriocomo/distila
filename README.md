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
│   ├── sidepanel.html          ← side panel UI (also the popup fallback)
│   ├── sidepanel.js
│   ├── common.js               ← helpers shared by the panel and the service worker
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
2. Click the extension icon (pin it to the toolbar for quick access): Distila opens in the browser's **side panel**
3. Choose summary type (key points, TL;DR), length (short, medium, long), and format (Markdown, plain text)
4. Click "Summarize article"
5. On first use, Chrome may download the on-device models — Gemini Nano, the language detector, and (for unsupported languages) the translation model for the detected pair (you'll see a progress %)
6. The summary comes back in the article's language; if the language isn't supported by the model, a notice appears and the summary is produced via translation (article → English → summary → back)
7. Click "Copy summary" to copy it to the clipboard

The panel stays open while you browse and follows the active tab:

- Each tab keeps its latest summary until the tab is closed or you summarize another page in it (navigating to another page hides it; going back shows it again)
- Distila can only read a tab after you click its icon on that tab (`activeTab`): on a tab you switched to, or after navigating to another site, the panel asks you to click the icon again
- Summaries run one at a time, in a **queue**: start as many as you like on different tabs and each waits its turn. The panel shows a queued tab's position ("Queued (#2)"), and tabs without a summary of their own show how many are waiting
- **Cancel** stops a queued or running summary. Closing a tab cancels its summary too, and summarizing another page in the same tab replaces that tab's queued or running one
- If you navigate away while a tab's summary is queued or running, it is still completed for the page it was started on (going back shows it)
- The toolbar icon shows each tab's state on a badge, with a tooltip: `…` summarizing, `#2` queued, `✓` summary ready, `!` failed
- Clicking the icon doesn't close the panel: use the panel's close button (or "Close side panel" in the icon's right-click menu)

## How it works

- Clicking the icon fires `chrome.action.onClicked`, where the service worker opens the side panel with `chrome.sidePanel.open()`. The panel is deliberately **not** opened with `setPanelBehavior({ openPanelOnActionClick: true })`: in that mode Chromium doesn't grant `activeTab`, so the panel couldn't read the page
- `sidepanel.js` injects a function into the page (`chrome.scripting.executeScript`) that extracts the article text (`<article>`, common containers, or a fallback on `body`), using `innerText` to avoid HTML markup
- The panel hands the extracted text off to the background service worker, which ensures an **offscreen document** exists and forwards the job to it — the actual summarization pipeline runs there (in `offscreen.js`), not in the panel, so it survives the panel closing or a tab switch. The Summarizer API still requires a document context (not a service worker), which is exactly what the offscreen document provides
- The article's language is detected **once per page** with the on-device **LanguageDetector API**; the result is cached per tab (`chrome.storage.session`) and dropped when the tab closes. If the detected language is supported by the model (English, Spanish, Japanese, German, French — subject to a runtime availability check), it's used as the Summarizer's `outputLanguage`
- If the language is **not** supported, a notice is shown in the panel and the **Translator API** kicks in: the article is translated to English (chunk by chunk), summarized in English, and the summary is translated back to the detected language. If the translation pair isn't available, the extension still summarizes in English and keeps the notice
- If the text is very long, the **"summary of summaries"** technique is applied: the text is split into ~3000-character chunks, each chunk is summarized individually (`tldr` type, `plain-text`, `long`), the partial summaries are concatenated and, if needed, recursively re-compressed
- The final summary is generated using the options chosen by the user (`type`, `length`, `format`)
- The offscreen document keeps a **FIFO queue** in memory and runs one job at a time (the extracted text never leaves it). Cancelling aborts the job's `AbortSignal` (passed to every `create()`/`summarize()`/`translate()`/`detect()` call) and destroys its model sessions, so the next job starts right away
- Job state (queued with its position, running with its progress, done, error) is relayed back to the service worker and stored in `chrome.storage.session`, one `job:<tabId>` key per tab (dropped when the tab closes); the panel renders the active tab's job from there and re-syncs on tab switches, navigations and `chrome.storage.onChanged`
- The service worker mirrors each tab's job on the toolbar badge (`chrome.action.setBadgeText` per tab). Chrome clears per-tab badges on every navigation, so the badge is re-applied from storage when a page loads, only while the tab shows the job's page and Distila can read it (after a round trip through another site, the badge comes back with the next click on the icon)
- On browsers without the `chrome.sidePanel` API the same page is used as the action popup (`sidepanel.html?mode=popup`, set at runtime by the service worker)
- The "Copy" button uses `navigator.clipboard.writeText()`

## Browser compatibility

The side panel itself is widely supported by Chromium browsers; the real constraint is the on-device AI (Summarizer, LanguageDetector, Translator APIs), which is essentially a Chrome feature.

| Browser | Side panel | On-device AI APIs | Status |
|---|---|---|---|
| Chrome 138+ desktop (Windows, macOS, Linux, ChromeOS on Chromebook Plus) | Yes | Yes (see [Requirements](#requirements)) | **Supported** |
| Microsoft Edge desktop | Yes, inside Edge's sidebar (the panel reloads on tab switches, [#222](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/222)) | Summarizer since Edge 138 on Phi-4-mini (Windows/macOS, capable GPU only); LanguageDetector/Translator since 148; `outputLanguage` undocumented | Untested |
| Opera / Opera GX | Since 135/136 (Sept 2026); older versions get the popup fallback | Not documented | Summaries likely unavailable |
| Brave, Vivaldi | Yes | No (Gemini Nano features disabled) | Panel opens, summarizing reports the API as unavailable |
| Arc, Edge for Android | API present but no panel is shown (the popup fallback can't detect it) | No | Not supported |
| Firefox | No (`sidebar_action` instead) | No | Not supported (would need a separate port) |
| Safari | No | No | Not supported |

Opening the panel any other way than the toolbar icon (Chrome's side panel menu, the "Open side panel" entry of the icon's menu, Edge's "Open in sidebar") doesn't grant `activeTab`: the panel then asks you to click the icon.

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