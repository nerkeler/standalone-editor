import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const frontendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageLock = JSON.parse(readFileSync(path.join(frontendDirectory, 'package-lock.json'), 'utf8'));

test('locks every Rollup optional platform package with portable registry metadata', () => {
  const rollup = packageLock.packages['node_modules/rollup'];
  assert.ok(rollup, 'Rollup must be present in the lockfile');

  const platformPackages = Object.entries(rollup.optionalDependencies)
    .filter(([name]) => name.startsWith('@rollup/rollup-'));
  assert.equal(platformPackages.length, 25, 'Rollup 4.60.2 declares 25 platform packages');

  for (const [name, version] of platformPackages) {
    const node = packageLock.packages[`node_modules/${name}`];
    assert.ok(node, `lockfile node is missing for ${name}`);
    assert.equal(node.version, version, `${name} must match the declared Rollup version`);
    assert.equal(node.optional, true, `${name} must remain an optional platform package`);

    const [platform, architecture] = name.slice('@rollup/rollup-'.length).split('-', 3);
    assert.deepEqual(node.os, [platform], `${name} must lock its declared OS`);
    assert.deepEqual(node.cpu, [architecture], `${name} must lock its declared CPU`);

    const sri = node.integrity?.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
    assert.ok(sri, `${name} must have a SHA-512 integrity value`);
    assert.equal(Buffer.from(sri[1], 'base64').length, 64, `${name} must have a complete SHA-512 digest`);

    const tarballName = name.slice(name.lastIndexOf('/') + 1);
    assert.equal(
      node.resolved,
      `https://registry.npmjs.org/${name}/-/${tarballName}-${version}.tgz`,
      `${name} must resolve from the public npm registry`,
    );
  }
});
