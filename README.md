# Aliyun Codex Bridge

> Local proxy that translates OpenAI **Responses API** ↔ Z.AI **Chat Completions** for Codex CLI

[![npm](https://img.shields.io/npm/v/aliyun-codex-bridge?style=flat-square&logo=npm)](https://www.npmjs.org/package/aliyun-codex-bridge)
[![node](https://img.shields.io/node/v/aliyun-codex-bridge?style=flat-square&logo=node.js)](https://github.com/sea-monsters/aliyun-codex-bridge)
[![license](https://img.shields.io/npm/l/aliyun-codex-bridge?style=flat-square)](LICENSE)

---

## What It Solves

Newer **Codex CLI** versions speak the OpenAI **Responses API** (e.g. `/v1/responses`, with `instructions` + `input` + event-stream semantics).
Some gateways/providers (including Z.AI endpoints) only expose legacy **Chat Completions** (`messages[]`).

This proxy:
1. Accepts Codex requests in **Responses** format
2. Translates them to **Chat Completions**
3. Forwards to Z.AI
4. Translates back to **Responses** format (stream + non-stream)
5. Returns to Codex

**Without this proxy**, Codex may fail (example from upstream error payloads):
```json
{"error":{"code":"1214","message":"Incorrect role information"}}
```

> If you’re using **codex-termux** and a gateway that doesn’t fully match the Responses API, this proxy is the recommended compatibility layer.

---

## Features

- Responses API ↔ Chat Completions translation (request + response)
- Streaming support with SSE (Server-Sent Events)
- Health check endpoint (`/health`)
- Works on Linux/macOS/Windows (WSL) + Termux (ARM64)
- Reasoning passthrough (request `reasoning` + upstream reasoning text)
- **Optional tool/MCP bridging** (see “Tools / MCP” below)
- Zero/low dependencies (Node built-ins only, unless noted by package.json)

---

## Requirements

- **Node.js**: 18+ (native `fetch`)
- **Port**: 31415 (default, configurable)

---

## Installation

```bash
npm install -g aliyun-codex-bridge
```

---

## Quick Start

### 1) Start the Proxy

```bash
aliyun-codex-bridge
```

Default listen address:

- `http://127.0.0.1:31415`

### 2) Configure Codex

Add this provider to `~/.codex/config.toml`:

```toml
[model_providers.zai_proxy]
name = "ZAI via local proxy"
base_url = "http://127.0.0.1:31415"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 3000000
```

> Notes:
> - `base_url` is the server root. Codex will call `/v1/responses`; this proxy supports that path.
> - We keep `env_key = "OPENAI_API_KEY"` because Codex expects that key name. You can store your Z.AI key there.

### 3) Run Codex via the Proxy

```bash
export OPENAI_API_KEY="your-zai-api-key"
codex -m "GLM-4.7" -c model_provider="zai_proxy"
```

---

## Tools / MCP (optional)

Codex tool-calling / MCP memory requires an additional compatibility layer:
- Codex uses **Responses API tool events** (function call items + arguments delta/done, plus function_call_output inputs)
- Some upstream models/providers may not emit tool calls (or may emit them in a different shape)

This proxy can **attempt** to bridge tools automatically when the request carries tool definitions
(`tools`, `tool_choice`, or tool outputs). You can also force it on:

```bash
export ALLOW_TOOLS=1
```

Important:
- Tool support is **provider/model dependent**. If upstream never emits tool calls, the proxy can’t invent them.
- If tools are enabled, the proxy must translate:
  - Responses `tools` + `tool_choice` → Chat `tools` + `tool_choice`
  - Chat `tool_calls` (stream/non-stream) → Responses function-call events
  - Responses `function_call_output` → Chat `role=tool` messages
- Non-function tool types are dropped for Z.AI compatibility.
- Function calls are emitted as stream events; final `response.completed` output includes message + function_call
  items in creation order for parity with streaming.

(See repo changelog and docs for the exact implemented behavior.)

---

## CLI Usage

```bash
# Start with defaults
aliyun-codex-bridge

# Custom port
aliyun-codex-bridge --port 8080

# Enable debug logging
aliyun-codex-bridge --log-level debug

# Custom Z.AI endpoint
aliyun-codex-bridge --ai-base-url https://api.z.ai/api/coding/paas/v4

# Show help
aliyun-codex-bridge --help
```

### Environment Variables

```bash
export HOST=127.0.0.1
export PORT=31415
export AI_BASE=https://api.z.ai/api/coding/paas/v4
export LOG_LEVEL=info
export AI_API_KEY=your-zai-api-key   # or AI_API_KEY_P / AI_API_KEY_A

# Optional
export ALLOW_TOOLS=1   # force tool bridging (otherwise auto-enabled when tools are present)
export ALLOW_SYSTEM=0  # optional: disable system-role passthrough
export SUPPRESS_REASONING_TEXT=1  # reduce latency by skipping reasoning stream
export ALLOW_MULTI_TOOL_CALLS=1   # process multiple tool_calls in one chunk (default: first only)
```

---

## Auto-start the Proxy with Codex (recommended)

Use a shell function that starts the proxy only if needed:

```bash
codex-with-zai() {
  local HOST="127.0.0.1"
  local PORT="31415"
  local HEALTH="http://${HOST}:${PORT}/health"
  local PROXY_PID=""

  if ! curl -fsS "$HEALTH" >/dev/null 2>&1; then
    ALLOW_TOOLS=1 aliyun-codex-bridge --host "$HOST" --port "$PORT" >/dev/null 2>&1 &
    PROXY_PID=$!
    trap 'kill $PROXY_PID 2>/dev/null' EXIT INT TERM
    sleep 1
  fi

  codex -c model_provider="zai_proxy" "$@"
}
```

Usage:

```bash
export OPENAI_API_KEY="your-zai-api-key"
codex-with-zai -m "GLM-4.7"
```

---

## API Endpoints

- `POST /responses` — accepts Responses API requests
- `POST /v1/responses` — same as above (Codex default path)
- `GET /health` — health check

---

## Translation Overview

### Request: Responses → Chat

```js
// Input (Responses)
{
  "model": "GLM-4.7",
  "instructions": "Be helpful",
  "input": [{ "role": "user", "content": "Hello" }],
  "max_output_tokens": 1000
}

// Output (Chat)
{
  "model": "GLM-4.7",
  "messages": [
    { "role": "system", "content": "Be helpful" },
    { "role": "user", "content": "Hello" }
  ],
  "max_tokens": 1000
}
```

### Response: Chat → Responses (simplified)

```js
// Input (Chat)
{
  "choices": [{ "message": { "content": "Hi there!" } }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
}

// Output (Responses - simplified)
{
  "status": "completed",
  "output": [{ "type": "message", "content": [{ "type": "output_text", "text": "Hi there!" }] }],
  "usage": { "input_tokens": 10, "output_tokens": 5 }
}
```

---

## Reasoning Support

- If the Responses request includes `reasoning`, the proxy forwards it to upstream as `reasoning`
  (and `reasoning_effort` when `reasoning.effort` is set).
- Upstream reasoning text is accepted from any of: `reasoning_content`, `reasoning`, `thinking`, `thought`.
- The proxy emits `response.reasoning_text.delta` / `response.reasoning_text.done` events and includes
  `reasoning_text` content as a dedicated `reasoning` output item in `response.completed`.

## Troubleshooting

### 401 / “token expired or incorrect”
- Verify the key is exported as `OPENAI_API_KEY` (or matches `env_key` in config.toml).
- Make sure the proxy is not overwriting Authorization headers.

### 404 on `/v1/responses`
- Ensure `base_url` points to the proxy root (example: `http://127.0.0.1:31415`).
- Confirm the proxy is running and `/health` returns `ok`.

### MCP/tools not being called
- Check proxy logs for `allowTools: true` and `toolsPresent: true`.
- If `toolsPresent: false`, Codex did not send tool definitions (verify your provider config).
- If tools are present but the model prints literal `<function=...>` markup or never emits tool calls,
  your upstream model likely doesn’t support tool calling.
- If your provider rejects `system` role, set `ALLOW_SYSTEM=0`.

### 502 Bad Gateway
- Proxy reached upstream but upstream failed. Enable debug:
  ```bash
  LOG_LEVEL=debug aliyun-codex-bridge
  ```

---

## 🧪 Tests

This repo includes end-to-end validation assets for running Codex through the proxy:

- **Test suite:** [`CODEX_TEST_SUITE.md`](./CODEX_TEST_SUITE.md)
- **Latest report:** [`CODEX_REPORT_v0.1.0.md`](./CODEX_REPORT_v0.1.0.md)
- The report is sanitized and excludes local machine identifiers.

Notes:
- Interactive runs require a real TTY (`codex`).
- For automation/non-TTY environments, prefer `codex exec`.

---

## Versioning Policy

This repo follows **small, safe patch increments** while stabilizing provider compatibility:

- Keep patch bumps only: `0.1.0 → 0.1.0 → 0.1.0 → ...`
- No big jumps unless strictly necessary.

(See `CHANGELOG.md` for details once present.)

---

## License

Copyright (c) 2026 WellaNet.Dev<br>
See MIT [LICENSE](LICENSE) for details.<br>
Made in Italy 🇮🇹


