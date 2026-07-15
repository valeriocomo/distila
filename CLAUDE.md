# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Distila is a Chrome extension (Manifest V3) that summarizes the article on the current page using Chrome's **on-device Summarizer API** (Gemini Nano). No backend, no build tooling for the extension itself — `src/` is loaded directly as an unpacked extension. Node is only used for packaging/release scripts, not for running the extension.

## Commands

```bash
npm install        # also installs the husky commit-msg hook via "prepare"
npm run build       # zips src/ into extension.zip at project root (uses archiver, cross-platform)
npm run sync-version # copies package.json version -> src/manifest.json (runs automatically on `npm version`)
```

There is no lint or test suite in this repo.

### Manual release fallback

```bash
npm version patch   # or minor / major — also syncs src/manifest.json and stages it
git push --follow-tags
```

## Architecture

- **`src/`** is the actual extension package root (what Chrome loads via "Load unpacked" and what gets zipped for the stores) — not the repo root.
  - `manifest.json` — MV3 manifest, permissions are just `activeTab` + `scripting`.
  - `popup.html` / `popup.js` — the entire extension logic lives in the popup (no service worker/background script, no content script file). The Summarizer API is called from the popup's document context because that's required by the API spec (it can't be called from a background/service-worker context).
- **Text extraction**: `popup.js` injects `extractArticleText()` into the active tab via `chrome.scripting.executeScript`. It tries `<article>`, then common content-container selectors, then falls back to `document.body`, using `innerText` to strip markup.
- **"Summary of summaries"**: for long articles (`articleText.length > CHUNK_SIZE * 1.2`, `CHUNK_SIZE = 3000` chars), `splitIntoChunks()` breaks text into paragraph/sentence-respecting chunks, `recursiveSummaryOfSummaries()` summarizes each chunk (`tldr`/`plain-text`/`long`) and recursively re-compresses the concatenated result until it's under the threshold. Only then is the final user-facing summary generated with the user's chosen `type`/`length` and `format: markdown`.
- Everything is vanilla JS/HTML/CSS — no framework, no bundler, no TypeScript.

## Versioning & releases

- Version is tracked in `package.json` and mirrored into `src/manifest.json` by `scripts/sync-version.js` — never hand-edit the version in `manifest.json`.
- Commit messages **must** follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced locally by a husky `commit-msg` hook running commitlint (`commitlint.config.js`), and relied on by release-please to compute version bumps and the changelog. If a PR is squash-merged, the **PR title** becomes the commit on `main`, so the PR title must follow the convention too.
- Releases are driven by [release-please](https://github.com/googleapis/release-please), configured via `.release-please-config.json` / `.release-please-manifest.json`. The `release-please` GitHub workflow only runs on manual `workflow_dispatch` — never automatically on push. It must be run once to open/update the release PR, and run again after that PR is merged to actually create the git tag + GitHub Release.
- Pushing a `vX.Y.Z` tag triggers `.github/workflows/publish.yml`, which builds `extension.zip` and publishes to the Chrome Web Store (and Edge Add-ons, currently disabled via `if: false` in the workflow) in parallel, then attaches the zip to the GitHub Release.
- First publication to each store must be done manually from the respective dashboard (Chrome Web Store Developer Dashboard / Edge Partner Center) to obtain the extension/product ID before the automated workflow can update it.
