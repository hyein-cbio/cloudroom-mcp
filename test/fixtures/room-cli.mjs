#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
switch (args[0]) {
  case 'test_echo':
    console.log(JSON.stringify({ args, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ROOM_'))) }));
    process.exit(0);
  case 'test_bad_json': console.log('not json'); process.exit(0);
  case 'test_failure': console.error('test CLI failure'); process.exit(7);
  case 'test_hang': setInterval(() => {}, 1000); break;
  case 'test_big_output': process.stdout.write('x'.repeat(2_000_000)); break;
  default: {
    const path = process.env.FAKE_ROOM_STATE;
    if (!path) throw new Error('Fake CLI requires FAKE_ROOM_STATE');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.calls.push(args);
    const value = flag => args[args.indexOf(flag) + 1];
    let result;
    const event = prompt => {
      const seq = (state.events.at(-1)?.seq ?? 0) + 1;
      state.events.push({ id: 'evt_' + seq, seq, type: 'client/turn/requested', data: { requestId: 'creq_' + seq, input: [{ type: 'text', text: prompt }] } });
      state.output = 'Echo: ' + prompt;
    };
    if (args[0] === 'project') {
      if (args[1] === 'list') result = state.projects;
      else if (args[1] === 'show') {
        result = state.projects.find(project => project.id === args[2]);
        if (!result) { console.error('Project not found'); process.exit(1); }
      } else throw new Error('Local project creation/attachment must never be called');
      writeFileSync(path, JSON.stringify(state));
      console.log(JSON.stringify(result));
      break;
    }
    if (args[0] !== 'thread') throw new Error('Unexpected fake command');
    switch (args[1]) {
      case 'show': result = state.info; break;
      case 'spawn':
        state.info.thread.projectId = value('--project');
        state.info.thread.providerId = value('--provider');
        state.info.execution = { model: value('--model'), reasoningLevel: value('--reasoning-level') };
        event(args.find(arg => arg.startsWith('--prompt=')).slice('--prompt='.length));
        result = state.info.thread;
        break;
      case 'update':
        if (args.includes('--provider')) state.info.thread.providerId = value('--provider');
        state.info.execution = { model: value('--model'), reasoningLevel: value('--reasoning-level') };
        result = state.info.thread;
        break;
      case 'tell':
        if (args.at(-1) === 'FAIL') { writeFileSync(path, JSON.stringify(state)); console.error('HTTP 409: deliberate rejection'); process.exit(1); }
        event(args.at(-1));
        result = { ok: true, threadId: state.info.thread.id, delivery: 'sent', mode: value('--mode') };
        break;
      case 'interactions': result = []; break;
      case 'output': result = { output: state.output, error: null }; break;
      case 'log': result = state.events.filter(event => event.seq > Number(value('--after-seq'))).slice(0, Number(value('--limit'))); break;
      case 'stop': result = { ok: true, threadId: state.info.thread.id }; break;
      default: throw new Error('Unexpected fake command: ' + args[1]);
    }
    writeFileSync(path, JSON.stringify(state));
    console.log(JSON.stringify(result));
  }
}
