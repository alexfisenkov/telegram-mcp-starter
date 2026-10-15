import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { applyPatches } from '../tools/apply-patches.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(projectRoot, 'runtime/manifest.json'), 'utf8'));
const upstreamFixture = JSON.parse(readFileSync(join(projectRoot, 'tests/fixtures/upstream-preimages.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'telegram-runtime-patches-test-'));

assert.equal(upstreamFixture.schema, 'telegram-mcp-starter-upstream-preimages-v1');
assert.equal(upstreamFixture.source, 'npm:@overpod/mcp-telegram@1.43.1');
assert.equal(upstreamFixture.license, 'MIT');
assert.equal(upstreamFixture.licenseFile, 'runtime/LICENSE');
assert.match(upstreamFixture.provenance, /pristine package distribution files.*SHA-256/i);
assert.deepEqual(upstreamFixture.packageMetadata, {
  name: manifest.packageName,
  version: manifest.packageVersion,
  license: 'MIT',
});
assert.deepEqual(upstreamFixture.telegramAliasMetadata, {
  name: manifest.telegramDependency.packageName,
  version: manifest.telegramDependency.version,
});

const upstreamFiles = new Map(upstreamFixture.files.map((file) => [file.path, file]));
assert.equal(upstreamFiles.size, manifest.files.filter((file) => file.preimageSha256 !== null).length,
  'fixture contains every preimage file exactly once');

function makePackage(name) {
  const root = join(tempRoot, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(upstreamFixture.packageMetadata));
  const aliasDir = join(root, 'node_modules/telegram');
  mkdirSync(aliasDir, { recursive: true });
  writeFileSync(join(aliasDir, 'package.json'), JSON.stringify(upstreamFixture.telegramAliasMetadata));
  for (const file of manifest.files) {
    if (file.preimageSha256 === null) continue;
    const source = upstreamFiles.get(file.path);
    assert.ok(source, `fixture contains ${file.path}`);
    assert.equal(source.sha256, file.preimageSha256, `${file.path} fixture hash matches manifest preimage`);
    const bytes = gunzipSync(Buffer.from(source.gzipBase64, 'base64'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.preimageSha256, `${file.path} base64 bytes match manifest preimage`);
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return root;
}

try {
  const clean = makePackage('clean');
  const result = applyPatches(clean);
  assert.equal(result.applied, manifest.files.length, 'all runtime postimages apply to the pinned pristine upstream fixtures');
  assert.deepEqual(applyPatches(clean), { applied: 0, alreadyApplied: manifest.files.length, checked: false }, 'a second apply is an idempotent no-op');
  assert.equal(applyPatches(clean, { check: true }).checked, true, '--check accepts a complete postimage set');
  for (const file of manifest.files) {
    const bytes = readFileSync(join(clean, file.path));
    assert.equal(bytes.length > 0, true, `${file.path} has a postimage`);
  }

  const drift = makePackage('drift');
  const driftPath = join(drift, manifest.files.find((file) => file.preimageSha256 !== null).path);
  writeFileSync(driftPath, 'partially modified upstream file\n');
  const untouchedPath = join(drift, manifest.files.find((file) => file.preimageSha256 !== null && join(drift, file.path) !== driftPath).path);
  const untouchedBefore = readFileSync(untouchedPath);
  assert.throws(() => applyPatches(drift), /hash mismatch|unexpected content|preimage/i, 'unknown partial patch state fails closed');
  assert.deepEqual(readFileSync(untouchedPath), untouchedBefore, 'preflight failure leaves every other target untouched');

  const collision = makePackage('new-file-collision');
  const newFile = manifest.files.find((file) => file.preimageSha256 === null);
  writeFileSync(join(collision, newFile.path), 'unexpected existing file\n');
  const collisionPeer = join(collision, manifest.files.find((file) => file.preimageSha256 !== null).path);
  const collisionPeerBefore = readFileSync(collisionPeer);
  assert.throws(() => applyPatches(collision), /collision|unexpected content|hash mismatch/i, 'unexpected new-file target is rejected');
  assert.deepEqual(readFileSync(collisionPeer), collisionPeerBefore, 'new-file collision is found before any package write');

  const wrongVersion = makePackage('wrong-version');
  const pkgPath = join(wrongVersion, 'package.json');
  const wrongPkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  wrongPkg.version = '0.0.0';
  writeFileSync(pkgPath, JSON.stringify(wrongPkg));
  assert.throws(() => applyPatches(wrongVersion), /expected|found|version/i, 'a different upstream package version is rejected');

  const symlinked = makePackage('symlink-target');
  const symlinkParent = join(symlinked, 'dist/tools');
  const outside = join(tempRoot, 'outside-directory');
  mkdirSync(outside, { recursive: true });
  const outsideSentinel = join(outside, 'sentinel.txt');
  writeFileSync(outsideSentinel, 'outside remains unchanged\n');
  rmSync(symlinkParent, { recursive: true, force: true });
  symlinkSync(outside, symlinkParent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => applyPatches(symlinked), /symlink|symbolic/i, 'symlinked package directory is rejected');
  assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside remains unchanged\n', 'no write escapes the package directory');

  const cliPackage = makePackage('cli');
  const cli = (args) => spawnSync(process.execPath, [join(projectRoot, 'tools/apply-patches.mjs'), ...args], { encoding: 'utf8' });
  const applied = cli(['--package-dir', cliPackage]);
  assert.equal(applied.status, 0, `CLI apply succeeds: ${applied.stderr}`);
  const checked = cli(['--package-dir', cliPackage, '--check']);
  assert.equal(checked.status, 0, `CLI --check succeeds: ${checked.stderr}`);
  const escaped = cli(['--package-dir', join(cliPackage, '..', '..', 'outside')]);
  assert.notEqual(escaped.status, 0, 'a package path that does not resolve to the pinned package is rejected');

  const maliciousRoot = join(tempRoot, 'malicious-checkout');
  mkdirSync(join(maliciousRoot, 'tools'), { recursive: true });
  mkdirSync(join(maliciousRoot, 'runtime'), { recursive: true });
  copyFileSync(join(projectRoot, 'tools/apply-patches.mjs'), join(maliciousRoot, 'tools/apply-patches.mjs'));
  const maliciousManifest = structuredClone(manifest);
  maliciousManifest.files[0].path = 'dist/../escape.js';
  writeFileSync(join(maliciousRoot, 'runtime/manifest.json'), JSON.stringify(maliciousManifest));
  const escapeSentinel = join(tempRoot, 'escape.js');
  writeFileSync(escapeSentinel, 'outside remains unchanged\n');
  const traversal = spawnSync(process.execPath, [join(maliciousRoot, 'tools/apply-patches.mjs'), '--package-dir', cliPackage], { encoding: 'utf8' });
  assert.notEqual(traversal.status, 0, 'a traversal path injected into the manifest is rejected');
  assert.match(traversal.stderr, /unsafe path segment/i);
  assert.equal(readFileSync(escapeSentinel, 'utf8'), 'outside remains unchanged\n', 'manifest traversal cannot write outside the package');

  console.log(`OK: ${manifest.files.length} exact runtime files; preflight, idempotency, collision, drift, version, symlink/traversal, CLI apply/check`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
