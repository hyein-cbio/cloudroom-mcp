import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayError } from './cli.mjs';

// An exclusive file also protects a thread when Pi and Devin spawn separate stdio servers.
// Crash leftovers intentionally fail closed; never steal a potentially live controller's lock.
export function createLocks(config) {
  return async function withLock(key, fn) {
    await mkdir(config.lockDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(config.serverUrl + ':' + key).digest('hex');
    const path = join(config.lockDir, hash + '.lock');
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new GatewayError('operation_locked',
        'Another operation owns this thread/request lock. Wait; do not repeat a possibly accepted prompt.',
        { lock_path: path, outcome_unknown: false });
      throw error;
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid, key, server_url: config.serverUrl, created_at: new Date().toISOString() }) + '\n');
      return await fn();
    } finally {
      // Cleanup must not replace an accepted write's result or its original error.
      // Any leftover lock still fails closed and requires manual recovery.
      await file.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
  };
}
