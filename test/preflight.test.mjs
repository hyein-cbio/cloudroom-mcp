import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.mjs';
import { fakeCli, info, tempConfig, threadCalls } from './helpers.mjs';

test('pending/resolving/unknown interactions block a settings update even when show omits the flag', async t => {
  const config = await tempConfig(t);
  for (const interactions of [[{ status: 'pending' }], [{ status: 'resolving' }], [{ status: 'unknown' }], {}]) {
    const cli = fakeCli(info({ execution: { model: 'medium', reasoningLevel: 'medium' } }));
    const run = (args, opts) => args[1] === 'interactions' ? Promise.resolve(interactions) : cli.run(args, opts);
    await assert.rejects(createService(config, run).call('thread_tell', { thread_id: 'thr_test', prompt: 'hello' }), error =>
      error.code === 'settings_change_blocked' && error.details.phase === 'settings_preflight' && !error.details.settings_updated);
    assert.deepEqual(threadCalls(cli).map(call => call.args[1]), ['show']);
  }
});

test('a configured operation deadline bounds the whole multicommand request', async t => {
  const config = await tempConfig(t, { CLOUDROOM_TIMEOUT_MS: '100' });
  const cli = fakeCli();
  const run = async (args, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 40);
      const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
      options.signal.addEventListener('abort', abort, { once: true });
      // The test listener is once-only; cleanup is safe on either branch.
      setTimeout(() => options.signal.removeEventListener('abort', abort), 45).unref();
    });
    return cli.run(args, options);
  };
  await assert.rejects(createService(config, run).call('thread_get', { thread_id: 'thr_test' }));
  assert(cli.calls.length < 4);
});
