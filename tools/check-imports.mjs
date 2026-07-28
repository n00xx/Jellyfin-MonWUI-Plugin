#!/usr/bin/env node
// Verifies that every named import across the plugin's JavaScript resolves to something the
// target module actually exports.
//
// This is how a module split goes wrong, and it is not a syntax error: the file parses fine and
// throws at runtime, in the browser, on whichever code path happens to touch it. Splitting a
// module without this check means finding out from a user.
//
// Usage: node tools/check-imports.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLIDER = path.join(ROOT, 'Resources/slider');
const RUNTIME = path.join(ROOT, 'RuntimeModules');
const SLIDER_URL = '/slider/';
const RUNTIME_URL = '/Plugins/JMSFusion/runtime/';

const toUrl = (file) =>
  file.startsWith(RUNTIME)
    ? RUNTIME_URL + path.relative(RUNTIME, file).split(path.sep).join('/')
    : SLIDER_URL + path.relative(SLIDER, file).split(path.sep).join('/');

function fromUrl(url) {
  if (url.startsWith(RUNTIME_URL)) return path.join(RUNTIME, url.slice(RUNTIME_URL.length));
  if (url.startsWith(SLIDER_URL)) return path.join(SLIDER, url.slice(SLIDER_URL.length));
  return null;
}

const resolveSpecifier = (specifier, fromFile) =>
  specifier.startsWith('.')
    ? fromUrl(new URL(specifier, `http://host${toUrl(fromFile)}`).pathname)
    : null;

function listModules(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Names a module makes available to importers. */
function exportsOf(source) {
  const names = new Set();

  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }  /  export { a } from './x'
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const clause of m[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0] ?? '').trim();
      if (exported) names.add(exported);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) names.add('default');
  // `export * from './x'` re-exports an unknown set; flag the module as opaque.
  if (/^\s*export\s*\*\s*from/m.test(source)) names.add('*');

  return names;
}

/** Named bindings a module brings in, plus the specifier each came from. */
function importsOf(source) {
  const found = [];

  for (const m of source.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/gm)) {
    const [, clause, specifier] = m;
    const braced = clause.match(/\{([\s\S]*)\}/);

    if (braced) {
      for (const entry of braced[1].split(',')) {
        const parts = entry.trim().split(/\s+as\s+/);
        const imported = (parts[0] ?? '').trim();
        const local = (parts[1] ?? parts[0] ?? '').trim();
        if (imported) found.push({ imported, local, specifier });
      }
    }

    const defaultBinding = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (defaultBinding && !defaultBinding.startsWith('*')) {
      found.push({ imported: 'default', local: defaultBinding, specifier });
    }
    if (defaultBinding.startsWith('*')) {
      found.push({ imported: '*', local: defaultBinding.replace(/\*\s*as\s*/, ''), specifier });
    }
  }

  return found;
}




const modules = [...listModules(SLIDER), ...listModules(RUNTIME)];
const exportCache = new Map();

function exportsFor(file) {
  if (!exportCache.has(file)) {
    exportCache.set(file, fs.existsSync(file) ? exportsOf(fs.readFileSync(file, 'utf8')) : null);
  }
  return exportCache.get(file);
}

const problems = [];

for (const file of modules) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);

  const imported = importsOf(source);

  for (const { imported: name, specifier } of imported) {
    const target = resolveSpecifier(specifier, file);
    if (!target) continue;

    const available = exportsFor(target);
    if (available === null) {
      problems.push(`${rel}: imports from missing module '${specifier}'`);
      continue;
    }
    if (name === '*' || available.has('*')) continue;
    if (!available.has(name)) {
      problems.push(`${rel}: '${name}' is not exported by ${path.relative(ROOT, target)}`);
    }
  }

}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`OK — checked ${modules.length} modules; all named imports resolve.`);
