import { GatewayError } from './cli.mjs';
import { createLocks } from './locks.mjs';
import { schemas } from './schemas.mjs';
import { createGithubRegistration } from './github.mjs';
import { createProjects } from './projects.mjs';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(text, limit) {
  if (text === null || text === undefined) return { text: null, truncated: false };
  if (typeof text !== 'string') throw new GatewayError('invalid_cli_response', 'Expected a string from room-cli');
  return { text: text.slice(0, limit), truncated: text.length > limit, original_chars: text.length };
}

function eventPage(value, afterSeq, limit) {
  if (!Array.isArray(value) || value.length > limit) throw new GatewayError('invalid_cli_response', 'Expected a bounded event array');
  let cursor = afterSeq;
  return value.map(event => {
    if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq <= cursor) {
      throw new GatewayError('invalid_cli_response', 'Invalid/non-increasing thread event sequence');
    }
    cursor = event.seq;
    const serialized = JSON.stringify(event.data ?? null);
    const data = clip(serialized, Math.min(4_000, Math.floor(24_000 / limit)));
    return {
      id: event.id, seq: event.seq, type: event.type, created_at: event.createdAt,
      request_id: event.data?.requestId ?? null,
      data: data.truncated ? null : event.data ?? null,
      ...(data.truncated ? { data_preview: data.text } : {}),
      data_truncated: data.truncated,
    };
  });
}

