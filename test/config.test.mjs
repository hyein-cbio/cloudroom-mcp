import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, cliEnvironment } from '../src/config.mjs';
import { githubRepo, schemas } from '../src/schemas.mjs';

test('Personal is the default; no repository or branch configuration is required', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.githubRepo, null);
  assert.deepEqual([...defaults.allowedGithubRepos], []);
  assert.equal(loadConfig({ CLOUDROOM_GITHUB_REPO: '   ' }).githubRepo, null);
  assert.equal(loadConfig({ CLOUDROOM_DEFAULT_BASE_BRANCH: '' }).defaults.base_branch, null);
  assert.deepEqual(defaults.defaults, {
    machine: 'cloud', base_branch: null, provider: 'acp-devin',
    model: 'gpt-6-1-sol-high', reasoning_level: 'high',
  });
  assert.throws(() => loadConfig({ CLOUDROOM_CLI_PATH: 'room-cli' }));
  assert.throws(() => loadConfig({ CLOUDROOM_SERVER_URL: 'http://example.com' }));
  assert.throws(() => loadConfig({ CLOUDROOM_SERVER_URL: 'http://user:pass@localhost' }));
  assert.throws(() => loadConfig({ CLOUDROOM_TIMEOUT_MS: 'NaN' }));
});

test('unset, empty and whitespace-only lock directories use the default path', () => {
  const expected = join(homedir(), '.local/state/cloudroom-mcp/locks');
  assert.equal(loadConfig({}).lockDir, expected);
  for (const value of ['', '   ', '\t\n']) {
    assert.equal(loadConfig({ CLOUDROOM_LOCK_DIR: value }).lockDir, expected);
  }
});

test('lock directories are trimmed before validation and use', () => {
  const path = join(tmpdir(), 'cloudroom-mcp-custom-locks');
  assert.equal(loadConfig({ CLOUDROOM_LOCK_DIR: path }).lockDir, path);
  assert.equal(loadConfig({ CLOUDROOM_LOCK_DIR: ` \t${path}\n ` }).lockDir, path);
});

test('relative lock directories are rejected after trimming', () => {
  for (const value of ['locks', './locks', '../locks', '  locks  ']) {
    assert.throws(() => loadConfig({ CLOUDROOM_LOCK_DIR: value }), /CLOUDROOM_LOCK_DIR must be an absolute path/);
  }
});

test('repository defaults and allowlist use canonical GitHub owner/repository identifiers only', () => {
  const config = loadConfig({
    CLOUDROOM_GITHUB_REPO: 'Owner/Test', CLOUDROOM_ALLOWED_GITHUB_REPOS: 'owner/Other, owner/third',
    CLOUDROOM_DEFAULT_PROVIDER: 'codex', CLOUDROOM_DEFAULT_MODEL: 'gpt-6.1-sol',
    CLOUDROOM_DEFAULT_REASONING_LEVEL: 'xhigh', CLOUDROOM_DEFAULT_BASE_BRANCH: 'feature/cloud',
    CLOUDROOM_SERVER_URL: 'http://localhost:39886',
  });
  assert.equal(config.githubRepo, 'owner/test');
  assert.equal(config.defaults.provider, 'codex');
  assert.equal(config.defaults.base_branch, 'feature/cloud');
  assert.deepEqual([...config.allowedGithubRepos], ['owner/test', 'owner/other', 'owner/third']);
  const clean = cliEnvironment(config, {
    HOME: '/home/test', PATH: '/bin', ROOM_CLI: '/evil', ROOM_CLI_REEXEC: '1',
    ROOM_SERVER_URL: 'http://evil', ROOM_THREAD_ID: 'thr_controller',
    ROOM_PROJECT_ID: 'proj_controller', BB_AUTOMATION_RUN_ID: 'link-me', HERDR_ENV: '1',
  });
  assert.deepEqual(clean, { HOME: '/home/test', PATH: '/bin', ROOM_SERVER_URL: 'http://localhost:39886' });
});

test('legacy project ID configuration is rejected instead of silently changing scope', () => {
  assert.throws(() => loadConfig({ CLOUDROOM_PROJECT_ID: 'proj_test' }), /no longer supported/);
  assert.throws(() => loadConfig({ CLOUDROOM_ALLOWED_PROJECT_IDS: 'proj_test' }), /no longer supported/);
  assert.throws(() => loadConfig({ CLOUDROOM_GITHUB_REPO: 'https://github.com/owner/test.git' }));
  assert.throws(() => loadConfig({ CLOUDROOM_ALLOWED_GITHUB_REPOS: '/local/repo' }));
});

test('GitHub identifiers reject URLs, local paths, IDs, names, suffixes and ambiguous segments', () => {
  for (const value of [
    'https://github.com/owner/repo', 'git@github.com:owner/repo.git', '/home/user/repo',
    './repo', '../repo', 'C:\\repo', 'proj_test', 'repo', 'owner/repo.git',
    'owner/.', 'owner/..', '-owner/repo', 'owner/repo/extra', 'owner/repo?x=1', 'owner/repo#main', ' owner/repo ',
  ]) assert.equal(githubRepo.safeParse(value).success, false, value);
  assert.equal(githubRepo.parse('Owner/Repository'), 'owner/repository');
});

test('strict tool schemas reject project selectors and unsupported flags', () => {
  const base = { prompt: 'hello', request_id: '7de7f6e0-8149-4a5b-b9c5-8b06882ab320' };
  for (const patch of [
    { project: 'proj_test' }, { project_id: 'proj_test' }, { name: 'test' }, { root: '/tmp/repo' },
    { github_repo: 'https://github.com/owner/repo.git' },
    { machine: 'local' }, { provider: '--help' }, { model: '--help' }, { prompt: '   ' },
    { prompt: 'x\0y' }, { request_id: 'not-a-uuid' }, { arbitrary_flags: '--yes' },
    { base_branch: '../secret' }, { base_branch: 'main; rm -rf /' }, { base_branch: 'main~1' },
    { prompt: '한'.repeat(20_000) },
    { title: '--machine=local' }, { title: '-lead' }, { title: ' --machine=local' }, { title: '-' },
  ]) assert.equal(schemas.thread_spawn.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch).slice(0, 150));
  assert(schemas.thread_spawn.safeParse({ ...base, github_repo: 'owner/repo', prompt: '--help', base_branch: 'feature/safe' }).success);
  assert(schemas.thread_spawn.safeParse({ ...base, provider: 'pi', model: 'openai-codex/gpt-6.1-sol' }).success);
  assert.equal(schemas.thread_spawn.parse({ ...base, title: ' note --machine=local ' }).title, 'note --machine=local');
  assert.equal(schemas.thread_get.safeParse({ thread_id: 'thr_test', event_limit: 101 }).success, false);
});
