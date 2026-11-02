import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches } from '../tools/apply-patches.mjs';

// The regressions fake ffprobe with a shebang script, which Windows cannot execute.
if (process.platform === 'win32') {
  console.log('SKIP on Windows: the ffprobe stand-in in these regressions is POSIX-only');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const upstreamPackageDir = resolve(process.env.TELEGRAM_MCP_RUNTIME_PACKAGE_DIR ?? 'node_modules/@overpod/mcp-telegram');
const packageDir = join(dirname(upstreamPackageDir), `.telegram-mcp-starter-media-${randomUUID()}`);
cpSync(upstreamPackageDir, packageDir, { recursive: true, errorOnExist: true, force: false });
try {
  applyPatches(packageDir);
  for (const script of ['media-caption.mjs', 'replace-message-media.mjs']) {
    const result = spawnSync(process.execPath, [join(here, 'support', script), packageDir], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${script}: ${result.stdout}${result.stderr}`);
  }
  console.log('OK: media caption and same-message replacement regressions');
} finally {
  rmSync(packageDir, { recursive: true, force: true });
}
