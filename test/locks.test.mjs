import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { GatewayError } from '../src/cli.mjs';
import { createLocks } from '../src/locks.mjs';
import { tempConfig } from './helpers.mjs';

test('independent controllers cannot mutate the same thread concurrently; failures release the lock', async t => {
  const config = await tempConfig(t);
  const first = createLocks(config);
  const second = createLocks(config);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const running = first('thread:thr_test', async () => { entered(); await blocked; });
  await ready;
  await assert.rejects(second('thread:thr_test', () => assert.fail('Must not enter')), { code: 'operation_locked' });
  assert.equal((await readdir(config.lockDir)).length, 1);
  release();
  await running;
  await assert.rejects(second('thread:thr_test', () => { throw new Error('test error'); }), /test error/);
  assert.deepEqual(await readdir(config.lockDir), []);
  assert.equal(await first('thread:thr_test', () => 'ok'), 'ok');
});

test('missing lock during cleanup does not replace a successful remote operation result', async t => {
  const config = await tempConfig(t);
  const withLock = createLocks(config);
  const accepted = { delivery: 'sent', thread_id: 'thr_test' };
  const result = await withLock('thread:thr_test', async () => {
    const [name] = await readdir(config.lockDir);
    await unlink(join(config.lockDir, name));
    return accepted;
  });
  assert.strictEqual(result, accepted);
  assert.deepEqual(await readdir(config.lockDir), []);
});

test('missing lock during cleanup preserves the original error and uncertain outcome', async t => {
  const config = await tempConfig(t);
  const withLock = createLocks(config);
  const failure = new GatewayError('timeout', 'Submission may have been accepted', { outcome_unknown: true });
  await assert.rejects(withLock('thread:thr_test', async () => {
    const [name] = await readdir(config.lockDir);
    await unlink(join(config.lockDir, name));
    throw failure;
  }), error => error === failure && error.details.outcome_unknown === true);
});

test('failed lock removal preserves the result while the leftover lock fails closed', async t => {
  const config = await tempConfig(t);
  const withLock = createLocks(config);
  const result = await withLock('thread:thr_test', async () => {
    const [name] = await readdir(config.lockDir);
    const path = join(config.lockDir, name);
    await unlink(path);
    await mkdir(path);
    return 'accepted';
  });
  assert.equal(result, 'accepted');
  await assert.rejects(withLock('thread:thr_test', () => assert.fail('Must not enter')), { code: 'operation_locked' });
});
