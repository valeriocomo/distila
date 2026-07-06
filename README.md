# Distila

Chrome extension that uses the **on-device Summarizer API** (Gemini Nano) to summarize the article on the current page, with the ability to copy the summary to the clipboard.

## Requirements

- Chrome 138+ (stable)
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
├── .github/workflows/
│   └── publish.yml             ← auto-publishes on "v*" tags
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
3. Choose summary type (key points, TL;DR, teaser, headline) and length
4. Click "Summarize article"
5. On first use, Chrome may download the Gemini Nano model (you'll see a progress %)
6. Click "Copy summary" to copy it to the clipboard

## How it works

- `popup.js` injects a function into the page (`chrome.scripting.executeScript`) that extracts the article text (`<article>`, common containers, or a fallback on `body`), using `innerText` to avoid HTML markup
- If the text is very long, the **"summary of summaries"** technique is applied: the text is split into ~3000-character chunks, each chunk is summarized individually (`tldr` type, `plain-text`, `long`), the partial summaries are concatenated and, if needed, recursively re-compressed
- The final summary is generated using the options chosen by the user (`type`, `length`, `format: markdown`)
- The Summarizer API is called directly in the popup (a document context), not in the service worker, as required by the spec
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

## Releasing a new version

The version lives in `package.json` and is kept in sync with `src/manifest.json` automatically.

```bash
npm version patch   # or minor / major
git push --follow-tags
```

What `npm version` does here:
1. Bumps the version in `package.json`
2. Runs the `version` npm lifecycle script, which calls `sync-version.js` to update `src/manifest.json` and stages the change
3. Creates a commit and a Git tag (e.g. `v1.1.0`)

Pushing the tag (`git push --follow-tags`) triggers `.github/workflows/publish.yml`.

## Automated publishing (after the first manual upload)

The `.github/workflows/publish.yml` workflow triggers on every Git tag in the `vX.Y.Z` format and publishes to **both the Chrome Web Store and Microsoft Edge Add-ons** in parallel:

1. `build` job: extracts the version from the tag, sets it in `package.json`, syncs it into `src/manifest.json` (`npm run sync-version`), builds `extension.zip` (`npm run build`), and shares it as an artifact
2. `publish-chrome` job: downloads the zip and publishes it via `chrome-webstore-upload-cli`
3. `publish-edge` job: downloads the zip and publishes it via the `wdzeng/edge-addon@v2` action (Microsoft Edge Add-ons API)

### Secrets to configure on GitHub (Settings → Secrets and variables → Actions)

**Chrome Web Store:**

| Secret | Description |
|---|---|
| `CHROME_CLIENT_ID` | OAuth Client ID (Google Cloud Console) |
| `CHROME_CLIENT_SECRET` | OAuth Client Secret |
| `CHROME_REFRESH_TOKEN` | Refresh token with `chromewebstore` scope |
| `CHROME_PUBLISHER_ID` | Publisher ID, from the account section of the Developer Dashboard |
| `CHROME_EXTENSION_ID` | Extension ID, obtained after the **first manual upload** to the Chrome Web Store |

**Microsoft Edge Add-ons:**

| Secret | Description |
|---|---|
| `EDGE_PRODUCT_ID` | Product ID, from the extension's "Edge Overview" page in Partner Center |
| `EDGE_CLIENT_ID` | Client ID, generated in Partner Center → "Publish API" page |
| `EDGE_API_KEY` | API key, generated on the same "Publish API" page — **expires every 72 days**, must be regenerated periodically |

### Mandatory prerequisite (applies to both stores)

The first publication **must** happen manually from each dashboard:
- **Chrome**: Developer Dashboard → upload zip + fill in the "Store listing" and "Privacy" tabs
- **Edge**: Partner Center → "Create new extension" + upload zip + fill in properties/listing

Only after obtaining the extension IDs will the automated workflow work for subsequent updates. `wdzeng/edge-addon` in particular **does not support creating a new extension**, only updating an existing one.

Important notes:
- Every `publish` still goes through Google/Microsoft review
- If you add new permissions to the manifest, the extension will be disabled for existing users until they re-approve it (applies to both stores)
- The Edge API key expires every 72 days: if the `publish-edge` job starts failing with authentication errors, regenerate it in Partner Center and update the `EDGE_API_KEY` secret