import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { GatewayError } from '../src/cli.mjs';
import { fakeCli, info, tempConfig } from './helpers.mjs';

const personalInfo = () => info({ thread: { ...info().thread, projectId: 'proj_personal' } });

test('unset repository selects Personal without any project lookup, registration or branch', async t => {
  const config = await tempConfig(t, { CLOUDROOM_GITHUB_REPO: undefined });
  const cli = fakeCli(personalInfo());
  const result = await createService(config, cli.run, {
    registerGithubRepo: () => assert.fail('Personal must not register a repository'),
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello without a repository' });
  const args = cli.calls[0].args;
  assert.equal(config.githubRepo, null);
  assert.equal(args[args.indexOf('--project') + 1], 'proj_personal');
  assert(!args.includes('--base-branch'));
  assert(args.every(arg => typeof arg === 'string'));
  assert.equal(cli.calls.length, 1);
  assert.equal(result.requested_execution.github_repo, null);
  assert.equal(result.requested_execution.project, 'proj_personal');
  assert.equal(result.requested_execution.base_branch, null);
});

test('Personal ignores a server-level repository branch default', async t => {
  const config = await tempConfig(t, { CLOUDROOM_GITHUB_REPO: undefined, CLOUDROOM_DEFAULT_BASE_BRANCH: 'main' });
  const cli = fakeCli(personalInfo());
  const result = await createService(config, cli.run).call('thread_spawn', {
    request_id: randomUUID(), prompt: 'Hello',
  });
  assert.equal(result.requested_execution.base_branch, null);
  assert(!cli.calls[0].args.includes('--base-branch'));
});

test('explicit base_branch for Personal fails before invoking room-cli', async t => {
  const config = await tempConfig(t, { CLOUDROOM_GITHUB_REPO: undefined });
  const cli = fakeCli(personalInfo());
  await assert.rejects(createService(config, cli.run).call('thread_spawn', {
    request_id: randomUUID(), prompt: 'Hello', base_branch: 'main',
  }), error => error.code === 'branch_not_applicable' && error.details.outcome_unknown === false);
  assert.equal(cli.calls.length, 0);
});

test('GitHub repository selection supports configured and explicit branch overrides', async t => {
  const config = await tempConfig(t, {
    CLOUDROOM_GITHUB_REPO: undefined, CLOUDROOM_ALLOWED_GITHUB_REPOS: 'owner/test',
    CLOUDROOM_DEFAULT_BASE_BRANCH: 'main',
  });
  for (const base_branch of [undefined, 'feature/override']) {
    const cli = fakeCli();
    const result = await createService(config, cli.run).call('thread_spawn', {
      request_id: randomUUID(), prompt: 'Hello', github_repo: 'owner/test',
      ...(base_branch ? { base_branch } : {}),
    });
    const args = cli.calls.find(call => call.args[1] === 'spawn').args;
    assert.equal(args[args.indexOf('--project') + 1], 'proj_test');
    assert.equal(args[args.indexOf('--base-branch') + 1], base_branch ?? 'main');
    assert.equal(result.requested_execution.base_branch, base_branch ?? 'main');
  }
});

test('Personal threads always support get, tell and stop without repository permissions', async t => {
  const config = await tempConfig(t, { CLOUDROOM_GITHUB_REPO: undefined });
  const cli = fakeCli(personalInfo());
  const service = createService(config, cli.run);
  const got = await service.call('thread_get', { thread_id: 'thr_test' });
  assert.equal(got.github_repo, null);
  await service.call('thread_tell', { thread_id: 'thr_test', prompt: 'Hello' });
  await service.call('thread_stop', { thread_id: 'thr_test' });
  assert(cli.calls.every(call => call.args[0] === 'thread'));
});

test('an explicit repository failure never falls back to Personal', async t => {
  const config = await tempConfig(t);
  const calls = [];
  const run = async args => { calls.push(args); throw new GatewayError('cli_failed', 'Lookup failed'); };
  await assert.rejects(createService(config, run).call('thread_spawn', {
    request_id: randomUUID(), prompt: 'Hello', github_repo: 'owner/test',
  }), /Lookup failed/);
  assert.equal(calls.length, 1);
  assert(!calls.some(args => args.includes('proj_personal')));
});
