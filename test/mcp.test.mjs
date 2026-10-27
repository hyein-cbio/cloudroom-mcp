import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { GITHUB_REGISTRATION_PATH } from '../src/github.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tempConfig, info, project } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'test/fixtures/room-cli.mjs');
await chmod(fixture, 0o755);

async function environment(t, { personal = false } = {}) {
  const config = await tempConfig(t);
  const statePath = join(config.lockDir, 'state.json');
  const initialInfo = personal ? info({ thread: { ...info().thread, projectId: 'proj_personal' } }) : info();
  await writeFile(statePath, JSON.stringify({ info: initialInfo, projects: [project()], output: null, events: [], calls: [] }));
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLOUDROOM_'))),
    CLOUDROOM_CLI_PATH: fixture,
    ...(personal ? {} : { CLOUDROOM_GITHUB_REPO: 'owner/test' }),
    CLOUDROOM_LOCK_DIR: join(config.lockDir, 'locks'),
    FAKE_ROOM_STATE: statePath,
  };
}

test('real stdio MCP client discovers exactly four tools and drives the full flow', { timeout: 20_000 }, async t => {
  const env = await environment(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server.mjs')], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'cloudroom-mcp-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
    ['thread_get', 'thread_spawn', 'thread_stop', 'thread_tell']);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const spawned = await call('thread_spawn', { prompt: 'hello', request_id: randomUUID() });
  assert.equal(spawned.thread_id, 'thr_test');
  const told = await call('thread_tell', { thread_id: 'thr_test', prompt: '--help; $(echo not-a-shell)' });
  assert.equal(told.delivery.delivery, 'sent');
  const got = await call('thread_get', { thread_id: 'thr_test', event_limit: 1 });
  assert.equal(got.latest_available_output.text, 'Echo: --help; $(echo not-a-shell)');
  assert.equal(got.execution.reasoningLevel, 'high');
  assert.equal(got.events.length, 1);
  const next = await call('thread_get', { thread_id: 'thr_test', after_seq: got.next_after_seq });
  assert.equal(next.events.length, 1);
  const stopped = await call('thread_stop', { thread_id: 'thr_test' });
  assert.equal(stopped.result.ok, true);
  const invalid = await client.callTool({ name: 'thread_spawn', arguments: { request_id: randomUUID(), prompt: 'hi', machine: 'local' } });
  assert.equal(invalid.isError, true);
  const failed = await client.callTool({ name: 'thread_tell', arguments: { thread_id: 'thr_test', prompt: 'FAIL' } });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.outcome_unknown, true);
  const state = JSON.parse(await readFile(env.FAKE_ROOM_STATE, 'utf8'));
  assert.equal(state.calls.filter(args => args[1] === 'tell' && args.at(-1) === 'FAIL').length, 1);
  assert.equal(stderr, '');
});

test('stdio MCP starts without a project setting and creates a Personal thread without a branch', { timeout: 10_000 }, async t => {
  const env = await environment(t, { personal: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server.mjs')], env, stderr: 'pipe' });
  const client = new Client({ name: 'personal-default-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const response = await client.callTool({ name: 'thread_spawn', arguments: { request_id: randomUUID(), prompt: 'Hello Personal' } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.equal(response.structuredContent.thread.projectId, 'proj_personal');
  assert.equal(response.structuredContent.requested_execution.base_branch, null);
  const state = JSON.parse(await readFile(env.FAKE_ROOM_STATE, 'utf8'));
  const args = state.calls.find(args => args[1] === 'spawn');
  assert(!args.includes('--base-branch'));
  assert.equal(args[args.indexOf('--project') + 1], 'proj_personal');
});

test('stdio MCP resolves a new GitHub slug through HTTP registration without local checkout commands', { timeout: 15_000 }, async t => {
  const env = await environment(t);
  env.CLOUDROOM_GITHUB_REPO = 'owner/new';
  const initial = JSON.parse(await readFile(env.FAKE_ROOM_STATE, 'utf8'));
  initial.projects = [];
  await writeFile(env.FAKE_ROOM_STATE, JSON.stringify(initial));
  let registrations = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, GITHUB_REGISTRATION_PATH);
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { repo: 'owner/new' });
    registrations++;
    const state = JSON.parse(await readFile(env.FAKE_ROOM_STATE, 'utf8'));
    state.projects.push(project('proj_new', 'owner/new'));
    await writeFile(env.FAKE_ROOM_STATE, JSON.stringify(state));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projectId: 'proj_new' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  env.CLOUDROOM_SERVER_URL = 'http://127.0.0.1:' + server.address().port;
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server.mjs')], env, stderr: 'pipe' });
  const client = new Client({ name: 'github-registration-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const response = await client.callTool({ name: 'thread_spawn', arguments: { request_id: randomUUID(), prompt: 'Hello GitHub', github_repo: 'Owner/New' } });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.equal(response.structuredContent.requested_execution.github_repo, 'owner/new');
  assert.equal(response.structuredContent.repository_registration_used, true);
  assert.equal(response.structuredContent.thread.projectId, 'proj_new');
  const got = await client.callTool({ name: 'thread_get', arguments: { thread_id: 'thr_test' } });
  assert.notEqual(got.isError, true);
  assert.equal(got.structuredContent.github_repo, 'owner/new');
  const state = JSON.parse(await readFile(env.FAKE_ROOM_STATE, 'utf8'));
  assert(!state.calls.some(args => args.includes('--root') || args.includes('--clone') || args.includes('--path')));
  assert.equal(registrations, 1);
});

test('legacy 2025 MCP handshake works for existing Pi/Devin clients', { timeout: 10_000 }, async t => {
  const env = await environment(t);
  const child = spawn(process.execPath, [join(root, 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => {
    const message = JSON.parse(line); // Any stray stdout log breaks this test.
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let id = 0;
  const rpc = (method, params) => {
    const requestId = ++id;
    return new Promise(resolve => {
      pending.set(requestId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  };
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  assert.equal(tools.result.tools.length, 4);
  const response = await rpc('tools/call', { name: 'thread_get', arguments: { thread_id: 'thr_test' } });
  assert.equal(response.result.structuredContent.execution.model, 'gpt-6-1-sol-high');
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await exited, 0);
});
