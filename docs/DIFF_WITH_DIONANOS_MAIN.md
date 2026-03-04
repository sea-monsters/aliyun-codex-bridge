# Diff Record vs DioNanos/zai-codex-bridge

Generated on: 2026-03-04  
Baseline: `https://github.com/DioNanos/zai-codex-bridge` `main` @ `e1a5392`

## Summary

- Modified files: 8
- Added local files (not in baseline): 2
- `git diff --stat dionanos/main`: 139 insertions, 303 deletions

## Modified Files

### `src/server.js`

- Rebranded header/log text from `zai-codex-bridge` to `aliyun-codex-bridge`.
- Replaced single upstream env var with prioritized base URL chain:
  `AI_BASE` -> `AI_BASE_URL` -> `ZAI_BASE_URL`.
- Changed role toggle default:
  `ALLOW_SYSTEM` now defaults to enabled (`!== '0'`).
- Added `FORCE_ENV_AUTH` (default enabled) to avoid forwarding caller auth unless explicitly allowed.
- Added `extractToolCallsFromChoice()`:
  supports `delta.tool_calls`, `choice.message.tool_calls`, `choice.tool_calls`.
- Added `normalizeToolName()` and broadened tool normalization:
  accepts non-function shapes, normalizes names, bridges `input_schema`.
- Changed `developer` role mapping:
  now maps to `system` when `ALLOW_SYSTEM` is enabled.
- Added `status` to function-call output items:
  `in_progress` for `response.output_item.added`,
  `completed` for `response.output_item.done` and non-streaming output.
- Auth env var family switched from `ZAI_API_KEY*` to `AI_API_KEY*` (+ fallback `OPENAI_API_KEY`).
- If no env auth and forwarding disabled, now fails fast with explicit missing-key error.
- Startup logging now prints `AI_BASE_URL`.
- File mode changed from `100755` to `100644`.

### `package.json`

- Package name changed:
  `@mmmbuto/zai-codex-bridge` -> `aliyun-codex-bridge`.
- Added second bin entry:
  `aliyun-codex-bridge` -> `bin/aliyun-codex-bridge`.
- Repository URL changed to:
  `https://github.com/sea-monsters/aliyun-codex-bridge.git`.

### `bin/zai-codex-bridge`

- Replaced full CLI implementation with thin wrapper:
  now only `require('./aliyun-codex-bridge')`.
- Previous in-file argument parser/help/update logic removed from this file and moved to shared/new CLI entry.

### `README.md`

- Project/package/repo names rebranded to `aliyun-codex-bridge`.
- Install/command examples switched from `zai-codex-bridge` to `aliyun-codex-bridge`.
- CLI option docs changed from `--zai-base-url` to `--ai-base-url` (with alias support noted elsewhere).
- Environment examples changed:
  `ZAI_BASE_URL` -> `AI_BASE`,
  `ZAI_API_KEY*` -> `AI_API_KEY*`.
- `ALLOW_SYSTEM` guidance inverted to disable on incompat providers (`ALLOW_SYSTEM=0`).

### `docs/guide.md`

- Rebranded all path/command references to `aliyun-codex-bridge`.
- Env var examples changed from `ZAI_API_KEY_*` to `AI_API_KEY_*`.
- Log file names and troubleshooting commands renamed accordingly.

### `scripts/test-curl.js`

- Rebranded script banner and comments to `aliyun-codex-bridge`.
- Switched auth env var lookup and messaging:
  `ZAI_API_KEY*` -> `AI_API_KEY*`.
- Authorization header now uses `AI_API_KEY` variable.

### `RELEASING.md`

- Rebranded package name in release docs.
- API key export sample changed to `AI_API_KEY`.
- Version policy examples changed to align with `0.1.0`.

### `CHANGELOG.md`

- Added unreleased fix notes for:
  1) stream tool-call extraction from multiple chunk shapes,
  2) `function_call` status fields for Responses API compatibility.

## Added Local Files (Not in Baseline)

### `bin/aliyun-codex-bridge`

- New primary CLI entry containing:
  argument parsing, help text, config loading, optional auto-update, and server bootstrap.
- Supports `--ai-base-url` and compatibility alias `--zai-base-url`.

### `package-lock.json`

- New npm lockfile (lockfileVersion 3) matching package metadata and bin entries.
