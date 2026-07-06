// Cross-platform build: zips the contents of src/ into extension.zip
// at the project root. Doesn't depend on a system `zip` binary, so it
// also works on Windows.

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const srcDir = path.join(__dirname, '..', 'src');
const outputPath = path.join(__dirname, '..', 'extension.zip');

if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
}

const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`extension.zip created (${archive.pointer()} bytes)`);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
// Adds the contents of src/ at the root of the zip (not the src/ folder itself),
// which is required by both the Chrome Web Store and Edge Add-ons.
archive.directory(srcDir, false);
archive.finalize();