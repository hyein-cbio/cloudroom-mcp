import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCli } from '../src/cli.mjs';
import { tempConfig } from './helpers.mjs';

const fixture = fileURLToPath(new URL('./fixtures/room-cli.mjs', import.meta.url));
await chmod(fixture, 0o755);

test('CLI runner executes argv without a shell and strips inherited controller context', async t => {
  const config = await tempConfig(t, { CLOUDROOM_CLI_PATH: fixture });
  const old = { ROOM_CLI: process.env.ROOM_CLI, ROOM_THREAD_ID: process.env.ROOM_THREAD_ID };
  process.env.ROOM_CLI = '/do/not/run';
  process.env.ROOM_THREAD_ID = 'thr_controller';
  const run = createCli(config);
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const prompt = '; $(touch /tmp/cloudroom-mcp-should-not-exist) \n --help';
  const result = await run(['test_echo', prompt]);
  assert.deepEqual(result.args, ['test_echo', prompt]);
  assert.deepEqual(result.env, { ROOM_SERVER_URL: 'http://127.0.0.1:39886' });
});

test('nonzero exits, malformed JSON and oversized output are explicit errors', async t => {
  const run = createCli(await tempConfig(t, { CLOUDROOM_CLI_PATH: fixture }));
  await assert.rejects(run(['test_failure'], { mutating: true }), error =>
    error.code === 'cli_failed' && error.details.exit_code === 7 && error.details.outcome_unknown);
  await assert.rejects(run(['test_bad_json']), { code: 'invalid_cli_json' });
  await assert.rejects(run(['test_big_output']), { code: 'output_limit' });
});

test('timeouts and cancellation terminate only the CLI and flag ambiguous writes', async t => {
  const run = createCli(await tempConfig(t, { CLOUDROOM_CLI_PATH: fixture, CLOUDROOM_TIMEOUT_MS: '150' }));
  await assert.rejects(run(['test_hang'], { mutating: true }), error =>
    error.code === 'timeout' && error.details.outcome_unknown);
  const controller = new AbortController();
  const pending = run(['test_hang'], { signal: controller.signal, mutating: true });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { code: 'cancelled' });
  await assert.rejects(run(['test_echo'], { signal: AbortSignal.abort() }), error =>
    error.code === 'cancelled' && error.details.outcome_unknown === false);
});

test('missing executable is a start failure, not a successful/unknown remote submission', async t => {
  const run = createCli(await tempConfig(t, { CLOUDROOM_CLI_PATH: '/nonexistent/room-cli' }));
  await assert.rejects(run(['thread', 'spawn'], { mutating: true }), error =>
    error.code === 'cli_start_failed' && error.details.outcome_unknown === false);
});
