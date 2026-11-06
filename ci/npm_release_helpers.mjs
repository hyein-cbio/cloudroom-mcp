import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function readReleaseFiles(root, commit) {
  const git = args => exec('git', args, {
    cwd: root, encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  // Keep the verifier at HEAD, but derive both the allowlist and bytes from the
  // immutable release tree. Later source/doc edits must not invalidate a release.
  const { stdout } = await git(['ls-tree', '-r', '-z', '--name-only', commit, '--', 'src/']);
  const sources = stdout.toString('utf8').split('\0').filter(path => /^src\/[^/]+\.mjs$/.test(path));
  const expected = ['package.json', 'server.mjs', ...sources,
    'README.md', 'README.ko.md', 'LICENSE', 'CHANGELOG.md', '.env.example', 'mcp.example.json'].sort();
  return new Map(await Promise.all(expected.map(async path =>
    [path, (await git(['show', commit + ':' + path])).stdout])));
}

export async function handshake(commandName, args, cwd, env, version) {
  const child = spawn(commandName, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let protocolError;
  let closeError;
  const pending = new Map();
  let nextId = 0;
  const rejectPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const failProtocol = error => {
    protocolError ||= error;
    rejectPending(error);
  };
  child.on('error', failProtocol);
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => child.once('close', (code, signal) => {
    // A clean EOF close is not a parse/protocol error, but outstanding or future
    // requests must still fail immediately if the process closes prematurely.
    closeError = new Error('MCP process closed: ' + code + '/' + signal);
    rejectPending(closeError);
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
    } catch (error) { failProtocol(error); }
  });
  function rpc(method, params = {}) {
    if (protocolError || closeError) return Promise.reject(protocolError || closeError);
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
    return { initialize: init.result, tools: listed.result.tools, ping: ping.result, unknownMethodCode: unknown.error.code };
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const status = await exited;
    clearTimeout(timer);
    lines.close();
    // 'close' follows stdio draining, including a final line without a newline.
    // Do not accept a clean exit if stdout became invalid during EOF shutdown.
    assert(!protocolError, String(protocolError));
    assert.equal(status.code, 0, JSON.stringify(status));
    assert.equal(stderr, '', 'Unexpected MCP stderr: ' + stderr.slice(0, 1000));
  }
}
