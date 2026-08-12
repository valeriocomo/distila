# Releasing Distila

Releases are automated with [release-please](https://github.com/googleapis/release-please) plus a publish workflow, but **nothing runs on push**: the release workflow is manual-trigger only, and it must be run **twice** — once to open the release PR, and once more after merging it to actually cut the release and publish.

## TL;DR

1. Merge [Conventional Commits](README.md#commit-message-convention) into `main` as normal.
2. **Run the `release-please` workflow** (Actions tab → release-please → **Run workflow**, or `gh workflow run release-please.yml`). This opens/updates a single rolling **release PR** that bumps the version in `package.json` and `src/manifest.json` and updates [`CHANGELOG.md`](CHANGELOG.md). *No tag, no release, no publishing happens on this run — that is expected.*
3. **Merge the release PR.** Again, nothing happens automatically after the merge.
4. **Run the `release-please` workflow a second time.** This run detects the merged release PR and:
   - creates the Git tag (`vX.Y.Z`) and the GitHub Release (with a categorized changelog);
   - explicitly dispatches the `publish.yml` workflow with that tag.
5. `publish.yml` builds `extension.zip`, publishes it to the Chrome Web Store, and attaches the zip to the GitHub Release.

## Why two runs, and why the explicit dispatch

- **Two runs**: release-please is stateless between runs. The first run can only compute the pending version and open/update the release PR; it's the *next* run — after that PR is merged — that sees the merge commit and turns it into a tag + GitHub Release. Since the workflow never runs automatically (it's `workflow_dispatch` only, see [`release-please.yml`](.github/workflows/release-please.yml)), both runs must be triggered by hand.
- **Explicit dispatch of `publish.yml`**: release-please creates the tag using the workflow's `GITHUB_TOKEN`, and GitHub Actions deliberately ignores events generated with that token (to prevent workflow loops). So the tag "push" **does not** trigger `publish.yml`'s `on: push: tags` trigger. That's why the second release-please run ends with an explicit `gh workflow run publish.yml -f tag=vX.Y.Z` step (guarded by `release_created == 'true'`, so it only fires on the run that actually cut a release).

## The publish workflow

[`publish.yml`](.github/workflows/publish.yml) can start in three ways:

| Trigger | When |
|---|---|
| `workflow_dispatch` from the `release-please` workflow | The normal automated path (see above) |
| Pushing a `vX.Y.Z` tag by hand | Works because a tag pushed with *your* credentials does trigger workflows (unlike release-please's) — used by the manual fallback below |
| Manual `workflow_dispatch` with the `tag` input (e.g. `v1.2.3`) | Re-running a publish for an existing tag, e.g. after a transient store API failure |

Its jobs:

1. **`build`** — checks out the tag, sets the version from the tag name into `package.json`, syncs it into `src/manifest.json` (`npm run sync-version`), builds `extension.zip` (`npm run build`), and shares it as an artifact.
2. **`publish-chrome`** — uploads and publishes the zip via `chrome-webstore-upload-cli`.
3. **`publish-edge`** — publishes to Microsoft Edge Add-ons via `wdzeng/edge-addon@v2`. **Currently disabled** (`if: false` in the workflow); remove that line to re-enable, and re-add `publish-edge` to the `release` job's `needs`.
4. **`release`** — attaches `extension.zip` to the GitHub Release that release-please created for the tag.

## Manual fallback (emergency only)

```bash
npm version patch   # or minor / major
git push --follow-tags
```

`npm version` bumps `package.json` and, via the `version` script, syncs `src/manifest.json` and stages it. The hand-pushed tag triggers `publish.yml` directly. This bypasses the release-please PR review step and the generated changelog entry — prefer the automated flow above.

## Secrets to configure on GitHub

Settings → Secrets and variables → Actions.

**Chrome Web Store:**

| Secret | Description |
|---|---|
| `CHROME_CLIENT_ID` | OAuth Client ID (Google Cloud Console) |
| `CHROME_CLIENT_SECRET` | OAuth Client Secret |
| `CHROME_REFRESH_TOKEN` | Refresh token with `chromewebstore` scope |
| `CHROME_PUBLISHER_ID` | Publisher ID, from the account section of the Developer Dashboard |
| `CHROME_EXTENSION_ID` | Extension ID, obtained after the **first manual upload** to the Chrome Web Store |

**Microsoft Edge Add-ons** (needed only once `publish-edge` is re-enabled):

| Secret | Description |
|---|---|
| `EDGE_PRODUCT_ID` | Product ID, from the extension's "Edge Overview" page in Partner Center |
| `EDGE_CLIENT_ID` | Client ID, generated in Partner Center → "Publish API" page |
| `EDGE_API_KEY` | API key, generated on the same "Publish API" page — **expires every 72 days**, must be regenerated periodically |

## Mandatory prerequisite (applies to both stores)

The first publication **must** happen manually from each dashboard:

- **Chrome**: Developer Dashboard → upload zip + fill in the "Store listing" and "Privacy" tabs
- **Edge**: Partner Center → "Create new extension" + upload zip + fill in properties/listing

Only after obtaining the extension IDs will the automated workflow work for subsequent updates. `wdzeng/edge-addon` in particular **does not support creating a new extension**, only updating an existing one.

## Notes

- Every publish still goes through Google/Microsoft review before going live.
- If you add new permissions to the manifest, the extension will be disabled for existing users until they re-approve it (applies to both stores).
- The Edge API key expires every 72 days: if the `publish-edge` job starts failing with authentication errors, regenerate it in Partner Center and update the `EDGE_API_KEY` secret.
- Configuration for release-please lives in [`.release-please-config.json`](.release-please-config.json) and [`.release-please-manifest.json`](.release-please-manifest.json). Never hand-edit the version in `src/manifest.json` — it's mirrored from `package.json` by `scripts/sync-version.js`.
