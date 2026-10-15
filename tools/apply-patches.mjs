import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROOT = join(ROOT, 'runtime/files');
const MANIFEST_PATH = join(ROOT, 'runtime/manifest.json');
const LOCK_NAME = '.telegram-mcp-starter-runtime-patch.lock';
const SHA256 = /^[0-9a-f]{64}$/u;
const EXPECTED_PATHS = [
  'dist/telegram-client.js',
  'dist/telegram-helpers.js',
  'dist/telegram-client.d.ts',
  'dist/master.js',
  'dist/client.js',
  'dist/tools/messages.js',
  'dist/tools/index.js',
  'dist/ipc-protocol.js',
  'dist/tools/media.js',
  'dist/tools/stickers.js',
  'dist/tools/extras.js',
  'dist/tools/chats.js',
  'dist/tools/account.js',
  'dist/miniapp-shim.js',
  'dist/miniapp-browser.js',
  'dist/tools/miniapps.js',
  'dist/tools/miniapp-ui.js',
];
const EXPECTED_NEW_PATHS = new Set([
  'dist/miniapp-shim.js',
  'dist/miniapp-browser.js',
  'dist/tools/miniapps.js',
  'dist/tools/miniapp-ui.js',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function assertSafeRelativePath(path, label) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path)) {
    fail(`${label} must be a relative POSIX path`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} contains an unsafe path segment`);
  }
}

function assertManifest(manifest) {
  if (manifest?.schema !== 'telegram-mcp-starter-runtime-v1' ||
      manifest.packageName !== '@overpod/mcp-telegram' || manifest.packageVersion !== '1.43.1' ||
      manifest.telegramDependency?.packageName !== 'teleproto' ||
      manifest.telegramDependency?.version !== '1.229.0' || manifest.telegramDependency?.alias !== 'telegram') {
    fail('runtime manifest does not describe the pinned MCP and teleproto versions');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== EXPECTED_PATHS.length) {
    fail('runtime manifest must contain the complete 17-file allowlist');
  }
  const paths = new Set();
  for (const file of manifest.files) {
    assertSafeRelativePath(file.path, 'runtime manifest path');
    if (!EXPECTED_PATHS.includes(file.path) || paths.has(file.path)) fail(`runtime manifest path is not allowed: ${file.path}`);
    paths.add(file.path);
    const isNew = EXPECTED_NEW_PATHS.has(file.path);
    const expectedSource = isNew ? 'starter-extension' : 'upstream-postimage';
    if (file.source !== expectedSource ||
        (isNew ? file.preimageSha256 !== null : !SHA256.test(file.preimageSha256 ?? '')) ||
        !SHA256.test(file.postimageSha256 ?? '')) {
      fail(`runtime manifest hashes/source are invalid for ${file.path}`);
    }
  }
  for (const path of EXPECTED_PATHS) if (!paths.has(path)) fail(`runtime manifest is missing ${path}`);
}

const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
assertManifest(MANIFEST);

function containedPath(root, relativePath, label, { allowMissingFinal = false } = {}) {
  assertSafeRelativePath(relativePath, label);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`${label} escapes its root`);
  let cursor = root;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i += 1) {
    cursor = join(cursor, parts[i]);
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissingFinal && i === parts.length - 1) return target;
      throw new Error(`${label} is missing or unreadable: ${relativePath}`);
    }
    if (info.isSymbolicLink()) fail(`${label} contains a symlink: ${relativePath}`);
    if (i < parts.length - 1 && !info.isDirectory()) fail(`${label} parent is not a directory: ${relativePath}`);
    if (i === parts.length - 1 && !info.isFile()) fail(`${label} is not a regular file: ${relativePath}`);
  }
  return target;
}

function packageRoot(packageDir) {
  if (typeof packageDir !== 'string' || !packageDir.trim()) fail('package-dir is required');
  const requested = resolve(packageDir);
  const info = lstatSync(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) fail('package-dir must be a real package directory');
  return realpathSync(requested);
}

function verifyPackageIdentity(root) {
  const packagePath = containedPath(root, 'package.json', 'package metadata');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.name !== MANIFEST.packageName || pkg.version !== MANIFEST.packageVersion) {
    fail(`expected ${MANIFEST.packageName}@${MANIFEST.packageVersion}; found ${pkg.name ?? 'unknown'}@${pkg.version ?? 'unknown'}`);
  }
  const teleprotoPath = containedPath(root, 'node_modules/telegram/package.json', 'teleproto metadata');
  const teleproto = JSON.parse(readFileSync(teleprotoPath, 'utf8'));
  if (teleproto.name !== MANIFEST.telegramDependency.packageName || teleproto.version !== MANIFEST.telegramDependency.version) {
    fail(`expected telegram alias teleproto@${MANIFEST.telegramDependency.version}; found ${teleproto.name ?? 'unknown'}@${teleproto.version ?? 'unknown'}`);
  }
}

function readRuntimePostimage(file) {
  const sourcePath = containedPath(RUNTIME_ROOT, file.path, 'runtime source');
  const bytes = readFileSync(sourcePath);
  if (sha256(bytes) !== file.postimageSha256) fail(`runtime source hash mismatch: ${file.path}`);
  return bytes;
}

function inspectTargets(root) {
  return MANIFEST.files.map((file) => {
    const target = containedPath(root, file.path, 'package target', { allowMissingFinal: file.preimageSha256 === null });
    if (!existsSync(target)) {
      if (file.preimageSha256 !== null) fail(`expected upstream preimage is missing: ${file.path}`);
      return { file, target, state: 'missing', original: null, postimage: readRuntimePostimage(file) };
    }
    const original = readFileSync(target);
    const digest = sha256(original);
    if (digest === file.postimageSha256) {
      return { file, target, state: 'postimage', original, postimage: readRuntimePostimage(file) };
    }
    if (file.preimageSha256 !== null && digest === file.preimageSha256) {
      return { file, target, state: 'preimage', original, postimage: readRuntimePostimage(file) };
    }
    fail(`package target hash mismatch (partial patch or upstream drift): ${file.path}`);
  });
}

function atomicRestore(target, bytes) {
  const temporary = join(dirname(target), `.${randomUUID()}.rollback`);
  const fd = openSync(temporary, 'wx', 0o644);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
}

export function applyPatches(packageDir, { check = false } = {}) {
  const root = packageRoot(packageDir);
  verifyPackageIdentity(root);
  const states = inspectTargets(root);
  const pending = states.filter((entry) => entry.state !== 'postimage');
  if (check) {
    if (pending.length) fail(`runtime check failed: ${pending.length} file(s) are not at their postimage`);
    return { checked: true, alreadyApplied: states.length };
  }
  if (!pending.length) return { applied: 0, alreadyApplied: states.length, checked: false };

  const lockPath = join(root, LOCK_NAME);
  let lockFd;
  let lockAcquired = false;
  const staged = [];
  const committed = [];
  try {
    lockFd = openSync(lockPath, 'wx', 0o600);
    lockAcquired = true;
    verifyPackageIdentity(root);
    const freshStates = inspectTargets(root);
    if (freshStates.some((entry) => entry.state !== 'postimage' &&
        entry.state !== states.find((old) => old.file.path === entry.file.path)?.state)) {
      fail('package targets changed after preflight; no files were applied');
    }
    for (const entry of freshStates.filter((item) => item.state !== 'postimage')) {
      const temporary = join(dirname(entry.target), `.${randomUUID()}.runtime-tmp`);
      const fd = openSync(temporary, 'wx', 0o644);
      try {
        writeFileSync(fd, entry.postimage);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      staged.push({ ...entry, temporary });
    }
    for (const entry of staged) {
      containedPath(root, entry.file.path, 'package target', { allowMissingFinal: entry.state === 'missing' });
      const current = lstatSync(entry.target, { throwIfNoEntry: false });
      if (entry.state === 'missing' ? current !== undefined : !current?.isFile() || current.isSymbolicLink() || sha256(readFileSync(entry.target)) !== sha256(entry.original)) {
        fail(`package target changed after staging: ${entry.file.path}`);
      }
      renameSync(entry.temporary, entry.target);
      committed.push(entry);
    }
    return { applied: committed.length, alreadyApplied: states.length - pending.length, checked: false };
  } catch (error) {
    for (const entry of committed.reverse()) {
      try {
        if (entry.original === null) unlinkSync(entry.target);
        else atomicRestore(entry.target, entry.original);
      } catch {
        // Keep the original error; the target remains hash-guarded on the next run.
      }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      try { unlinkSync(entry.temporary); } catch { }
    }
    if (lockFd !== undefined) closeSync(lockFd);
    if (lockAcquired) {
      try { unlinkSync(lockPath); } catch { }
    }
  }
}

function parseArgs(args) {
  let packageDir;
  let check = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--package-dir' && args[i + 1]) packageDir = args[++i];
    else if (args[i] === '--check') check = true;
    else fail('Usage: node tools/apply-patches.mjs --package-dir <package-dir> [--check]');
  }
  if (!packageDir) fail('Usage: node tools/apply-patches.mjs --package-dir <package-dir> [--check]');
  return { packageDir, check };
}

function main() {
  const { packageDir, check } = parseArgs(process.argv.slice(2));
  const result = applyPatches(packageDir, { check });
  process.stdout.write(check
    ? `Verified ${result.alreadyApplied} runtime files at their pinned postimages.\n`
    : `Applied ${result.applied} runtime files; ${result.alreadyApplied} were already current.\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
