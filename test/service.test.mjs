import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { GatewayError } from '../src/cli.mjs';
import { tempConfig, fakeCli, info, threadCalls } from './helpers.mjs';

test('spawn forces cloud and explicit high/high defaults, omitting an unconfigured branch', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli();
  const service = createService(config, cli.run);
  const request_id = randomUUID();
  const result = await service.call('thread_spawn', { request_id, prompt: '--help; $(touch /tmp/not-run)' });
  const args = threadCalls(cli)[0].args;
  assert.deepEqual(args.slice(0, 12), ['thread', 'spawn', '--machine', 'cloud', '--project', 'proj_test',
    '--provider', 'acp-devin', '--model', 'gpt-6-1-sol-high', '--reasoning-level', 'high']);
  assert(!args.includes('--base-branch'));
  assert.equal(result.requested_execution.base_branch, null);
  assert(args.includes('--prompt=--help; $(touch /tmp/not-run)'));
  assert(args.includes(request_id));
  assert.equal(result.request_id, request_id);
  assert.equal(result.completion_verified, false);
});

test('spawn accepts explicit option overrides only for allowlisted GitHub repositories', async t => {
  const config = await tempConfig(t, { CLOUDROOM_ALLOWED_GITHUB_REPOS: 'owner/other' });
  const cli = fakeCli(info({ thread: { ...info().thread, projectId: 'proj_other' } }));
  const service = createService(config, cli.run);
  const result = await service.call('thread_spawn', {
    request_id: randomUUID(), prompt: 'hi', github_repo: 'owner/other', provider: 'codex',
    model: 'gpt-6.1-sol', reasoning_level: 'xhigh', base_branch: 'feature/x', title: 'Title',
  });
  assert.equal(result.requested_execution.provider, 'codex');
  assert(threadCalls(cli)[0].args.includes('feature/x'));
  const before = cli.calls.length;
  await assert.rejects(service.call('thread_spawn', { request_id: randomUUID(), prompt: 'hi', github_repo: 'outsider/denied' }), { code: 'repository_not_allowed' });
  assert.equal(cli.calls.length, before);
});

test('tell updates and verifies medium -> high, then sends both flags and safely delimits prompt', async t => {
  const cli = fakeCli(info({ execution: { model: 'gpt-6-1-sol-medium', reasoningLevel: 'medium' } }));
  const service = createService(await tempConfig(t), cli.run);
  const result = await service.call('thread_tell', { thread_id: 'thr_test', prompt: '--help' });
  assert.deepEqual(threadCalls(cli).map(call => call.args[1]), ['show', 'interactions', 'update', 'show', 'tell']);
  assert.deepEqual(cli.calls.at(-1).args, ['thread', 'tell', 'thr_test', '--model', 'gpt-6-1-sol-high',
    '--reasoning-level', 'high', '--mode', 'queue', '--json', '--', '--help']);
  assert.equal(result.settings_updated, true);
  assert.equal(result.native_session_may_have_changed, true);
});

test('tell does not update matching settings and permits steer on a busy matching thread', async t => {
  const cli = fakeCli(info({ thread: { ...info().thread, status: 'active' } }));
  const service = createService(await tempConfig(t), cli.run);
  await service.call('thread_tell', { thread_id: 'thr_test', prompt: 'hi', mode: 'steer' });
  assert.deepEqual(threadCalls(cli).map(call => call.args[1]), ['show', 'tell']);
  assert(threadCalls(cli)[1].args.includes('steer'));
});

test('tell can explicitly switch provider, but never while busy, queued or awaiting interaction', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli();
  const service = createService(config, cli.run);
  await service.call('thread_tell', { thread_id: 'thr_test', prompt: 'hi', provider: 'codex', model: 'gpt-6.1-sol', reasoning_level: 'xhigh' });
  assert(cli.calls.find(call => call.args[1] === 'update').args.includes('--provider'));
  for (const state of [
    info({ thread: { ...info().thread, status: 'active' } }),
    info({ queuedMessageCount: 1 }),
    info({ thread: { ...info().thread, hasPendingInteraction: true } }),
  ]) {
    const other = fakeCli(state);
    await assert.rejects(createService(config, other.run).call('thread_tell', {
      thread_id: 'thr_test', prompt: 'hi', model: 'different',
    }), { code: 'settings_change_blocked' });
    assert.deepEqual(threadCalls(other).map(call => call.args[1]), ['show']);
  }
});