export function createService(config, run, { withLock = createLocks(config), registerGithubRepo = createGithubRegistration(config) } = {}) {
  const projects = createProjects(config, run, withLock, registerGithubRepo);
  function execution(input) {
    return Object.fromEntries(['provider', 'model', 'reasoning_level'].map(key => [key, input[key] ?? config.defaults[key]]));
  }
  async function inspect(id, signal) {
    const info = await run(['thread', 'show', id, '--json'], { signal });
    if (!record(info) || !record(info.thread) || info.thread.id !== id) {
      throw new GatewayError('invalid_cli_response', 'room-cli returned an unexpected thread');
    }
    if (info.thread.executionTarget !== 'cloud') throw new GatewayError('cloud_only', 'Refusing to control a Local/native thread', { outcome_unknown: false });
    const repo = await projects.verify(info.thread.projectId, signal);
    return { ...info, github_repo: repo };
  }
  function writable(info) {
    if (info.thread.archivedAt || info.thread.deletedAt) {
      throw new GatewayError('thread_not_writable', 'Thread is archived or deleted', { outcome_unknown: false });
    }
  }

  async function spawn(input, signal) {
    const repo = input.github_repo ?? config.githubRepo;
    const selected = execution(input);
    if (repo === null && input.base_branch !== undefined) {
      throw new GatewayError('branch_not_applicable', 'Personal has no repository; omit base_branch', { outcome_unknown: false });
    }
    const baseBranch = repo === null ? null : input.base_branch ?? config.defaults.base_branch;
    return withLock('spawn:' + input.request_id, async () => {
      let resolved;
      let phase = 'repository_resolution';
      try {
        resolved = await projects.resolve(repo, signal);
        phase = 'thread_creation';
        const args = ['thread', 'spawn', '--machine', 'cloud', '--project', resolved.projectId,
          '--provider', selected.provider, '--model', selected.model,
          '--reasoning-level', selected.reasoning_level, '--request-id', input.request_id,
          '--prompt=' + input.prompt, '--json'];
        if (baseBranch !== null) args.push('--base-branch', baseBranch);
        // One argv entry, same as --prompt=: a title such as --machine=local stays a value.
        if (input.title) args.push('--title=' + input.title);
        const thread = await run(args, { signal, mutating: true });
        if (!record(thread) || !/^thr_[A-Za-z0-9_-]+$/.test(thread.id ?? '') ||
            thread.executionTarget !== 'cloud' || thread.projectId !== resolved.projectId || thread.providerId !== selected.provider) {
          throw new GatewayError('invalid_cli_response', 'Creation returned an unexpected thread; do not create another blindly',
            { outcome_unknown: true, returned_thread_id: thread?.id ?? null });
        }
        return {
          thread_id: thread.id, request_id: input.request_id, thread,
          requested_execution: { ...selected, machine: 'cloud', base_branch: baseBranch,
            github_repo: resolved.githubRepo, project: resolved.projectId },
          repository_registration_used: resolved.registrationUsed,
          completion_verified: false,
          note: 'Creation is not completion. Poll thread_get and correlate new events; idle alone does not prove this prompt completed.',
        };
      } catch (error) {
        if (error instanceof GatewayError) error.details = {
          ...error.details, phase: error.details.phase ?? phase, github_repo: repo,
          ...(resolved ? { repository_registration_used: resolved.registrationUsed, project_id: resolved.projectId } : {}),
        };
        throw error;
      }
    });
  }

  async function tell(input, signal) {
    return withLock('thread:' + input.thread_id, async () => {
      const info = await inspect(input.thread_id, signal);
      writable(info);
      const selected = execution(input);
      if (!record(info.execution) || typeof info.execution.model !== 'string' ||
          typeof info.execution.reasoningLevel !== 'string') {
        throw new GatewayError('execution_unknown', 'Cannot safely compare the current execution settings', { outcome_unknown: false });
      }
      const providerChanged = info.thread.providerId !== selected.provider;
      const modelChanged = info.execution.model !== selected.model;
      const reasoningChanged = info.execution.reasoningLevel !== selected.reasoning_level;
      const changing = providerChanged || modelChanged || reasoningChanged;
      // Cloud changes can replace the native agent session. Do not switch while busy/queued.
      if (changing && (!['idle', 'error'].includes(info.thread.status) || info.queuedMessageCount !== 0 || info.thread.hasPendingInteraction)) {
        throw new GatewayError('settings_change_blocked',
          'Wait for an idle/error thread with no queued messages or pending interaction before changing execution settings',
          { outcome_unknown: false, requested_execution: selected });
      }
      let settingsUpdated = false;
      let phase = 'settings_preflight';
      try {
        if (changing) {
          // thread show does not always include hasPendingInteraction; query the actual interaction list.
          const interactions = await run(['thread', 'interactions', 'list', input.thread_id, '--json'], { signal });
          if (!Array.isArray(interactions) || interactions.some(item => !record(item) ||
              !['resolved', 'interrupted'].includes(item.status))) {
            throw new GatewayError('settings_change_blocked',
              'Cannot change execution settings while an interaction is pending/resolving or its state is unknown', { outcome_unknown: false });
          }
          phase = 'settings_update';
          const args = ['thread', 'update', input.thread_id, '--model', selected.model,
            '--reasoning-level', selected.reasoning_level, '--json'];
          if (providerChanged) args.push('--provider', selected.provider);
          await run(args, { signal, mutating: true });
          settingsUpdated = true;
          phase = 'settings_verification';
          const updated = await inspect(input.thread_id, signal);
          if (updated.thread.providerId !== selected.provider || updated.execution?.model !== selected.model ||
              updated.execution?.reasoningLevel !== selected.reasoning_level) {
            throw new GatewayError('settings_mismatch', 'Cloudroom has not confirmed the requested execution settings; message was not sent', { outcome_unknown: false });
          }
        }
        phase = 'message_submission';
        // -- ends option parsing: even a prompt beginning "--help" is message text.
        const delivery = await run(['thread', 'tell', input.thread_id, '--model', selected.model,
          '--reasoning-level', selected.reasoning_level, '--mode', input.mode ?? 'queue', '--json', '--', input.prompt],
          { signal, mutating: true });
        if (!record(delivery) || delivery.ok !== true || delivery.threadId !== input.thread_id ||
            !['sent', 'queued'].includes(delivery.delivery)) {
          throw new GatewayError('invalid_cli_response', 'Unknown submission result; inspect the queue/history before retrying', { outcome_unknown: true });
        }
        return {
          thread_id: input.thread_id, github_repo: info.github_repo, delivery, requested_execution: selected,
          settings_updated: settingsUpdated,
          native_session_may_have_changed: settingsUpdated && (providerChanged || modelChanged),
          completion_verified: false,
          note: 'Sent/queued means accepted, not completed. thread_get latest output may belong to an earlier turn.',
        };
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        error.details = { ...error.details, phase, settings_updated: settingsUpdated,
          native_session_may_have_changed: settingsUpdated && (providerChanged || modelChanged) };
        throw error;
      }
    });
  }

  async function get(input, signal) {
    const info = await inspect(input.thread_id, signal);
    const afterSeq = input.after_seq ?? 0;
    const limit = input.event_limit ?? 20;
    const output = await run(['thread', 'output', input.thread_id, '--json'], { signal });
    if (!record(output) || !('output' in output) || !('error' in output)) {
      throw new GatewayError('invalid_cli_response', 'Expected output/error fields from room-cli');
    }
    const events = eventPage(await run(['thread', 'log', input.thread_id, '--format', 'json',
      '--after-seq', String(afterSeq), '--limit', String(limit)], { signal }), afterSeq, limit);
    const final = await inspect(input.thread_id, signal);
    return {
      thread_id: input.thread_id, github_repo: final.github_repo, thread: final.thread, execution: final.execution ?? null,
      queued_message_count: final.queuedMessageCount ?? null,
      latest_available_output: clip(output.output, 16_000),
      output_error: clip(output.error, 8_000),
      last_error: clip(final.lastError, 8_000),
      events, next_after_seq: events.at(-1)?.seq ?? afterSeq,
      possibly_more_events: events.length === limit,
      snapshot_changed: info.thread.updatedAt !== final.thread.updatedAt || info.thread.status !== final.thread.status,
      completion_verified: false,
      note: 'Non-atomic observations. Output is the latest available, not necessarily the turn you just submitted. Correlate event request IDs and terminal events; never infer success from idle alone.',
    };
  }

  async function stop(input, signal) {
    return withLock('thread:' + input.thread_id, async () => {
      const info = await inspect(input.thread_id, signal);
      writable(info);
      const result = await run(['thread', 'stop', input.thread_id, '--json'], { signal, mutating: true });
      if (!record(result) || result.ok !== true || result.threadId !== input.thread_id) {
        throw new GatewayError('invalid_cli_response', 'Unknown stop result; inspect the thread', { outcome_unknown: true });
      }
      return { thread_id: input.thread_id, github_repo: info.github_repo, result, note: 'Stops work; does not archive/delete the thread or guarantee VM destruction.' };
    });
  }

  const handlers = { thread_spawn: spawn, thread_tell: tell, thread_get: get, thread_stop: stop };
  return {
    async call(name, input, clientSignal) {
      if (!Object.hasOwn(handlers, name)) throw new GatewayError('unknown_tool', 'Unknown tool');
      const parsed = schemas[name].parse(input);
      const deadline = AbortSignal.timeout(config.timeoutMs);
      const signal = clientSignal ? AbortSignal.any([deadline, clientSignal]) : deadline;
      signal.throwIfAborted();
      try {
        return await handlers[name](parsed, signal);
      } catch (error) {
        if (error instanceof GatewayError && name === 'thread_spawn') {
          error.details = { ...error.details, request_id: parsed.request_id };
        }
        throw error;
      }
    },
  };
}
