import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const version = '0.1.1';
const spec = 'cloudroom-mcp@' + version;
const registry = 'https://registry.npmjs.org/';
const stage = await mkdtemp(join(tmpdir(), 'cloudroom-npm-release-'));
const output = resolve(process.env.RELEASE_REPORT_DIR || join(root, 'release-report'));
await mkdir(output, { recursive: true });
const report = {
  package: spec, checkedAt: new Date().toISOString(), node: process.version,
  sourceCommit: process.env.GITHUB_SHA || null,
  releaseCommit: '5415e24947429ccb77138bdb8f01a08387ed7fd6',
  authentication: 'none; executable sentinel only; no tools/call requests',
  checks: [], liveCloudroom: 'NOT RUN: Cloudroom/provider authentication and live operations excluded',
};
const env = {
  PATH: process.env.PATH, HOME: join(stage, 'home'), TMPDIR: stage,
  CI: 'true', npm_config_userconfig: join(stage, 'empty.npmrc'),
  npm_config_globalconfig: join(stage, 'empty-global.npmrc'),
  npm_config_registry: registry,
};
await mkdir(env.HOME);
await writeFile(env.npm_config_userconfig, '');
await writeFile(env.npm_config_globalconfig, '');
async function command(cmd, args, cwd = stage) {
  return exec(cmd, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}
async function npm(args, cache = 'cache') {
  return command('npm', [...args, '--registry', registry, '--cache', join(stage, cache)]);
}
function pass(name) { report.checks.push(name); console.log('PASS ' + name); }

async function handshake(commandName, args, cwd, extraEnv) {
  const child = spawn(commandName, args, { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let protocolError;
  const pending = new Map();
  let nextId = 0;
  const rejectPending = error => {
    protocolError ||= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => child.once('close', (code, signal) => {
    rejectPending(new Error('MCP process closed: ' + code + '/' + signal));
    resolveExit({ code, signal });
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      assert(message.id !== undefined || typeof message.method === 'string', 'Unexpected stdout message');
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        assert(item, 'Unsolicited response ID');
        clearTimeout(item.timer);
        pending.delete(message.id);
        item.resolve(message);
      }
    } catch (error) { rejectPending(error); }
  });
  function rpc(method, params = {}) {
    if (protocolError) return Promise.reject(protocolError);
    const id = ++nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)); }, 45_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'npm-release-check', version: '1' },
    });
    assert(!init.error, JSON.stringify(init));
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(init.result.serverInfo.name, 'cloudroom-mcp');
    assert.equal(init.result.serverInfo.version, version);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await rpc('tools/list');
    assert(!listed.error, JSON.stringify(listed));
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(),
      ['thread_get', 'thread_spawn', 'thread_stop', 'thread_tell']);
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert(tool.description.length > 0);
      assert.equal(tool.annotations.readOnlyHint, tool.name === 'thread_get');
    }
    const ping = await rpc('ping');
    assert.deepEqual(ping.result, {});
    const unknown = await rpc('release-check/unknown');
    assert.equal(unknown.error.code, -32601);
    assert(!protocolError, String(protocolError));
    return { initialize: init.result, tools: listed.result.tools, ping: ping.result, unknownMethodCode: unknown.error.code };
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const status = await exited;
    clearTimeout(timer);
    lines.close();
    assert.equal(status.code, 0, JSON.stringify(status));
    assert.equal(stderr, '', 'Unexpected MCP stderr: ' + stderr.slice(0, 1000));
  }
}

