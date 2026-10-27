import { GatewayError } from './cli.mjs';
import { githubRepo, projectId, PERSONAL_PROJECT_ID } from './schemas.mjs';

// This is an internal Cloudroom app endpoint, not a GitHub API or a room-cli command.
export const GITHUB_REGISTRATION_PATH = '/api/v1/cloudroom/account/repo-suggestions/github';

export function repositoryFromRemote(remote) {
  if (typeof remote !== 'string') return null;
  let slug;
  const ssh = /^git@github\.com:(.+)$/i.exec(remote);
  if (ssh) slug = ssh[1];
  else {
    let url;
    try { url = new URL(remote); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
        url.username || url.password || url.search || url.hash) return null;
    slug = url.pathname.slice(1).replace(/\/$/, '');
  }
  const parsed = githubRepo.safeParse(slug.replace(/\.git$/i, ''));
  return parsed.success ? parsed.data : null;
}

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new GatewayError('github_response_limit', 'GitHub project registration response exceeded 64 KiB', { outcome_unknown: true });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createGithubRegistration(config, fetchImpl = globalThis.fetch) {
  return async function register(repo, { signal } = {}) {
    repo = githubRepo.parse(repo);
    if (signal?.aborted) throw new GatewayError('cancelled', 'Cancelled before GitHub project registration', { outcome_unknown: false });
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await fetchImpl(config.serverUrl + GITHUB_REGISTRATION_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ repo }), signal: requestSignal, redirect: 'error', credentials: 'omit',
      });
      const body = await boundedBody(response);
      if (!response.ok) {
        throw new GatewayError('github_registration_failed',
          'Cloudroom GitHub registration returned HTTP ' + response.status + ': ' + body.slice(0, 2_000),
          { http_status: response.status, outcome_unknown: true });
      }
      let data;
      try { data = JSON.parse(body); }
      catch { throw new GatewayError('invalid_github_response', 'GitHub registration did not return JSON', { outcome_unknown: true }); }
      if (!projectId.safeParse(data?.projectId).success || data.projectId === PERSONAL_PROJECT_ID) {
        throw new GatewayError('invalid_github_response', 'GitHub registration returned an invalid project ID', { outcome_unknown: true });
      }
      return data.projectId;
    } catch (error) {
      const failure = error instanceof GatewayError ? error : new GatewayError(
        requestSignal.aborted ? (requestSignal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'github_registration_failed',
        'Cloudroom GitHub registration failed: ' + error.message, { outcome_unknown: true });
      failure.details = { ...failure.details, phase: 'repository_registration', github_repo: repo,
        guidance: 'No automatic retry. Inspect Cloudroom projects before resubmitting an uncertain registration. No local checkout fallback.' };
      throw failure;
    }
  };
}
