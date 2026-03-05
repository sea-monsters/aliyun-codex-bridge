# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-03-05

### Added
- Unit test suite (`npm run test:unit`) covering request/response translation, tool-call sanitization, multimodal mapping, `n>1` fallback policy, and response object compatibility fields.
- Non-stream upstream fallback path now emits `response.created` + `response.in_progress` + `response.completed` when client requests streaming Responses.

### Changed
- Responses→Chat mapping now forwards additional optional fields (`frequency_penalty`, `presence_penalty`, `seed`, `stop`, `n`, `logprobs`, `top_logprobs`, `parallel_tool_calls`, `user`, `modalities`, `audio`, `max_completion_tokens`, `response_format`).
- User multimodal content parts are normalized for Chat Completions compatibility (`text`, `image_url`, `input_audio`).
- Chat→Responses translation now aggregates multi-choice non-stream responses and includes usage normalization.
- Release cleanup now removes generated runtime/test artifacts under `logs/` (`*.log`, `*.json`, `*.sse`, `*.txt`, `*.tmp`) in addition to `response.log` and temp files.

### Fixed
- Tool-call compatibility hardened: normalize malformed `assistant.tool_calls`, enforce strict `assistant.tool_calls -> tool` adjacency, and safely handle late/fragmented function-call chunks.
- Added retry fallback with `n=1` for providers that reject `n>1` under thinking mode constraints.
- Response object fields (`previous_response_id`, `store`, `truncation`) now echo request values instead of fixed defaults.

## [0.1.1] - 2026-03-05

### Added
- Sanitized public validation report for this release (`CODEX_REPORT_v0.1.1.md`)

### Changed
- Model-family tool-choice strategy is now internalized in bridge translation/retry logic (`qwen*`/`minimax*`/`glm*` downgrade forced function tool choice to `auto`; `kimi*` keeps forced function tool choice)
- Streaming debug output (`LOG_STREAM_RAW=1`) now logs redacted chunk summaries for safer diagnostics

### Fixed
- Stream tool-call bridging now extracts calls from `delta.tool_calls`, `choice.message.tool_calls`, and `choice.tool_calls` to avoid empty output-item rounds in Codex
- Added `status` fields (`in_progress`/`completed`) for streamed and non-streamed `function_call` output items for better Responses API compatibility
- `function_call_output` inputs now require non-empty `call_id`/`tool_call_id`; invalid items are skipped to avoid malformed upstream tool messages
- Added one-shot retry with `tool_choice=auto` when upstream rejects forced object tool choice in thinking mode (HTTP 400)

## [0.1.0] - 2026-01-20

### Added
- Separate reasoning output items with content-part events (aligns with Responses API)
- Usage propagation from upstream streaming chunks when available

### Changed
- Output indices now follow creation order across message/reasoning/tool items
- response.completed now preserves tool-call items in non-streaming mode for parity with streaming
- response objects now inherit instructions/metadata/tool_choice/temperature/top_p from requests

### Fixed
- Avoid empty message items when tool-only rounds are suppressed

## [0.1.0] - 2026-01-19

### Added
- Raw upstream chunk logging (`LOG_STREAM_RAW`) for streaming diagnostics
- Output suppression toggles for tool-call rounds (`SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS`, `DEFER_OUTPUT_TEXT_UNTIL_DONE`)
- Auto-update on startup (checks npm latest and installs if newer; can be disabled via config)

### Fixed
- De-duplicate streaming deltas when providers emit full-content chunks
- Only suppress assistant output_text when finish_reason is tool_calls (avoid hiding short final replies)
- Route suppressed tool-call round text into reasoning stream so it remains visible

## [0.1.0] - 2026-01-16

### Fixed
- Do not include function_call items in response.completed output (restore local tool execution)

### Changed
- Forward reasoning controls to upstream and accept reasoning text from alternative fields

### Docs
- Document reasoning passthrough and reasoning_text events
- Clarify that response.completed output excludes function_call items for local tool execution

### Docs
- Document reasoning passthrough and reasoning_text events
- Clarify that response.completed output excludes function_call items for local tool execution

## [0.1.0] - 2026-01-16

### Fixed
- Avoid empty output_text items in tool-only streaming responses
- Only emit output_text.done/content_part.done when output text exists

## [0.1.0] - 2026-01-16

### Fixed
- Handle streaming tool_calls without `index` by assigning a stable fallback index
- Improve tool name logging when tools define top-level `name`

## [0.1.0] - 2026-01-16

### Fixed
- Normalize `bin` path and repository URL for npm publish compatibility

## [0.1.0] - 2026-01-16

### Added
- Auto-enable tool bridging when tool-related fields are present in the request
- Extra logging to surface `allowTools` and `toolsPresent` per request
- Debug tool summary logging (types and sample names)

### Fixed
- Correct output_index mapping for streaming tool call events
- Filter non-function tools to avoid upstream schema errors

### Changed
- README guidance for MCP/tools troubleshooting and proxy startup

## [0.1.0] - 2026-01-16

### Changed
- Replaced the README with expanded setup, usage, and troubleshooting guidance
- Clarified Codex provider configuration and proxy endpoint usage

## [0.1.0] - 2026-01-16

### Added
- Tool calling support (MCP/function calls) when `ALLOW_TOOLS=1`
- Bridging for `function_call_output` items to Chat `role: tool` messages
- Streaming support for `delta.tool_calls` with proper Responses API events
- Non-streaming support for `msg.tool_calls` in final response
- Tool call events: `response.output_item.added` (function_call), `response.function_call_arguments.delta`, `response.function_call_arguments.done`
- Automated tool call test in test suite

### Changed
- `translateResponsesToChat()` now handles `type: function_call_output` items
- `streamChatToResponses()` now detects and emits tool call events
- `translateChatToResponses()` now includes `function_call` items in output array

### Fixed
- Tool responses (from MCP/function calls) are now correctly forwarded to upstream as `role: tool` messages
- Function call items are now properly included in `response.completed` output array

## [0.1.0] - Previous

### Added
- Initial release with Responses API to Chat Completions translation
- Streaming support with SSE
- Health check endpoint
- Zero-dependency implementation