try {
  const metadata = JSON.parse((await npm(['view', spec, '--json'])).stdout);
  assert.equal(metadata.name, 'cloudroom-mcp');
  assert.equal(metadata.version, version);
  assert.equal(metadata.dist.tarball, registry + 'cloudroom-mcp/-/cloudroom-mcp-' + version + '.tgz');
  if (metadata.gitHead) assert.equal(metadata.gitHead, report.releaseCommit);
  report.registry = { dist: metadata.dist, gitHead: metadata.gitHead, dependencies: metadata.dependencies };
  const [packed] = JSON.parse((await npm(['pack', spec, '--json', '--ignore-scripts'])).stdout);
  const tarball = join(stage, packed.filename);
  const bytes = await readFile(tarball);
  const sha512 = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  assert.equal(sha512, metadata.dist.integrity);
  assert.equal(createHash('sha1').update(bytes).digest('hex'), metadata.dist.shasum);
  report.tarball = { bytes: bytes.length, integrity: sha512 };
  pass('actual registry tarball integrity matches npm metadata');

  const sources = (await readdir(join(root, 'src'))).filter(name => name.endsWith('.mjs')).map(name => 'src/' + name);
  const expected = ['package.json', 'server.mjs', ...sources,
    'README.md', 'README.ko.md', 'LICENSE', 'CHANGELOG.md', '.env.example', 'mcp.example.json'].sort();
  const paths = (await command('tar', ['-tzf', tarball])).stdout.trim().split('\n');
  assert.equal(new Set(paths).size, paths.length, 'Duplicate archive paths');
  assert.deepEqual(paths.map(path => {
    assert(path.startsWith('package/') && !path.includes('..'), 'Unsafe archive path');
    return path.slice('package/'.length);
  }).sort(), expected);
  const verbose = (await command('tar', ['-tvzf', tarball])).stdout.trim().split('\n');
  assert(verbose.every(line => line.startsWith('-')), 'Only regular files may be shipped');
  const extract = join(stage, 'extract');
  await mkdir(extract);
  await command('tar', ['-xzf', tarball, '-C', extract, '--no-same-owner']);
  report.files = expected;
  pass('exact 15-file allowlist; no credentials, local indexes, tests, CI, symlinks or unexpected files');

  const pkg = join(extract, 'package');
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.engines.node, '>=22');
  assert.deepEqual(manifest.bin, { 'cloudroom-mcp': 'server.mjs' });
  assert.deepEqual(manifest.dependencies, { '@modelcontextprotocol/server': '2.4.0', zod: '4.6.7' });
  for (const key of ['preinstall', 'install', 'postinstall']) assert(!manifest.scripts?.[key], 'Unexpected lifecycle script');
  assert.equal(Object.keys(manifest.optionalDependencies || {}).length, 0);
  assert.equal(Object.keys(manifest.bundledDependencies || {}).length, 0);
  assert((await readFile(join(pkg, 'server.mjs'), 'utf8')).startsWith('#!/usr/bin/env node\n'));
  for (const path of expected) {
    const actual = await readFile(join(pkg, path));
    const source = await readFile(join(root, path));
    if (path === 'package.json') assert.deepEqual(JSON.parse(actual), JSON.parse(source), path);
    else assert.deepEqual(actual, source, 'Published/source byte mismatch: ' + path);
    assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,})/.test(actual.toString('utf8')),
      'Potential credential pattern: ' + path);
  }
  report.sensitiveScan = 'Exact allowlist, source comparison, private-key and GitHub/npm-token patterns; not a guarantee against all secret formats';
  pass('entrypoint, pinned direct dependencies, lifecycle scripts and published/source contents');

  const consumer = join(stage, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'release-consumer', version: '1.0.0', private: true }));
  await command('npm', ['install', tarball, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry', registry, '--cache', join(stage, 'install-cache')], consumer);
  report.dependencyTree = JSON.parse((await command('npm', ['ls', '--all', '--omit=dev', '--json'], consumer)).stdout);
  const installed = join(consumer, 'node_modules', 'cloudroom-mcp');
  const bin = join(consumer, 'node_modules', '.bin', 'cloudroom-mcp');
  assert.equal(await realpath(bin), join(installed, 'server.mjs'));
  pass('isolated consumer production install and complete dependency tree; npm bin resolves to server.mjs');

  const missing = await command(bin, [], consumer).then(
    () => { throw new Error('Missing room-cli unexpectedly succeeded'); }, error => error);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /\[cloudroom-mcp\] Startup failed:/);
  pass('without room-cli: exit 1 with startup diagnostic only on stderr');

  const sentinel = join(stage, 'room-cli-sentinel.mjs');
  const marker = join(stage, 'cli-was-executed');
  await writeFile(sentinel, '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(' +
    JSON.stringify(marker) + ', "unexpected CLI execution");\nprocess.exit(97);\n');
  await chmod(sentinel, 0o755);
  const extraEnv = { CLOUDROOM_CLI_PATH: sentinel, CLOUDROOM_LOCK_DIR: join(stage, 'locks') };
  report.installedProtocol = await handshake(bin, [], consumer, extraEnv);
  pass('installed bin: initialize, initialized notification, four schemas, ping, JSON-RPC error and EOF exit');

  // A separate cold cache exercises npx without local package resolution.
  const npxCwd = join(stage, 'npx-consumer');
  await mkdir(npxCwd);
  report.npxProtocol = await handshake('npx', ['--yes', '--ignore-scripts', '--loglevel=error',
    '--registry=' + registry, '--cache=' + join(stage, 'npx-cache'), spec], npxCwd, extraEnv);
  pass('cold-cache npx initializes and lists exactly four tools (lifecycle scripts disabled)');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  pass('sentinel never executed; no Cloudroom CLI calls, credentials, registration or remote threads');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      'npm release verification: **' + report.status + '**\n\n' +
      report.checks.map(name => '- ' + name).join('\n') +
      '\n\nLive authenticated Cloudroom operations: **not run**.\n' +
      (report.error ? '\nFailure: ' + report.error.message + '\n' : ''));
  }
  await rm(stage, { recursive: true, force: true });
}
