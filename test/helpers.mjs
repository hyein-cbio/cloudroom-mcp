import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { GatewayError } from '../src/cli.mjs';

export async function tempConfig(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cloudroom-mcp-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return loadConfig({ CLOUDROOM_GITHUB_REPO: 'owner/test', CLOUDROOM_LOCK_DIR: dir, ...extra });
}

export function info(overrides = {}) {
  return {
    thread: {
      id: 'thr_test', executionTarget: 'cloud', projectId: 'proj_test', providerId: 'acp-devin',
      status: 'idle', archivedAt: null, deletedAt: null, updatedAt: 1,
    },
    execution: { model: 'gpt-6-1-sol-high', reasoningLevel: 'high' },
    queuedMessageCount: 0,
    ...overrides,
  };
}

export const project = (id = 'proj_test', repo = 'owner/test') => ({
  id, kind: 'standard', name: repo.split('/')[1], gitRemoteUrl: 'https://github.com/' + repo + '.git', sources: [],
});
export const threadCalls = cli => cli.calls.filter(call => call.args[0] === 'thread');

export function fakeCli(initial = info()) {
  let current = structuredClone(initial);
  let projects = [project(), project('proj_other', 'owner/other')];
  const calls = [];
  let events = [];
  let output = { output: 'previous turn output', error: null };
  return {
    calls,
    setInfo(value) { current = value; },
    setProjects(value) { projects = value; },
    setEvents(value) { events = value; },
    setOutput(value) { output = value; },
    async run(args, options) {
      calls.push({ args, options });
      if (options?.signal?.aborted) throw options.signal.reason;
      const get = flag => args[args.indexOf(flag) + 1];
      if (args[0] === 'project') {
        if (args[1] === 'list') return structuredClone(projects);
        if (args[1] === 'show') {
          const found = projects.find(project => project.id === args[2]);
          if (!found) throw new GatewayError('cli_failed', 'Project not found', { outcome_unknown: false });
          return structuredClone(found);
        }
        throw new Error('Unexpected project mutation');
      }
      switch (args[1]) {
        case 'show': return structuredClone(current);
        case 'spawn':
          current.thread.projectId = get('--project');
          current.thread.providerId = get('--provider');
          return structuredClone(current.thread);
        case 'update':
          if (args.includes('--provider')) current.thread.providerId = get('--provider');
          current.execution = { model: get('--model'), reasoningLevel: get('--reasoning-level') };
          return structuredClone(current.thread);
        case 'tell': return { ok: true, threadId: current.thread.id, delivery: 'sent', mode: 'queue' };
        case 'interactions': return [];
        case 'output': return output;
        case 'log': return events;
        case 'stop': return { ok: true, threadId: current.thread.id };
        default: throw new Error('Unexpected fake command');
      }
    },
  };
}
