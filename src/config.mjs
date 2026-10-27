import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { githubRepo, branch, modelId, providerId, reasoningLevel } from './schemas.mjs';

export function loadConfig(env = process.env) {
  for (const key of ['CLOUDROOM_PROJECT_ID', 'CLOUDROOM_ALLOWED_PROJECT_IDS']) {
    if (env[key]?.trim()) throw new Error(key + ' is no longer supported; use CLOUDROOM_GITHUB_REPO or CLOUDROOM_ALLOWED_GITHUB_REPOS with owner/repository values');
  }
  const defaultRepo = env.CLOUDROOM_GITHUB_REPO?.trim();
  const githubRepoDefault = defaultRepo ? githubRepo.parse(defaultRepo) : null;
  const configuredBranch = env.CLOUDROOM_DEFAULT_BASE_BRANCH?.trim();
  const allowedGithubRepos = new Set([
    ...(githubRepoDefault ? [githubRepoDefault] : []),
    ...(env.CLOUDROOM_ALLOWED_GITHUB_REPOS ?? '').split(',').map(value => value.trim())
      .filter(Boolean).map(value => githubRepo.parse(value)),
  ]);
  const cliPath = env.CLOUDROOM_CLI_PATH ?? join(homedir(), '.local/bin/room-cli');
  if (!isAbsolute(cliPath)) throw new Error('CLOUDROOM_CLI_PATH must be an absolute executable path');
  const configuredLockDir = env.CLOUDROOM_LOCK_DIR?.trim();
  if (configuredLockDir && !isAbsolute(configuredLockDir)) {
    throw new Error('CLOUDROOM_LOCK_DIR must be an absolute path');
  }
  const url = new URL(env.CLOUDROOM_SERVER_URL ?? 'http://127.0.0.1:39886');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CLOUDROOM_SERVER_URL must be a loopback HTTP origin without credentials');
  }
  const timeoutMs = Number(env.CLOUDROOM_TIMEOUT_MS ?? 45_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error('CLOUDROOM_TIMEOUT_MS must be an integer from 100 to 120000');
  }
  return {
    cliPath, serverUrl: url.origin, githubRepo: githubRepoDefault, allowedGithubRepos, timeoutMs,
    lockDir: configuredLockDir || join(homedir(), '.local/state/cloudroom-mcp/locks'),
    defaults: {
      machine: 'cloud',
      base_branch: configuredBranch ? branch.parse(configuredBranch) : null,
      provider: providerId.parse(env.CLOUDROOM_DEFAULT_PROVIDER ?? 'acp-devin'),
      model: modelId.parse(env.CLOUDROOM_DEFAULT_MODEL ?? 'gpt-6-1-sol-high'),
      reasoning_level: reasoningLevel.parse(env.CLOUDROOM_DEFAULT_REASONING_LEVEL ?? 'high'),
    },
  };
}

export async function checkExecutable(config) {
  await access(config.cliPath, constants.X_OK);
}

export function cliEnvironment(config, env = process.env) {
  // Do not inherit a controller thread's identity, executable redirection or automation linkage.
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('ROOM_') && !key.startsWith('BB_AUTOMATION_') && key !== 'HERDR_ENV'));
  return { ...clean, ROOM_SERVER_URL: config.serverUrl };
}
