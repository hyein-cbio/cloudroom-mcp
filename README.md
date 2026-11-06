# cloudroom-mcp

[English](README.md) | [한국어](README.ko.md)

**Version 0.1.1.** Available on [npm](https://www.npmjs.com/package/cloudroom-mcp) and [GitHub Releases](https://github.com/hyein-cbio/cloudroom-mcp/releases). See [CHANGELOG.md](CHANGELOG.md).

Licensed under the [MIT License](LICENSE).

A **Cloud-only stdio MCP server** wrapping `room-cli`. Local Pi/Devin clients submit
instructions and inspect results; agents and workspaces run on Cloudroom Cloud VMs.

- Exactly four tools: `thread_spawn`, `thread_tell`, `thread_get`, and `thread_stop`.
- Node.js 22+, no build step. Uses MCP SDK v2; legacy 2025-11-25 stdio connections are also tested.
- The Cloudroom control server must be running locally. **A local control server does not mean local agent execution.**
- Configure Cloud authentication and the chosen provider's authentication/runtime in Cloudroom beforehand. GitHub access is needed for repository-backed projects, not Personal.
- This repository provides the MCP server only. It does not create a SKILL or modify global MCP configuration.

## Upstream project

Cloudroom and `room-cli`: [davidondrej/cloudroom-core](https://github.com/davidondrej/cloudroom-core).
This repository is an unofficial, independent MCP adapter that invokes `room-cli`; it is not maintained or endorsed by the Cloudroom project. GitHub-only project registration uses one internal Cloudroom HTTP endpoint because the CLI does not expose that operation.

## Install and run

Install Node.js 22+ and Cloudroom first. Start Cloudroom's local control server and configure Cloud/provider authentication.
**npm installs this adapter only**, not Cloudroom, `room-cli`, provider CLIs, or their credentials.

For an MCP client using `mcpServers`, merge this version-pinned entry into its settings:

```json
{
  "mcpServers": {
    "room": {
      "command": "npx",
      "args": ["--yes", "cloudroom-mcp@0.1.1"]
    }
  }
}
```

The client launches the server; no clone or global installation is needed. `npx` needs registry access on first use.
Use an absolute `npx` path if your GUI client cannot find it. Upgrade by explicitly changing the pinned version.
Pass options through the entry's `env` object; see [Defaults and options](#defaults-and-options).
The CLI is expected at `~/.local/bin/room-cli`; set `CLOUDROOM_CLI_PATH` to its absolute path otherwise.

To start it manually (it waits for MCP input):

```bash
npx --yes cloudroom-mcp@0.1.1
```

Alternatively, install from source:

```bash
git clone https://github.com/hyein-cbio/cloudroom-mcp.git
cd cloudroom-mcp
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
No local clone, machine source connection, or project ID lookup is needed. Missing-project registration may require setup in the trusted Cloudroom app; see [Compatibility and prerequisites](#compatibility-and-prerequisites).

## Compatibility and prerequisites

- Node.js **22+**; automated CI uses Node.js 22 on Linux. The release packaging and live checks also run on macOS.
- Release validation uses **Cloudroom 142.0.0 / room-cli v142**. This is a tested version, not a promise that all earlier or later versions work.
- The local control server must be running, Cloud must be ready, and the selected provider must be authenticated. Use `room-cli --version` and `room-cli cloud status --json` to inspect your setup.
- GitHub-backed tasks additionally need Cloudroom GitHub access. Only pushed remote content is available, not uncommitted local files.
- **Known v142 limitation:** automatic registration of a missing GitHub project may be refused with `caller_proof_required`. This adapter does not forge caller proof. Register the repository yourself in the trusted Cloudroom app first, then retry with the same spawn UUID and inputs after inspecting projects. Existing matching projects avoid the registration endpoint; Personal does not need it.
- The GitHub registration endpoint is internal and may change; recheck compatibility when updating Cloudroom. Do not use this adapter with an untrusted local control server.
- The default `acp-devin` / `gpt-6-1-sol-high` / `high` is a previously tested author preset, **not a universally available model**. Set `CLOUDROOM_DEFAULT_PROVIDER`, `CLOUDROOM_DEFAULT_MODEL`, and `CLOUDROOM_DEFAULT_REASONING_LEVEL` together for your account. Model availability is controlled upstream.

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
On v142, a host caller-proof requirement can block this POST. The server returns `github_registration_requires_approval` with guidance; it never adds proof headers, changes permissions, retries, or falls back to Personal. Register the repository yourself through the trusted Cloudroom app, inspect the resulting projects, and only then resubmit the same spawn UUID and inputs.
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

The npm configuration in [Install and run](#install-and-run) is the recommended path.
The following is the **source-checkout alternative**, useful for development or offline runtime after dependency installation.

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

### 1. Register the npm executable

For Personal-only use:

```bash
pi mcp add room --exposure direct -- npx --yes cloudroom-mcp@0.1.1
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
  -- npx --yes cloudroom-mcp@0.1.1
pi mcp list
```

To make that repository the default, use `--env CLOUDROOM_GITHUB_REPO=owner/repository` instead.
`--env` is repeatable for other server settings.
For the source-checkout alternative, run `npm ci` once and replace `npx --yes cloudroom-mcp@0.1.1` with `node /absolute/path/to/cloudroom-mcp/server.mjs`. In that form, you can pass `--env-file=/absolute/path/to/cloudroom-mcp/.env` after `node` and before the script path.

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
adjust its environment if needed, and run `/reload`. That sample includes Pi's `exposure: "direct"` and a 60-second `timeout`.

For project-local registration, run `pi mcp add room --local ...` from the **coding project's directory**.
This writes `.pi/mcp.json` there, not in the MCP server's installation directory.
Pi loads project-local MCP configuration only after the coding project is trusted.

### Troubleshooting

- `npx` or `node` not found: use the relevant executable's absolute path in the registration.
- `github_registration_requires_approval`: Cloudroom rejected the internal registration POST. Register the repository yourself in the trusted Cloudroom app, inspect projects, and resubmit the same spawn UUID and inputs. Do not bypass caller-proof checks.
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

GitHub Actions invokes Modal for pushes to `main` (including PR merges), same-repository pull requests, or manual runs.
Pushes to other branches or tags do not trigger this workflow; pull requests still trigger it regardless of the target branch.
The GitHub-hosted runner only checks out the commit and calls Modal; Node.js checks and tests run
in Modal containers, not on the GitHub runner. Each workflow invokes `modal run` once to create
one ephemeral app; checks and tests run in parallel in separate containers within that app.
Both use a cached Node.js 22 image with dependencies installed by `npm ci --include=dev`.
The check task runs the Python CI regression tests and `npm run check`; the test task runs `npm test`.
Both tasks finish even if one fails, and any failed build or task fails CI. New parallel tasks should
share this dispatcher/app rather than create a separate app per task. Superseded runs on the same ref are cancelled.

No GPU, Cloudroom credentials, real room-cli, or live Cloudroom services are required. Modal usage can incur costs.
Dependency auditing remains a separate manual check.

Before enabling CI, add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` as repository Actions secrets,
or organization Actions secrets with access granted to this repository. Missing credentials fail the job
with a setup error. Fork pull requests are skipped because they cannot access these secrets;
do not use `pull_request_target` to execute untrusted PR code with credentials. Only trusted changes
should run this workflow, since the checked-out Python CI definition executes with the Modal token.

To run the same remote check manually from the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r ci/requirements.txt
modal setup
modal run ci/modal_ci.py::run_tests
```

Use Python 3.11 for parity with CI. `modal setup` is interactive local authentication only;
GitHub Actions uses the token secrets instead. The first run builds the image. Later runs reuse
dependency layers when unchanged. Only `package.json`, `package-lock.json`, `server.mjs`, `src/`,
`test/`, the public package documents/examples (`README.md`, `README.ko.md`, `LICENSE`, `CHANGELOG.md`, `.env.example`, `mcp.example.json`), `ci/modal_ci.py`, and `ci/test_modal_ci.py` are explicitly uploaded as test inputs,
not local `.env`, `.git`, or `node_modules/`. To test the dispatcher offline after installing
`ci/requirements.txt`, run `python -m unittest discover -s ci -p 'test_*.py'`; this starts no Modal app.

For local verification without Modal:

```bash
npm run check
npm test
npm audit --omit=dev
```

Tests use a fake room-cli and **do not automatically create paid Cloudroom workloads**. Packaging regression tests verify the executable metadata, version consistency, and an exact public-file allowlist, including exclusion of local index DBs, credentials, and development files.
They cover argv/context isolation, strict GitHub identifiers, repository lookup/registration and allowlists, settings update ordering,
errors/timeouts/cancellation, redirect refusal, prevention of automatic duplicate retries, locks, event pagination,
a real stdio MCP client, and the legacy handshake. Registration integration tests use a local mock HTTP server, not the real Cloudroom API.

### 0.1.1 release validation (2026-11-06)

- A packed tarball was installed with production dependencies in a clean temporary directory, without a source checkout at runtime. Its installed executable completed the four-tool flow against a fake room-cli.
- A separately authorized, paid-capable live smoke test on macOS / Node.js 26.13.0 / Cloudroom 142.0.0 / room-cli v142 used Personal with `codex`, `gpt-6.1-sol`, and `low`. Creation, unique-marker responses, a follow-up, incremental events including `turn/completed`, and stop all succeeded through the installed package's MCP executable. Stop does not delete the VM or thread. This does not validate the default Devin preset on v142.
- A real GitHub registration POST was attempted and refused with HTTP 401 `caller_proof_required`; no Cloud thread was created for that GitHub request. Successful live registration/clone remains **unverified**. Success paths and the explicit caller-proof rejection are covered by mocks; no proof bypass or automatic fallback is implemented.
- Ordinary `npm test` and CI remain offline with respect to Cloudroom: they never create paid Cloud tasks. Live tests are an explicit release-maintainer action, not part of installation or the default test suite.
