# Changelog

## 0.1.1 — 2026-11-06

### Added

- Public npm distribution with the `cloudroom-mcp` executable and version-pinned `npx` setup for MCP clients.
- Repository metadata, English/Korean onboarding, explicit Cloudroom prerequisites and tested-version guidance.
- Packaging regression tests that exclude local indexes, credentials, tests, and CI files from the tarball.
- Parallel Node.js 22 checks and tests in one shared Modal CI app, plus offline dispatcher regression tests.

### Fixed

- Bind spawn titles as `--title=value` so leading dashes cannot become CLI options.
- Read the MCP server version from `package.json` to prevent release-version drift.
- Limit npm package contents to runtime modules and public documents/examples with a `files` allowlist.
- Report Cloudroom's `caller_proof_required` rejection as `github_registration_requires_approval` with manual recovery guidance, without bypassing host access controls or retrying.

### Compatibility

- Requires Node.js 22+ and a separately configured Cloudroom installation.
- Release validation targets Cloudroom 142.0.0 / room-cli v142. The GitHub registration API is internal and may change.
- Existing provider/model/reasoning defaults are unchanged; configure a compatible preset for your own account.
- Live Personal spawn/tell/get/stop succeeded with Codex (`gpt-6.1-sol`, `low`). Automatic GitHub registration was refused by v142's caller-proof gate; users must register missing repositories in the trusted Cloudroom app. Successful live GitHub registration/clone is not verified.

## 0.1.0 — 2026-10-27

- Initial GitHub-only release under the MIT license.
- Four Cloud-only stdio MCP tools: spawn, tell, get, and stop.
- Personal and allowlisted GitHub projects, guarded execution settings, explicit uncertain outcomes, and cross-process mutation locks.
