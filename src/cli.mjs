import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { cliEnvironment } from './config.mjs';

export class GatewayError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.details = details;
  }
}

export function createCli(config) {
  const env = cliEnvironment(config);
  return function run(args, { signal, mutating = false } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new GatewayError('cancelled', 'Request cancelled before CLI launch', { outcome_unknown: false }));
        return;
      }
      const child = spawn(config.cliPath, args, {
        shell: false, env, cwd: homedir(), windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      let launched = Boolean(child.pid);
      let failure;
      function terminate(code, message) {
        failure ??= new GatewayError(code, message, {
          outcome_unknown: mutating && launched,
          guidance: mutating ? 'Do not blindly retry. Inspect the thread/queue; for spawn reuse the same request_id and identical inputs.' : undefined,
        });
        // Kill only the short-lived CLI process group, never the remote agent.
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
      const abort = () => terminate(signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
        'CLI call interrupted; a remote submission may already have happened');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => terminate('timeout', 'CLI execution timed out'), config.timeoutMs);
      child.once('spawn', () => { launched = true; });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          sizes[stream] += chunk.length;
          if (sizes[stream] > 1_048_576) terminate('output_limit', 'CLI output exceeded the 1 MiB per-stream limit');
          else chunks[stream].push(chunk);
        });
      }
      child.once('error', error => {
        failure ??= new GatewayError('cli_start_failed', 'Could not execute room-cli: ' + error.message, { outcome_unknown: launched && mutating });
      });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        const stdout = Buffer.concat(chunks.stdout).toString('utf8');
        const stderr = Buffer.concat(chunks.stderr).toString('utf8');
        if (code !== 0) {
          reject(new GatewayError('cli_failed', stderr.slice(0, 8_000) || 'room-cli exited unsuccessfully', {
            exit_code: code, signal: exitSignal, stderr_truncated: stderr.length > 8_000,
            // A failed transport can conceal a successful remote mutation. Never retry writes automatically.
            outcome_unknown: mutating,
          }));
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch {
          reject(new GatewayError('invalid_cli_json', 'room-cli did not return valid JSON', { outcome_unknown: mutating }));
        }
      });
    });
  };
}
