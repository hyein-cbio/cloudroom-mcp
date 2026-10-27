# cloudroom-mcp

[English](README.md) | [한국어](README.ko.md)

**Version 0.1.0 — initial release.** Distributed through GitHub; not published to npm.

A **Cloud-only stdio MCP server** wrapping `room-cli`. Local Pi/Devin clients submit
instructions and inspect results; agents and workspaces run on Cloudroom Cloud VMs.

- Exactly four tools: `thread_spawn`, `thread_tell`, `thread_get`, and `thread_stop`.
- Node.js 22+, no build step. Uses MCP SDK v2; legacy 2025-11-25 stdio connections are also tested.
- The Cloudroom control server must be running locally. **A local control server does not mean local agent execution.**
- Configure Cloud authentication and the chosen provider's authentication/runtime in Cloudroom beforehand. GitHub access is needed for repository-backed projects, not Personal.
- This repository provides the MCP server only. It does not create a SKILL or modify global MCP configuration.

## Upstream project

Cloudroom and `room-cli`: [davidondrej/cloudroom-core](https://github.com/davidondrej/cloudroom-core).
This repository is a separate MCP adapter that invokes `room-cli`. GitHub-only project registration uses one internal Cloudroom HTTP endpoint because the CLI does not expose that operation.

## Install and run

```bash
cd ~/orca/projects/cloudroom-mcp
npm ci
node server.mjs
```

No project configuration is required: the default is Personal (`proj_personal`), with no repository or base branch.
To override defaults, optionally copy `.env.example` to `.env` and run `node --env-file=.env server.mjs`.

When launched directly, a stdio server normally waits for input.
Only MCP JSON-RPC is written to stdout; logs and startup errors go to stderr.
`npm start` does not automatically load `.env`; use it with an already configured environment.

To allow a GitHub repository while keeping Personal as the default, put this in `.env`:

```dotenv
CLOUDROOM_ALLOWED_GITHUB_REPOS=owner/repository
```

Or set `CLOUDROOM_GITHUB_REPO=owner/repository` to make that repository the default and automatically allow it.
No local clone, machine source connection, project ID lookup, or manual project creation is needed.

## Defaults and options

| Setting | Default | How to override |
|---|---|---|
| machine | `cloud` | Cloud only; Local/native execution is intentionally excluded |
| base_branch | Omitted | Repository projects only: spawn input or `CLOUDROOM_DEFAULT_BASE_BRANCH`; never sent for Personal |
| provider | `acp-devin` | Spawn/tell input or `CLOUDROOM_DEFAULT_PROVIDER` |
| model | `gpt-6-1-sol-high` | Spawn/tell input or `CLOUDROOM_DEFAULT_MODEL` |
| reasoning_level | `high` | Spawn/tell input or `CLOUDROOM_DEFAULT_REASONING_LEVEL` |
| github_repo | Omitted → Personal (`proj_personal` internally) | Optional `CLOUDROOM_GITHUB_REPO`; tool overrides must be allowlisted GitHub `owner/repository` identifiers |

An unset or blank `CLOUDROOM_GITHUB_REPO` selects Personal. The default repository is automatically allowlisted;
additional repositories use the comma-separated `CLOUDROOM_ALLOWED_GITHUB_REPOS` setting. With neither setting, only Personal is allowed.
The get/tell/stop tools verify the Cloud target and the project's current GitHub remote, not its display name or a remembered project ID.

Only `owner/repository` is accepted as repository input. URLs, SSH clone strings, `.git` suffixes, project IDs, project names, and local paths are rejected.
Identifiers are compared case-insensitively. Invalid or inaccessible repository selections never fall back to Personal or local execution.
The old `project` tool argument and nonblank `CLOUDROOM_PROJECT_ID` / `CLOUDROOM_ALLOWED_PROJECT_IDS` settings are rejected; migrate to GitHub identifiers.

Personal has no repository: server-level branch defaults are ignored, and explicitly supplying `base_branch` for Personal is rejected before any CLI call.
For repository projects, an omitted branch uses Cloudroom's own default unless `CLOUDROOM_DEFAULT_BASE_BRANCH` is configured.

**The controlling LLM can specify options according to the user's instructions.**
Defaults are also provided in tool descriptions and server instructions.
Omitted execution options use **server defaults**, not the thread's existing settings.
When choosing another provider, also supply a compatible `model` and `reasoning_level`.
Cloudroom and the provider perform final model validation; this adapter does not guess or rewrite model IDs.

Devin's CLI provider ID is `acp-devin`, including for Cloud execution. This differs from its internal harness name, `devin`.
In testing, `gpt-6.1-sol` was rejected, while `gpt-6-1-sol-high` completed a response.
Reasoning is always passed explicitly with `--reasoning-level`, independently of a model ID's `high` suffix.

Cloud execution uses full permissions. Input validation in this server does not give the remote agent a restricted permission mode.
Executing requests may consume your account's model and Cloud usage.

## Tools

### thread_spawn

```json
{
  "request_id": "b8f7774e-6e7c-42d8-bd16-35b2a3adc22e",
  "prompt": "Inspect the repository and summarize its tests.",
  "title": "GitHub repository check",
  "github_repo": "owner/repository",
  "machine": "cloud",
  "provider": "acp-devin",
  "model": "gpt-6-1-sol-high",
  "reasoning_level": "high"
}
```

Required: `request_id` (UUID), `prompt`. Optional: `title`, `github_repo`, and the execution options above.
Omit `github_repo` with no server default repository to work in Personal.

For a GitHub repository, the server:
1. Checks the repository allowlist and looks up Cloudroom projects by GitHub remote metadata.
2. Reuses a matching project; duplicate matches fail rather than selecting arbitrarily.
3. If missing, registers the repository with `POST /api/v1/cloudroom/account/repo-suggestions/github`, body `{"repo":"owner/repository"}`.
4. Verifies that the returned project's GitHub remote matches, then supplies its internal ID to Cloud `thread spawn`.

The registration endpoint is internal and may change between Cloudroom versions. It can create a remote-only project or reuse/unhide an existing one.
No `project create --root`, `project source add`, or local clone/attachment command is used.
`repository_registration_used` reports whether the HTTP registration path was needed, not whether a new project was definitely created.
Registration success is not proof that Cloud can access/clone the repository; inspect later thread errors as well.
If a later step fails, registration is not rolled back; errors identify the phase and known partial changes.

Generate a UUID once per logical creation. If the outcome is uncertain because of a lost response or timeout,
reuse **the same UUID, options, and prompt**. Do not blindly create another thread with a new UUID.
The adapter uses Cloudroom's request ID handling and never retries automatically.
ID conflicts and recovery of an already-created thread follow Cloudroom's behavior.

Returns the thread ID and submission status without waiting for completion.
Successful creation does not mean initialization or the task has completed.

### thread_tell

```json
{
  "thread_id": "thr_example",
  "prompt": "Print the output of pwd && ls -la.",
  "model": "gpt-6-1-sol-high",
  "reasoning_level": "high",
  "mode": "queue"
}
```

Required: `thread_id`, `prompt`. Optional: `provider`, `model`, `reasoning_level`,
and `mode` (`queue` by default, `steer`, or `auto`).

Execution order:

1. Verify the Cloud target, allowed GitHub remote (or Personal), and current execution settings. If settings must change,
   inspect the interaction list directly and block pending/resolving interactions.
2. Run `thread update` only if settings differ and the thread is idle/error with no queued messages or pending interactions.
3. Confirm the updated settings with `thread show`.
4. Send `thread tell` with explicit model and reasoning options.

A provider/model change **may replace the native agent session while retaining the Cloudroom thread and history**.
Check `settings_updated` and `native_session_may_have_changed` in the result.
Another controller or the GUI may change settings concurrently, resulting in HTTP 409 or another error.
The adapter reports these errors instead of silently resending.

The CLI does not expose an idempotency key for tell. Blindly resending after a timeout may duplicate an instruction.
A `sent` or `queued` result is not proof of task completion.
If submission fails after a settings change, the error includes `phase` and `settings_updated`. There is no automatic rollback.

### thread_get

```json
{ "thread_id": "thr_example", "after_seq": 0, "event_limit": 20 }
```

Returns thread status, resolved `github_repo` (null for Personal), CLI execution settings, latest available output, errors, and an event page.
`event_limit` is 1–100, default 20. Pass `next_after_seq` as the next call's `after_seq`.
Continue paging while `possibly_more_events=true`. This conservatively indicates a full page,
so one additional empty page is possible.

**`latest_available_output` may belong to an earlier turn.**
After submitting a prompt, correlate event `request_id` values with actual terminal/error events.
Event types and data come from the CLI. `completion_verified` is always false:
the adapter does not guarantee that a particular request succeeded merely because the thread is idle or output exists.

Observations are not an atomic snapshot. `snapshot_changed=true` indicates that the observed state changed between reads.
Check CLI execution settings together with actual responses/errors instead of trusting GUI labels alone.
An agent's self-reported model identity is not independent proof of the model used, either.

Output is limited to 16,000 characters; output errors and the last error are each limited to 8,000 characters.
Truncation is explicitly marked. Large event data is returned as a bounded JSON string preview with `data_truncated=true`.
Event sequence numbers and request IDs are preserved even when event data is truncated.

### thread_stop

```json
{ "thread_id": "thr_example" }
```

Requests a stop only. It does not archive/delete the thread or destroy the VM.
Errors such as `process unavailable` are not converted into success.
Disconnecting MCP or cancelling an MCP call also does not automatically stop remote work.

## Safeguards

- Execute an absolute executable path with an argv array, without a shell. Prompts are passed so they cannot become CLI options.
- Default CLI path: `~/.local/bin/room-cli`. `CLOUDROOM_CLI_PATH` accepts an absolute path only.
- `CLOUDROOM_SERVER_URL` accepts loopback HTTP origins only. Default: `http://127.0.0.1:39886`.
- Strip the calling Pi/Devin's `ROOM_*` and automation context, and use the configured control server.
- No Local fallback, file uploads, local checkout transfer, arbitrary CLI flags, automatic approvals, or archive/delete tools.
- GitHub registration sends JSON only to the configured loopback control server, without cookies, redirect following, or automatic retries. Its response is limited to 64 KiB.
- Default total operation deadline: 45 seconds, including repository lookup/registration and CLI calls. Configure 100–120000ms with `CLOUDROOM_TIMEOUT_MS`.
  Set the client's MCP timeout higher than this value, for example 60 seconds with the default deadline.
- CLI stdout/stderr are limited to 1 MiB per stream. Failures are returned as structured MCP errors.
  `outcome_unknown=true` means the absence of remote side effects cannot be guaranteed.
- No automatic write retries. Treat stderr and remote agent output as untrusted data.
- Exclusive OS file locks prevent simultaneous mutations of the same thread/request and competing registration of the same GitHub repository across separate MCP processes.
  A competing request fails with `operation_locked` instead of waiting or retrying.
  Independent GUI/CLI actions do not participate in these locks; Cloudroom's final errors are still reported.
- Prompts and remote output may be stored in Cloudroom, and prompts can also appear in process argv.
  Do not place credentials in prompts/options; use Cloudroom's authentication/secret mechanisms.

### Recovering locks

The default lock directory is `~/.local/state/cloudroom-mcp/locks`.
Use the same directory for Pi and Devin. Override it with an absolute `CLOUDROOM_LOCK_DIR` if needed.

A forcibly terminated process can leave a lock behind. Locks are deliberately not stolen automatically.
Inspect the pid, key, and creation time in the error's `lock_path` file.
Remove that specific file manually **only after confirming the process has exited and checking whether the remote instruction was accepted**.
Do not blindly empty the directory or delete a live process's lock.

## Add to a coding agent's MCP configuration

### 1. Install the server dependencies

In your local clone of this repository:

```bash
cd /absolute/path/to/cloudroom-mcp
npm ci
node --version
room-cli --version
```

Use Node.js 22 or later and keep the repository at a stable path.
No build, global npm installation, separate background service, or Pi extension package is required.
The coding agent launches this stdio server as its child process.
The local Cloudroom control server must still be running, with Cloud/provider authentication ready.

### 2. Register a local stdio MCP server

For clients using the `mcpServers` JSON format, merge this entry into the client's MCP settings:

```json
{
  "mcpServers": {
    "room": {
      "command": "node",
      "args": [
        "/absolute/path/to/cloudroom-mcp/server.mjs"
      ]
    }
  }
}
```

Replace the placeholder path with the actual location of `server.mjs`; do not overwrite other servers.
`command` is one executable, and `args` is an array—not a shell command.
If a GUI client cannot find `node` on PATH, set `command` to your Node executable's absolute path.
Register `server.mjs`, **not `room-cli` directly**: the CLI itself does not speak MCP.
This server uses **stdio**, so do not configure it as an HTTP MCP server or use the Cloudroom control URL as its MCP URL.

Configuration locations and formats differ by agent. For example, some use a `servers` object or TOML instead of `mcpServers`.
Use the same executable, arguments, and environment with that client's documented format.
The common example deliberately omits Pi-specific `exposure` and client-specific timeout fields.

### 3. Optionally allow GitHub repositories

The minimal configuration above uses Personal and needs no environment variables.
To permit a repository while retaining Personal as the default, add an `env` object to the `room` entry with these values:

```json
{
  "CLOUDROOM_ALLOWED_GITHUB_REPOS": "owner/repository"
}
```

Use comma-separated `owner/repository` values to allow more than one repository.
Alternatively, set `CLOUDROOM_GITHUB_REPO=owner/repository` to select a default repository and automatically allow it.

If you prefer an .env file, copy `.env.example` to `.env`, edit it, then use this server entry:

```json
{
  "command": "node",
  "args": [
    "--env-file=/absolute/path/to/cloudroom-mcp/.env",
    "/absolute/path/to/cloudroom-mcp/server.mjs"
  ]
}
```

An .env file is not loaded unless you pass `--env-file` (or otherwise supply its values to the process).
Restart/reload the coding agent's MCP connections after editing the configuration.
If the client supports request timeouts, use more than the server's default 45-second deadline, for example 60 seconds; follow that client's timeout units.
Confirm that it discovers `thread_spawn`, `thread_tell`, `thread_get`, and `thread_stop`.
Discovery alone does not create a Cloud task.

## Install and connect in Pi

This is an external MCP server, not a Pi extension/package. Use Pi's built-in MCP support;
`pi install` is not needed for this repository.

### 1. Install dependencies and register

Run `npm ci` in the server repository once, as shown above. For Personal-only use:

```bash
pi mcp add room --exposure direct -- node /absolute/path/to/cloudroom-mcp/server.mjs
pi mcp list
pi
```

`--exposure direct` makes the four tools directly available to the model.
Pi writes the registration to `~/.pi/agent/mcp.json` and launches the server when needed; do not run a separate copy manually.
If `room` already exists, `pi mcp add room` replaces that entry, so inspect existing settings before re-registering.
It does not replace other named servers.

To allow a GitHub repository while keeping Personal as the default, use this registration **instead**:

```bash
pi mcp add room --exposure direct \
  --env CLOUDROOM_ALLOWED_GITHUB_REPOS=owner/repository \
  -- node /absolute/path/to/cloudroom-mcp/server.mjs
pi mcp list
```

To make that repository the default, use `--env CLOUDROOM_GITHUB_REPO=owner/repository` instead.
`--env` is repeatable for other server settings.
You can also pass `--env-file=/absolute/path/to/cloudroom-mcp/.env` after `node` and before the script path.

### 2. Check an existing Pi session

After registering or changing the server outside Pi:

```text
/reload
/mcp
```

Check that `room` is connected and lists all four tools.
Pi exposes their names as `mcp__room__thread_spawn`, `mcp__room__thread_tell`,
`mcp__room__thread_get`, and `mcp__room__thread_stop`.
`pi mcp list` checks all configured servers and prints connection errors; it does not run an agent task.

### 3. Manual or project-local configuration

Alternatively, merge the Pi-specific entry from `mcp.example.json` into `~/.pi/agent/mcp.json`,
replace the server path, and run `/reload`. That sample includes Pi's `exposure: "direct"` and a 60-second `timeout`.

For project-local registration, run `pi mcp add room --local ...` from the **coding project's directory**.
This writes `.pi/mcp.json` there, not in the MCP server's installation directory.
Pi loads project-local MCP configuration only after the coding project is trusted.

### Troubleshooting

- `node` not found: use an absolute Node executable path in the registration.
- `room-cli` not found/not executable: set `CLOUDROOM_CLI_PATH` to the actual absolute executable path.
- Cannot reach Cloudroom: start its local control server and check `CLOUDROOM_SERVER_URL`.
- `repository_not_allowed`: configure `CLOUDROOM_ALLOWED_GITHUB_REPOS` or `CLOUDROOM_GITHUB_REPO`, then reload.
- `pi mcp add` is unavailable: check `pi mcp add --help` and use a Pi version with built-in MCP support.

## GitHub sources and non-goals

This adapter does not send local cloned repositories or uncommitted files to Cloud.
Personal needs no repository or branch. For repository-backed projects, the observed Cloud initialization clones GitHub,
and an optional `base_branch` selects a remote ref.
Pushing to GitHub is needed only when you want local changes to be available to the Cloud workspace;
you do not need to push for every follow-up sent to an existing Cloud thread.
Local execution and local source synchronization are deferred features.

## Verification

```bash
npm run check
npm test
npm audit --omit=dev
```

Tests use a fake room-cli and **do not automatically create paid Cloud workloads**.
They cover argv/context isolation, strict GitHub identifiers, repository lookup/registration and allowlists, settings update ordering,
errors/timeouts/cancellation, redirect refusal, prevention of automatic duplicate retries, locks, event pagination,
a real stdio MCP client, and the legacy handshake. Registration integration tests use a local mock HTTP server, not the real Cloudroom API.

A live Cloud read was verified through MCP client → server → room-cli during the initial implementation.
The GitHub registration path is validated with a mock HTTP server, not a live registration POST.
Implementation verification does not create remote workloads or modify real projects/threads.
