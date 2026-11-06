import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { handshake, readReleaseFiles } from '../ci/npm_release_helpers.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'test/fixtures/release-mcp.mjs');

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'cloudroom-release-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = args => exec('git', args, {
    cwd, timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Release test', GIT_AUTHOR_EMAIL: 'release@example.invalid',
      GIT_COMMITTER_NAME: 'Release test', GIT_COMMITTER_EMAIL: 'release@example.invalid' },
  });
  await git(['init']);
  return { cwd, git };
}

test('release allowlist and source bytes come from the release commit, not HEAD or working tree', { timeout: 20_000 }, async t => {
  const { cwd, git } = await repository(t);
  const files = new Map([
    ['package.json', Buffer.from('{"name":"release-fixture","version":"0.1.1"}\n')],
    ...['server.mjs', 'src/retained.mjs', 'README.md', 'README.ko.md', 'LICENSE',
      'CHANGELOG.md', '.env.example', 'mcp.example.json'].map(path => [path, Buffer.from('release: ' + path + '\n')]),
    ['src/removed.mjs', Buffer.from([0, 255, 13, 10])],
  ]);
  for (const [path, bytes] of files) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), bytes);
  }
  await mkdir(join(cwd, 'src/nested'));
  await writeFile(join(cwd, 'src/nested/not-shipped.mjs'), 'not shipped');
  await writeFile(join(cwd, 'src/not-shipped.txt'), 'not shipped');
  await git(['add', '.']);
  await git(['commit', '-m', 'Release fixture']);
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  // A later checkout can change docs, runtime, manifest, and the source list.
  for (const path of ['package.json', 'README.md', 'server.mjs', 'src/retained.mjs']) {
    await writeFile(join(cwd, path), 'changed after release\n');
  }
  await rm(join(cwd, 'src/removed.mjs'));
  await writeFile(join(cwd, 'src/added.mjs'), 'new module\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Post-release changes']);
  await writeFile(join(cwd, 'README.ko.md'), 'uncommitted change\n');
  await writeFile(join(cwd, 'src/untracked.mjs'), 'untracked module\n');

  const actual = await readReleaseFiles(cwd, commit);
  assert.deepEqual([...actual.keys()], [...files.keys()].sort());
  for (const [path, bytes] of files) assert.deepEqual(actual.get(path), bytes, path);
  await assert.rejects(readReleaseFiles(cwd, '0'.repeat(40)), /Command failed/);
});

test('release handshake accepts clean EOF and rejects invalid shutdown output', { timeout: 20_000 }, async t => {
  const run = mode => handshake(process.execPath, [fixture, mode], root, process.env, '0.1.1');
  await t.test('normal EOF close is not a protocol error', async () => {
    const result = await run('clean');
    assert.equal(result.initialize.serverInfo.version, '0.1.1');
    assert.equal(result.tools.length, 4);
    assert.deepEqual(result.ping, {});
    assert.equal(result.unknownMethodCode, -32601);
  });
  for (const [mode, error] of [
    ['stray-log', /SyntaxError/],
    ['invalid-jsonrpc', /1\.0/],
    ['unsolicited-response', /Unsolicited response ID/],
    ['unterminated-log', /SyntaxError/],
    ['unterminated-response', /Unsolicited response ID/],
    ['stderr', /Unexpected MCP stderr/],
    ['nonzero', /"code":3/],
    ['premature-close', /MCP process closed/],
  ]) {
    await t.test(mode, () => assert.rejects(run(mode), error));
  }
});
