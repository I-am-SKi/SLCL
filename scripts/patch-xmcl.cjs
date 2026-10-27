/*
 * Post-install patch for the @xmcl/unzip publishing bug.
 *
 * @xmcl/unzip@2.2.0 was published with `"main": "./index.ts"` (source) instead of
 * the compiled `./dist/index.js`, and with a `workspace:*` protocol dependency on
 * @xmcl/yauzl. The workspace protocol is fixed via npm `overrides` in package.json;
 * this script fixes the `main` field so `require('@xmcl/unzip')` resolves at runtime.
 *
 * Idempotent — safe to run on every install.
 */
const fs = require('fs');
const path = require('path');

const patches = [
  {
    file: 'node_modules/@xmcl/unzip/package.json',
    main: './dist/index.js',
    module: './dist/index.mjs',
  },
];

let fixed = false;

for (const p of patches) {
  const file = path.join(__dirname, '..', p.file);
  if (!fs.existsSync(file)) continue;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  if (json.main !== p.main) {
    json.main = p.main;
    changed = true;
  }
  if (p.module && json.module !== p.module) {
    json.module = p.module;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    fixed = true;
    console.log(`[patch-xmcl] patched ${p.file} -> main=${p.main}`);
  }
}

if (!fixed) {
  console.log('[patch-xmcl] nothing to patch');
}
