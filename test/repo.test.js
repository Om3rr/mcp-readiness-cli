import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|mjs|md|yml|json|txt)$/.test(name) || name === 'LICENSE') acc.push(p);
  }
  return acc;
}

test('package.json is ready to publish but is not published from CI', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'mcp-readiness-cli');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.bin['mcp-readiness-cli']);
  assert.ok(pkg.bin['mcp-readiness']);
  assert.ok(pkg.files.includes('bin') && pkg.files.includes('src'));
  assert.equal(pkg.repository.url, 'git+https://github.com/Om3rr/mcp-readiness-cli.git');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm pack --dry-run/);
  assert.doesNotMatch(ci, /npm publish(?! )/);
  assert.doesNotMatch(ci, /npm publish\b/);
});

test('repo text has no product prices', () => {
  const files = walk(root).filter((f) => !f.includes(`${root}/test/`));
  const hits = [];
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    // Product prices such as 19/29/79/99 USD or a "/mo" amount, not regex $1 groups.
    if (/\$(?:19|29|79|99)(?:\/mo)?\b/.test(t) || /\$\d+(?:\.\d+)?\s*\/\s*mo/.test(t) || /\bpay-per-scan\b/i.test(t)) hits.push(f.replace(root + '/', ''));
  }
  assert.deepEqual(hits, [], `prices found in ${hits.join(', ')}`);
});
