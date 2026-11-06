import { createInterface } from 'node:readline';

const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (mode === 'premature-close') {
    process.exit(0);
  }
  const { id, method } = request;
  switch (method) {
    case 'initialize':
      send({ id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'cloudroom-mcp', version: '0.1.1' } } });
      break;
    case 'tools/list':
      send({ id, result: { tools: ['thread_get', 'thread_spawn', 'thread_stop', 'thread_tell'].map(name => ({
        name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: name === 'thread_get' },
      })) } });
      break;
    case 'ping':
      send({ id, result: {} });
      break;
    default:
      send({ id, error: { code: -32601, message: 'Unknown method' } });
  }
});
// Emit only after the verifier ends stdin, so these cannot be observed by a
// protocol-error assertion that runs before shutdown. No forced exit: drain IO.
lines.on('close', () => {
  switch (mode) {
    case 'stray-log': process.stdout.write('Shutting down\n'); break;
    case 'invalid-jsonrpc': process.stdout.write('{"jsonrpc":"1.0","method":"notice"}\n'); break;
    case 'unsolicited-response': send({ id: 999, result: {} }); break;
    case 'unterminated-log': process.stdout.write('Shutting down'); break;
    case 'unterminated-response': process.stdout.write('{"jsonrpc":"2.0","id":999,"result":{}}'); break;
    case 'stderr': process.stderr.write('Shutdown warning\n'); break;
    case 'nonzero': process.exitCode = 3; break;
  }
});
