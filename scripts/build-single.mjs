#!/usr/bin/env node
/**
 * Bundle the whole game into one self-contained HTML file.
 *
 *   node scripts/build-single.mjs              -> dist/orbital-rush.html
 *   node scripts/build-single.mjs --fragment   -> dist/orbital-rush.fragment.html
 *
 * The result has no external requests at all: the stylesheet is inlined and the
 * ES modules are rewritten into one inline module script with a tiny registry,
 * so the file plays by double-clicking it or by pasting it into any host that
 * only accepts a single document. The `--fragment` form omits the
 * <html>/<head>/<body> wrapper for hosts that supply their own.
 *
 * The transform only supports the import/export forms this codebase actually
 * uses (named imports, namespace imports, and `export const|function|class`),
 * and throws on anything else rather than emitting something subtly broken.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'www/src');
const ENTRY = 'main.js';

const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/;
const IMPORT_NS = /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?\s*$/;
const ANY_IMPORT = /^\s*import\b/;
const EXPORT_DECL = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
const ANY_EXPORT = /^\s*export\b/;

/** Read a module, rewrite its imports/exports, and report its dependencies. */
async function transform(id) {
  const source = await readFile(resolve(SRC, id), 'utf8');
  const deps = [];
  const exported = [];
  const out = [];

  for (const line of source.split('\n')) {
    const named = line.match(IMPORT_NAMED);
    if (named) {
      const dep = resolveId(id, named[2]);
      deps.push(dep);
      const bindings = named[1].split(',').map((s) => s.trim()).filter(Boolean).join(', ');
      out.push(`const { ${bindings} } = __req(${JSON.stringify(dep)});`);
      continue;
    }
    const ns = line.match(IMPORT_NS);
    if (ns) {
      const dep = resolveId(id, ns[2]);
      deps.push(dep);
      out.push(`const ${ns[1]} = __req(${JSON.stringify(dep)});`);
      continue;
    }
    if (ANY_IMPORT.test(line)) {
      throw new Error(`${id}: unsupported import form -> ${line.trim()}`);
    }

    const decl = line.match(EXPORT_DECL);
    if (decl) {
      exported.push(decl[1]);
      out.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (ANY_EXPORT.test(line)) {
      throw new Error(`${id}: unsupported export form -> ${line.trim()}`);
    }

    out.push(line);
  }

  if (exported.length) {
    out.push('', `Object.assign(__x, { ${exported.join(', ')} });`);
  }
  return { id, deps, exported, code: out.join('\n') };
}

function resolveId(fromId, spec) {
  if (!spec.startsWith('.')) throw new Error(`${fromId}: bare specifier "${spec}" cannot be bundled`);
  return posix.normalize(posix.join(posix.dirname(fromId), spec));
}

/** Depth-first walk from the entry, emitting dependencies before dependants. */
async function collect() {
  const modules = new Map();
  const order = [];
  const visiting = new Set();

  async function visit(id) {
    if (modules.has(id)) return;
    if (visiting.has(id)) throw new Error(`circular import involving ${id}`);
    visiting.add(id);
    const mod = await transform(id);
    for (const dep of mod.deps) await visit(dep);
    visiting.delete(id);
    modules.set(id, mod);
    order.push(mod);
  }

  await visit(ENTRY);
  return order;
}

function buildScript(order) {
  const bodies = order.map((m) => `  ${JSON.stringify(m.id)}: (__x, __req) => {\n${indent(m.code)}\n  },`);
  return `globalThis.__ORBITAL_SINGLE_FILE__ = true;

// --- module registry ---------------------------------------------------------
// Each source file becomes a factory; __req evaluates it once and memoises its
// exports. Modules are listed dependency-first, so nothing is ever required
// before it has run.
const __factories = {
${bodies.join('\n')}
};
const __cache = {};
function __req(id) {
  if (!(id in __cache)) {
    const exports = {};
    __cache[id] = exports;
    __factories[id](exports, __req);
  }
  return __cache[id];
}
__req(${JSON.stringify(ENTRY)});
`;
}

const indent = (code) => code.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');

async function main() {
  const fragment = process.argv.includes('--fragment');
  const order = await collect();
  const css = await readFile(resolve(ROOT, 'www/styles/main.css'), 'utf8');
  const html = await readFile(resolve(ROOT, 'www/index.html'), 'utf8');

  const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
  if (!bodyMatch) throw new Error('could not find <body> in www/index.html');
  const body = bodyMatch[1]
    .replace(/\s*<script type="module"[^>]*><\/script>/, '')
    .trim();

  const head = [
    '<title>Orbital Rush</title>',
    `<style>\n${css.trim()}\n</style>`,
  ].join('\n');

  const script = `<script type="module">\n${buildScript(order)}\n</script>`;

  const doc = fragment
    ? `${head}\n\n${body}\n\n${script}\n`
    : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="description" content="One thumb. One orbit. Tap to reverse and thread the gaps in an endless neon galaxy." />
<meta name="theme-color" content="#05121f" />
<meta name="color-scheme" content="dark" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Orbital Rush" />
<meta name="format-detection" content="telephone=no" />
${head}
</head>
<body>
${body}
${script}
</body>
</html>
`;

  const outDir = resolve(ROOT, 'dist');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, fragment ? 'orbital-rush.fragment.html' : 'orbital-rush.html');
  await writeFile(outFile, doc);

  const kb = (Buffer.byteLength(doc) / 1024).toFixed(0);
  console.log(`${relative(ROOT, outFile)}  ${kb} KB  (${order.length} modules)`);
  console.log(order.map((m) => `  ${m.id}`).join('\n'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
