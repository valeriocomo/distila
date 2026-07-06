// Keeps src/manifest.json's "version" field in sync with package.json.
// Runs automatically via the npm "version" lifecycle script whenever you
// run `npm version patch|minor|major`.

const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const manifestPath = path.join(__dirname, '..', 'src', 'manifest.json');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

manifest.version = pkg.version;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`src/manifest.json version synced to ${pkg.version}`);