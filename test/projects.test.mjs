import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createService } from '../src/service.mjs';
import { createGithubRegistration } from '../src/github.mjs';
import { GatewayError } from '../src/cli.mjs';
import { fakeCli, info, project, tempConfig, threadCalls } from './helpers.mjs';

test('existing GitHub project is reused by remote, not name or local source path', async t => {
  const cli = fakeCli();
  cli.setProjects([
    { ...project('proj_wrong', 'owner/different'), name: 'test' },
    { ...project(), name: 'arbitrary-name', sources: [{ type: 'local_path', path: '/do/not/read' }] },
  ]);
  const result = await createService(await tempConfig(t), cli.run, {
    registerGithubRepo: () => assert.fail('Existing repository must not be registered'),
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello', github_repo: 'Owner/Test' });
  assert.equal(result.requested_execution.github_repo, 'owner/test');
  assert.equal(result.requested_execution.project, 'proj_test');
  assert.equal(result.repository_registration_used, false);
  assert.deepEqual(cli.calls.slice(0, 2).map(call => call.args), [
    ['project', 'list', '--json'], ['project', 'show', 'proj_test', '--json'],
  ]);
  assert(!cli.calls.some(call => call.args.includes('--root') || call.args.includes('--path') || call.args.includes('--clone')));
});

test('a missing repository is registered then verified before Cloud spawn, without local setup', async t => {
  const config = await tempConfig(t, { CLOUDROOM_GITHUB_REPO: 'owner/new' });
  const cli = fakeCli();
  cli.setProjects([]);
  let registrations = 0;
  const result = await createService(config, cli.run, {
    registerGithubRepo: async repo => {
      registrations++;
      assert.equal(repo, 'owner/new');
      cli.setProjects([project('proj_new', repo)]);
      return 'proj_new';
    },
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello', base_branch: 'main' });
  assert.equal(registrations, 1);
  assert.equal(result.repository_registration_used, true);
  assert.equal(result.requested_execution.project, 'proj_new');
  const spawn = threadCalls(cli)[0].args;
  assert.equal(spawn[spawn.indexOf('--project') + 1], 'proj_new');
  assert.equal(spawn[spawn.indexOf('--machine') + 1], 'cloud');
});

test('independent MCP controllers cannot register the same repository concurrently', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli();
  cli.setProjects([]);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let registrations = 0;
  const registerGithubRepo = async repo => {
    registrations++;
    entered();
    await waiting;
    cli.setProjects([project('proj_new', repo)]);
    return 'proj_new';
  };
  const first = createService(config, cli.run, { registerGithubRepo });
  const second = createService(config, cli.run, { registerGithubRepo });
  const running = first.call('thread_spawn', { request_id: randomUUID(), prompt: 'First' });
  await ready;
  try {
    await assert.rejects(second.call('thread_spawn', { request_id: randomUUID(), prompt: 'Second' }),
      { code: 'operation_locked' });
    assert.equal(registrations, 1);
  } finally { release(); }
  assert.equal((await running).requested_execution.project, 'proj_new');
});

test('an unallowlisted repository is rejected before metadata queries or HTTP writes', async t => {
  const cli = fakeCli();
  await assert.rejects(createService(await tempConfig(t), cli.run, {
    registerGithubRepo: () => assert.fail('No HTTP request allowed'),
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello', github_repo: 'outsider/repo' }),
  { code: 'repository_not_allowed' });
  assert.equal(cli.calls.length, 0);
});

test('duplicate repository projects fail instead of selecting an arbitrary ID', async t => {
  const cli = fakeCli();
  cli.setProjects([project('proj_one'), project('proj_two')]);
  await assert.rejects(createService(await tempConfig(t), cli.run, {
    registerGithubRepo: () => assert.fail('No registration on ambiguity'),
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello' }), { code: 'ambiguous_repository' });
  assert.equal(threadCalls(cli).length, 0);
});

test('registration result is verified against the requested GitHub remote before execution', async t => {
  const cli = fakeCli();
  cli.setProjects([]);
  await assert.rejects(createService(await tempConfig(t), cli.run, {
    registerGithubRepo: async () => { cli.setProjects([project('proj_wrong', 'outsider/repo')]); return 'proj_wrong'; },
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello' }), error =>
    error.code === 'repository_mismatch' && error.details.repository_registration_used === true);
  assert.equal(threadCalls(cli).length, 0);
});

test('failed registration is reported once with request ID; no local or Personal fallback', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli();
  cli.setProjects([]);
  let requests = 0;
  const request_id = randomUUID();
  const registerGithubRepo = createGithubRegistration(config, async () => {
    requests++;
    throw new Error('Connection lost after POST');
  });
  await assert.rejects(createService(config, cli.run, { registerGithubRepo }).call('thread_spawn', {
    request_id, prompt: 'Hello',
  }), error => error.details.request_id === request_id &&
    error.details.phase === 'repository_registration' && error.details.outcome_unknown === true);
  assert.equal(requests, 1);
  assert.equal(threadCalls(cli).length, 0);
});

test('registration side effects are retained in errors when later thread creation fails', async t => {
  const config = await tempConfig(t);
  const cli = fakeCli();
  cli.setProjects([]);
  const run = (args, options) => args[1] === 'spawn'
    ? Promise.reject(new GatewayError('cli_failed', 'Cloud unavailable', { outcome_unknown: true })) : cli.run(args, options);
  await assert.rejects(createService(config, run, {
    registerGithubRepo: async repo => { cli.setProjects([project('proj_new', repo)]); return 'proj_new'; },
  }).call('thread_spawn', { request_id: randomUUID(), prompt: 'Hello' }), error =>
    error.details.repository_registration_used === true && error.details.phase === 'thread_creation' && error.details.project_id === 'proj_new');
});

test('get/tell/stop validate current GitHub remote, never a project name or remembered ID alone', async t => {
  const config = await tempConfig(t);
  for (const remote of [null, 'https://github.com/outsider/repo.git', '/local/repo']) {
    for (const tool of ['thread_get', 'thread_tell', 'thread_stop']) {
      const cli = fakeCli();
      cli.setProjects([{ ...project(), name: 'owner/test', gitRemoteUrl: remote }]);
      await assert.rejects(createService(config, cli.run).call(tool, {
        thread_id: 'thr_test', ...(tool === 'thread_tell' ? { prompt: 'Hello' } : {}),
      }));
      assert.deepEqual(threadCalls(cli).map(call => call.args[1]), ['show']);
    }
  }
});
