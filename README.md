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
├── .release-please-config.json ← release-please settings
├── .release-please-manifest.json ← release-please version tracking
├── CHANGELOG.md                ← generated automatically by release-please
├── .github/workflows/
│   ├── release-please.yml      ← opens the release PR / creates tags+releases
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

## Commit message convention

Commits (and PR titles, if you squash-merge — see below) must follow [Conventional Commits](https://www.conventionalcommits.org/), since [release-please](#releasing-a-new-version) parses them to decide the next version and to build the changelog:

| Prefix | Effect |
|---|---|
| `feat:` | Triggers a **minor** bump |
| `fix:` | Triggers a **patch** bump |
| `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer | Triggers a **major** bump |
| `chore:`, `ci:`, `docs:`, `refactor:`, `test:`, `style:` | No version bump, excluded from the changelog |

A `commit-msg` git hook (via `husky` + `commitlint`, installed automatically by `npm install`) rejects non-conforming commit messages locally.

**Squash-merge caveat:** if a PR is merged with GitHub's "Squash and merge", the resulting commit on `main` uses the **PR title**, not the individual commits inside it — make sure the PR title itself follows the convention above, since that's what release-please actually reads.

## Releasing a new version

Releases are managed with [release-please](https://github.com/googleapis/release-please). The [`release-please`](.github/workflows/release-please.yml) workflow only runs on manual trigger (`workflow_dispatch`) — it never fires automatically on push:

1. Merge Conventional Commits into `main` as normal.
2. Manually run the `release-please` workflow (Actions tab → **Run workflow**, or `gh workflow run release-please.yml`). This opens/updates a single rolling "release PR" that bumps the version in `package.json` and `src/manifest.json` and updates [`CHANGELOG.md`](CHANGELOG.md).
3. Merge that PR, then **run the `release-please` workflow manually a second time** — this is what makes release-please detect the merge and create the Git tag (`vX.Y.Z`) **and** the GitHub Release (with a categorized changelog). Nothing happens automatically after the merge until you trigger it.
4. The tag push triggers `.github/workflows/publish.yml` exactly as described below, which builds the zip and attaches it to the Release that release-please just created.

Configuration lives in [`.release-please-config.json`](.release-please-config.json) and [`.release-please-manifest.json`](.release-please-manifest.json).

### Manual fallback (emergency only)

```bash
npm version patch   # or minor / major
git push --follow-tags
```

This still works (`sync-version.js` keeps `src/manifest.json` in sync as before), but bypasses the release-please PR review step and the generated changelog entry — prefer the automated flow above.

## Automated publishing

The `.github/workflows/publish.yml` workflow triggers on every Git tag in the `vX.Y.Z` format (created above by release-please, or manually as a fallback) and publishes to **both the Chrome Web Store and Microsoft Edge Add-ons** in parallel:

1. `build` job: extracts the version from the tag, sets it in `package.json`, syncs it into `src/manifest.json` (`npm run sync-version`), builds `extension.zip` (`npm run build`), and shares it as an artifact
2. `publish-chrome` job: downloads the zip and publishes it via `chrome-webstore-upload-cli`
3. `publish-edge` job: downloads the zip and publishes it via the `wdzeng/edge-addon@v2` action (Microsoft Edge Add-ons API)
4. `release` job: downloads the zip and attaches it to the GitHub Release that release-please already created for this tag

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