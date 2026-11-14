// Run after `next build`, before `pnpm prune --prod` (Dockerfile). Fails the image build when the
// compiled server code requires a package at run time that the production image will not have:
// one that resolves now only because it is a dev dependency. On 14 Nov a bundled library left
// require('postcss') behind; local runs and every test passed, production crashed on Tasks.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, process.argv[2] ?? '.next/server');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const prod = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set(builtinModules);

const names = new Map(); // package name -> first file that requires it
function walk(d) {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      for (const m of readFileSync(p, 'utf8').matchAll(/require\(\s*["']([^"'./][^"']*)["']\s*\)/g)) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!builtins.has(name) && !names.has(name)) names.set(name, path.relative(root, p));
      }
    }
  }
}
walk(dir);

// The prune removes exactly the dev dependencies. Anything else that is not a dependency is an
// optional require inside a library (Next tries @opentelemetry/api, for one) and is absent in dev too.
const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
const bad = [...names].filter(([name]) => dev.has(name) && !prod.has(name)).map(([name, file]) => `${name} (required by ${file})`);
if (bad.length) {
  console.error('Server code requires packages that `pnpm prune --prod` removes:\n  ' + bad.join('\n  ') +
    '\nAdd the library that pulls it in to serverExternalPackages in next.config.mjs, or make it a dependency.');
  process.exit(1);
}
console.log(`server requires ok (${names.size} external packages checked)`);
