import { z } from 'zod';

export const PERSONAL_PROJECT_ID = 'proj_personal';
export const githubRepo = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/,
    'Use GitHub owner/repository only, not a URL, project ID, name or local path')
  .refine(value => !['.', '..'].includes(value.split('/')[1]) && !/\.git$/i.test(value),
    'Use owner/repository without a .git suffix')
  .transform(value => value.toLowerCase());
// Project IDs are internal Cloudroom identifiers, never public tool inputs.
export const projectId = z.string().regex(/^proj_[A-Za-z0-9_-]+$/).max(128);
export const threadId = z.string().regex(/^thr_[A-Za-z0-9_-]+$/).max(128);
export const providerId = z.string().regex(/^[a-z][a-z0-9-]*$/).max(128);
export const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/).max(256);
export const reasoningLevel = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']);
export const branch = z.string().min(1).max(256).refine(value =>
  !/^[.-]|[/.]$|\.\.|@\{|[\s\\~^:?*\[\x00-\x1f\x7f]/.test(value) &&
  value !== '@' && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')),
'Use a Git branch/ref name, not a path, revision expression or option');
const prompt = z.string().min(1).max(48_000)
  .refine(value => value.trim().length > 0 && !value.includes('\0'), 'Prompt must be nonblank and contain no NUL')
  .refine(value => Buffer.byteLength(value, 'utf8') <= 48_000, 'Prompt must fit in 48000 UTF-8 bytes');
const execution = {
  provider: providerId.optional().describe('CLI provider ID, e.g. acp-devin (not devin). Omitted: server default.'),
  model: modelId.optional().describe('Exact provider-specific model ID. Omitted: server default.'),
  reasoning_level: reasoningLevel.optional().describe('Explicit reasoning effort. Omitted: server default, not a model-name suffix.'),
};

export const schemas = {
  thread_spawn: z.strictObject({
    prompt,
    request_id: z.string().uuid().describe('Generate once per logical creation; reuse with identical inputs after an uncertain result. Never blindly generate a new ID to retry.'),
    github_repo: githubRepo.optional().describe('GitHub owner/repository only, e.g. owner/repository. No URLs, IDs, project names or local paths. Must be server-allowlisted. Omitted: configured repository, or Personal when none is configured.'),
    machine: z.literal('cloud').optional().describe('Cloud only. Local/native execution is intentionally unsupported.'),
    base_branch: branch.optional().describe('Repository projects only: pushed GitHub branch/ref. Omitted unless configured. Not applicable to proj_personal; do not specify it for Personal. No local file upload.'),
    title: z.string().trim().min(1).max(200)
      .refine(value => !/[\x00-\x1f\x7f]/.test(value))
      .refine(value => !value.startsWith('-'), 'Title must not start with -')
      .optional(),
    ...execution,
  }),
  thread_tell: z.strictObject({
    thread_id: threadId,
    prompt,
    ...execution,
    mode: z.enum(['queue', 'steer', 'auto']).optional().describe('Omitted: queue. Does not wait for turn completion.'),
  }),
  thread_get: z.strictObject({
    thread_id: threadId,
    after_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Event cursor; omitted: 0. Continue with next_after_seq until possibly_more_events is false.'),
    event_limit: z.number().int().min(1).max(100).optional().describe('Bounded raw event page, default 20.'),
  }),
  thread_stop: z.strictObject({ thread_id: threadId }),
};
