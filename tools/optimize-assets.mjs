#!/usr/bin/env node
// Re-encodes the plugin's oversized embedded images in place.
//
// Everything under Resources/ is embedded into the plugin assembly, so image weight is paid
// three times over: the DLL, the release zip a user downloads on every upgrade, and the server's
// resident memory. The avatar set alone was 635 PNGs at 800x800 — roughly 48 MB for images the
// UI renders as small circles.
//
// Filenames and the .png extension are preserved deliberately: the paths are hardcoded across
// the player modules, and the static file middleware derives Content-Type from the extension,
// so switching to WebP would need coordinated changes on both sides.
//
// Usage:
//   node tools/optimize-assets.mjs            # dry run: report what would change
//   node tools/optimize-assets.mjs --apply    # rewrite the files
//   node tools/optimize-assets.mjs --sample   # write before/after pairs for visual review

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const SAMPLE = process.argv.includes('--sample');
const SAMPLE_DIR = process.env.SAMPLE_DIR || path.join(ROOT, '.asset-sample');

const TARGETS = [
  { dir: 'img', maxSize: 256, label: 'plugin icon', only: ['icon.png'] },
  // Flat illustrations shipped as full-colour PNGs. Both are placeholders drawn at a fraction
  // of their stored size, and both palette-quantise cleanly, so 512 stays as the 2x buffer.
  {
    dir: 'Resources/slider/src/images',
    maxSize: 512,
    label: 'placeholders',
    only: ['defaultArt.png', 'nofoto.png'],
  },
];

async function encode(file, maxSize) {
  return sharp(file)
    .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    .png({ palette: true, quality: 82, effort: 8 })
    .toBuffer();
}

const format = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

let totalBefore = 0;
let totalAfter = 0;
let rewritten = 0;
let skipped = 0;

if (SAMPLE) fs.mkdirSync(SAMPLE_DIR, { recursive: true });

for (const { dir, maxSize, label, only } of TARGETS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) {
    console.warn(`skipping ${label}: ${dir} not found`);
    continue;
  }

  const files = (only ?? fs.readdirSync(full))
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => path.join(full, name));

  let before = 0;
  let after = 0;

  for (const file of files) {
    const originalSize = fs.statSync(file).size;
    const encoded = await encode(file, maxSize);

    before += originalSize;

    // Never make a file bigger: small or already-optimised images are left untouched.
    if (encoded.length >= originalSize) {
      after += originalSize;
      skipped++;
      continue;
    }

    after += encoded.length;
    rewritten++;

    if (SAMPLE && rewritten <= 6) {
      const base = path.basename(file, '.png');
      fs.copyFileSync(file, path.join(SAMPLE_DIR, `${base}-before.png`));
      fs.writeFileSync(path.join(SAMPLE_DIR, `${base}-after.png`), encoded);
    }

    if (APPLY) fs.writeFileSync(file, encoded);
  }

  totalBefore += before;
  totalAfter += after;
  console.log(
    `${label.padEnd(12)} ${String(files.length).padStart(4)} files  ` +
    `${format(before).padStart(9)} -> ${format(after).padStart(9)}  ` +
    `(${(before / Math.max(after, 1)).toFixed(1)}x)`
  );
}

console.log(
  `\n${APPLY ? 'rewrote' : 'would rewrite'} ${rewritten} file(s), left ${skipped} unchanged\n` +
  `total ${format(totalBefore)} -> ${format(totalAfter)}  ` +
  `(saves ${format(totalBefore - totalAfter)})`
);

if (SAMPLE) console.log(`\nbefore/after pairs written to ${path.relative(ROOT, SAMPLE_DIR)}`);
if (!APPLY && !SAMPLE) console.log('\ndry run — pass --apply to rewrite the files');