test('thread tools reject Local and unallowlisted repository threads before any further thread command', async t => {
  const config = await tempConfig(t);
  for (const thread of [
    { ...info().thread, executionTarget: 'local' },
    { ...info().thread, projectId: 'proj_other' },
    { ...info().thread, id: 'thr_wrong' },
  ]) for (const tool of ['thread_tell', 'thread_get', 'thread_stop']) {
    const cli = fakeCli(info({ thread }));
    await assert.rejects(createService(config, cli.run).call(tool, {
      thread_id: 'thr_test', ...(tool === 'thread_tell' ? { prompt: 'hello' } : {}),
    }));
    assert.equal(threadCalls(cli).length, 1);
  }
});

test('tell fails closed on unverifiable updates without delivering a message', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli(info({ execution: { model: 'medium', reasoningLevel: 'medium' } }));
  const run = (args, opts) => args[1] === 'update' ? Promise.resolve({}) : cli.run(args, opts);
  await assert.rejects(createService(config, run).call('thread_tell', { thread_id: 'thr_test', prompt: 'hi' }), error => {
    assert.equal(error.code, 'settings_mismatch');
    assert.equal(error.details.settings_updated, true);
    assert.equal(error.details.phase, 'settings_verification');
    return true;
  });
  assert(!cli.calls.some(call => call.args[1] === 'tell'));
});

test('write errors are never automatically retried; request ID and partial settings are retained', async t => {
  const config = await tempConfig(t);
  let calls = 0;
  const request_id = randomUUID();
  const creationCli = fakeCli();
  await assert.rejects(createService(config, async (args, options) => {
    if (args[0] === 'thread' && args[1] === 'spawn') {
      calls++;
      throw new GatewayError('timeout', 'timeout', { outcome_unknown: true });
    }
    return creationCli.run(args, options);
  }).call('thread_spawn', { prompt: 'hello', request_id }), error => {
    assert.equal(error.details.request_id, request_id);
    assert.equal(error.details.outcome_unknown, true);
    return true;
  });
  assert.equal(calls, 1);
  const cli = fakeCli(info({ execution: { model: 'medium', reasoningLevel: 'medium' } }));
  let sends = 0;
  const run = async (args, opts) => {
    if (args[1] === 'tell') { sends++; throw new GatewayError('cli_failed', 'HTTP 409'); }
    return cli.run(args, opts);
  };
  await assert.rejects(createService(config, run).call('thread_tell', { thread_id: 'thr_test', prompt: 'hi' }),
    error => error.details.settings_updated && error.details.phase === 'message_submission');
  assert.equal(sends, 1);
});

test('get returns bounded cursor pages, warns about stale output and exposes errors', async t => {
  const cli = fakeCli();
  cli.setEvents([{ id: 'evt_one', seq: 11, type: 'client/turn/requested', data: { requestId: 'creq_new', text: 'x'.repeat(30_000) } }]);
  const result = await createService(await tempConfig(t), cli.run).call('thread_get', { thread_id: 'thr_test', after_seq: 10, event_limit: 1 });
  assert.equal(result.next_after_seq, 11);
  assert.equal(result.possibly_more_events, true);
  assert.equal(result.events[0].data_truncated, true);
  assert.equal(result.events[0].request_id, 'creq_new');
  assert.equal(result.latest_available_output.text, 'previous turn output');
  assert.equal(result.completion_verified, false);
  assert.equal(result.snapshot_changed, false);
  assert.deepEqual(threadCalls(cli).map(call => call.args[1]), ['show', 'output', 'log', 'show']);
});

test('get rejects malformed or out-of-order event pages', async t => {
  const cli = fakeCli();
  cli.setEvents([{ seq: 1 }, { seq: 1 }]);
  await assert.rejects(createService(await tempConfig(t), cli.run).call('thread_get', { thread_id: 'thr_test' }), { code: 'invalid_cli_response' });
});

test('stop propagates process-unavailable rather than claiming success', async t => {
  const cli = fakeCli();
  const config = await tempConfig(t);
  await createService(config, cli.run).call('thread_stop', { thread_id: 'thr_test' });
  const run = (args, opts) => args[1] === 'stop' ? Promise.reject(new GatewayError('cli_failed', 'process unavailable')) : cli.run(args, opts);
  await assert.rejects(createService(config, run).call('thread_stop', { thread_id: 'thr_test' }), /process unavailable/);
});

test('cancelled operations and invalid input do not launch CLI commands', async t => {
  const cli = fakeCli();
  const service = createService(await tempConfig(t), cli.run);
  await assert.rejects(service.call('thread_get', { thread_id: 'thr_test' }, AbortSignal.abort()));
  await assert.rejects(service.call('thread_spawn', { prompt: 'hello', request_id: randomUUID(), machine: 'local' }));
  assert.equal(cli.calls.length, 0);
});
