#!/usr/bin/env node
// Reports the eager (static-import) module graph reachable from the plugin's two entry points.
//
// Everything in this closure is fetched and parsed before the UI can start, so its size is the
// plugin's first-load cost. Modules reached only through dynamic import() are excluded — those
// load on demand and do not block startup.
//
// Usage:
//   node tools/import-closure.mjs            # summary
//   node tools/import-closure.mjs --verbose  # plus why each heavy module is eager
//   node tools/import-closure.mjs --json     # machine-readable, for before/after comparison

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIDER = path.join(ROOT, 'Resources/slider');
const RUNTIME = path.join(ROOT, 'RuntimeModules');

const ENTRY_POINTS = [
  path.join(SLIDER, 'main.js'),
  path.join(SLIDER, 'modules/player/main.js'),
];

// `import ... from "x"`, `import "x"`, `export ... from "x"` — the forms that load eagerly.
const STATIC_IMPORT =
  /(?:^|[\s;}])(?:import\s+[\s\S]*?\s+from\s*|import\s*|export\s+(?:\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s+from\s*)["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

// Specifiers resolve against URLs, not disk paths, and the two layouts differ: RuntimeModules/
// is served at /Plugins/JMSFusion/runtime/, three levels deep, while the slider tree is served
// at /slider/. Resolving in URL space and mapping back keeps `../../../slider/...` (from a
// runtime module) and `./modules/...` (from the slider graph) pointing at the same file.
const SLIDER_URL = '/slider/';
const RUNTIME_URL = '/Plugins/JMSFusion/runtime/';

function toUrl(file) {
  return file.startsWith(RUNTIME)
    ? RUNTIME_URL + path.relative(RUNTIME, file).split(path.sep).join('/')
    : SLIDER_URL + path.relative(SLIDER, file).split(path.sep).join('/');
}

function fromUrl(url) {
  if (url.startsWith(RUNTIME_URL)) return path.join(RUNTIME, url.slice(RUNTIME_URL.length));
  if (url.startsWith(SLIDER_URL)) return path.join(SLIDER, url.slice(SLIDER_URL.length));
  return null;
}

function resolveSpecifier(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  return fromUrl(new URL(specifier, `http://host${toUrl(fromFile)}`).pathname);
}

function scan(source, regex, fromFile) {
  const out = [];
  regex.lastIndex = 0;
  for (let m; (m = regex.exec(source)); ) {
    const resolved = resolveSpecifier(m[1], fromFile);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Breadth-first walk so `importedBy` records the shortest path from an entry point. */
function buildClosure(entryPoints) {
  const eager = new Map();
  const dynamicOnly = new Set();
  const missing = new Set();
  const queue = entryPoints.map((file) => ({ file, importer: null }));

  while (queue.length) {
    const { file, importer } = queue.shift();

    if (eager.has(file)) continue;
    if (!fs.existsSync(file)) {
      missing.add(file);
      continue;
    }

    const source = fs.readFileSync(file, 'utf8');
    eager.set(file, { size: fs.statSync(file).size, importedBy: importer });

    for (const next of scan(source, STATIC_IMPORT, file)) queue.push({ file: next, importer: file });
    for (const next of scan(source, DYNAMIC_IMPORT, file)) dynamicOnly.add(next);
  }

  for (const file of eager.keys()) dynamicOnly.delete(file);

  return { eager, dynamicOnly, missing };
}

function allModules(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allModules(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const { eager, dynamicOnly, missing } = buildClosure(ENTRY_POINTS);
const totalBytes = [...eager.values()].reduce((sum, m) => sum + m.size, 0);
const onDisk = [...allModules(SLIDER), ...allModules(RUNTIME)];
const rel = (file) => path.relative(ROOT, file);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    eagerModules: eager.size,
    eagerBytes: totalBytes,
    lazyModules: onDisk.filter((f) => !eager.has(f)).length,
    modules: [...eager.keys()].map(rel).sort(),
  }, null, 2));
} else {
  console.log(`Eager modules : ${eager.size}`);
  console.log(`Eager bytes   : ${(totalBytes / 1024).toFixed(0)} KB`);
  console.log(`Lazy modules  : ${onDisk.filter((f) => !eager.has(f)).length} of ${onDisk.length} on disk`);
  console.log(`Dynamic-only  : ${dynamicOnly.size}`);

  console.log('\nHeaviest eager modules:');
  for (const [file, meta] of [...eager].sort((a, b) => b[1].size - a[1].size).slice(0, 12)) {
    const why = meta.importedBy ? ` <- ${rel(meta.importedBy)}` : ' (entry point)';
    console.log(`  ${String((meta.size / 1024).toFixed(0)).padStart(4)} KB  ${rel(file)}${process.argv.includes('--verbose') ? why : ''}`);
  }

  if (missing.size) {
    console.log('\nUnresolved specifiers:');
    for (const file of missing) console.log(`  ${rel(file)}`);
  }
}

process.exit(0);
