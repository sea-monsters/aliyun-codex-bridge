# Z.AI GLM Proxy - Complete Guide

**Purpose**: Practical guide for using GLM-4.7 via Z.AI with Codex CLI through the `aliyun-codex-bridge` proxy.

---

## Quick Start

### First Time Setup

```bash
# 1. Install the proxy globally
cd ~/Dev/aliyun-codex-bridge
npm install -g .

# 2. Reload .zshrc for the new functions
source ~/.zshrc

# 3. Start Codex with GLM-4.7
codex-glm-a
```

### Daily Usage

```bash
# Start with account A
codex-glm-a

# Start with account P
codex-glm-p

# Exit Codex
Ctrl+D
# Proxy is automatically terminated
```

---

## Prerequisites

### 1. Environment Variables

Ensure you have API keys in your `.zshrc` or `.zshenv`:

```bash
# Z.AI API Keys
export AI_API_KEY_A="sk-your-key-account-a"
export AI_API_KEY_P="sk-your-key-account-p"
```

### 2. Proxy Installed

```bash
# Global installation (recommended)
cd ~/Dev/aliyun-codex-bridge
npm install -g .

# Verify installation
which aliyun-codex-bridge
```

### 3. Codex Configuration

The file `~/.codex/config.toml` must contain:

```toml
[model_providers.zai_glm_proxy]
name = "ZAI GLM via local proxy"
base_url = "http://127.0.0.1:31415/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
stream_idle_timeout_ms = 3000000
```

---

## How It Works

### Architecture

```
.zshrc → _codex_glm_with_proxy() → Codex → Proxy (port 31415) → Z.AI API
                                            ↓
                                    Translates:
                                    Responses → Chat
                                    Chat → Responses
```

### Execution Flow

1. User runs `codex-glm-a`
2. Function checks if proxy is active on port 31415
3. If NO:
   - Starts proxy in background
   - Saves PID
   - Sets trap for cleanup
   - Waits up to 2 seconds for proxy to be ready
4. Codex starts with provider `zai_glm_proxy`
5. Request: Codex → Proxy → Translated to Chat → Z.AI
6. Response: Z.AI → Chat → Proxy → Translated to Responses → Codex
7. User exits Codex (Ctrl+D)
8. Trap kills the proxy (only if this function started it)

---

## Usage Examples

### Example 1: Simple Conversation

```bash
# Start
codex-glm-a

# In Codex prompt:
> What is 23 * 47?

# GLM-4.7 responds:
> The result of 23 * 47 is 1081.

# Exit
Ctrl+D
# Proxy automatically terminated
```

### Example 2: Code Analysis

```bash
# Start with additional arguments
codex-glm-a -s workspace-write

# In Codex prompt:
> Read main.py and tell me what it does

# Codex will read the file and GLM-4.7 will analyze the code
```

### Example 3: Multi-Session

```bash
# Terminal 1
codex-glm-a
# Proxy starts (PID 12345)

# Terminal 2 (while terminal 1 is still open)
codex-glm-a
# Proxy ALREADY ACTIVE, gets reused
# No new process spawned

# Terminal 1: Ctrl+D
# Codex exits but proxy STAYS active (for terminal 2)

# Terminal 2: Ctrl+D
# Codex exits but proxy STAYS active (didn't start it)
```

### Example 4: Debug Proxy

```bash
# Start proxy manually with debug
aliyun-codex-bridge --log-level debug --port 31415

# In another terminal, test
curl http://127.0.0.1:31415/health
# {"ok":true}

# Now start codex manually
OPENAI_API_KEY="$AI_API_KEY_A" \
  codex -m "GLM-4.7" -c model_provider="zai_glm_proxy"
```

---

## Troubleshooting

### Proxy Won't Start

**Symptom**: `codex-glm-a` hangs or errors

**Solution**:
```bash
# Verify installation
which aliyun-codex-bridge

# If not found, reinstall
cd ~/Dev/aliyun-codex-bridge
npm install -g .
```

### Port Already in Use

**Symptom**: `Error: listen EADDRINUSE: address already in use :::31415`

**Solution**:
```bash
# Find process
lsof -i :31415
# or
netstat -tulpn | grep 31415

# If it's an old proxy, kill it
kill -9 <PID>

# Or use different port - just use:
codex-glm-a  # will use existing proxy
```

### Z.AI Error 1214

**Symptom**: `{"error":{"code":"1214","message":"Incorrect role information"}}`

**Cause**: Using wrong provider

**Solution**:
```bash
# VERIFY in ~/.codex/config.toml
# You must use: model_provider="zai_glm_proxy"
# NOT: model_provider="zai"
```

### Proxy Won't Stop

**Symptom**: Proxy remains active after closing Codex

**Solution**:
```bash
# Find and kill manually
ps aux | grep aliyun-codex-bridge
kill <PID>

# Or use dedicated command
pkill -f aliyun-codex-bridge
```

### Debug Logging

```bash
# Proxy logs are in:
cat /tmp/aliyun-codex-bridge.log

# For real-time logs:
tail -f /tmp/aliyun-codex-bridge.log

# Restart with debug:
codex-glm-a  # proxy will write detailed logs
```

---

## Health Checks

### Health Check

```bash
# Verify proxy is active
curl http://127.0.0.1:31415/health
# Expected: {"ok":true}
```

### Verify Configuration

```bash
# Check provider in config
grep -A 5 "zai_glm_proxy" ~/.codex/config.toml

# Check functions in .zshrc
grep -A 30 "_codex_glm_with_proxy" ~/.zshrc
```

### Full Test

```bash
# 1. Test proxy
aliyun-codex-bridge --help

# 2. Test health
curl http://127.0.0.1:31415/health

# 3. Test Codex
codex-glm-a --help

# 4. Interactive test
codex-glm-a
# > Tell me 2+2
# Ctrl+D
```

---

## Function Reference

### `_codex_glm_with_proxy()`

**Parameters**:
- `$1` - API key to use (`$AI_API_KEY_A` or `$AI_API_KEY_P`)
- `$@` - Additional arguments passed to Codex

**Behavior**:
1. Checks health at `http://127.0.0.1:31415/health`
2. If fails:
   - Starts `aliyun-codex-bridge` in background
   - Redirects log to `/tmp/aliyun-codex-bridge.log`
   - Saves PID in `$PROXY_PID`
   - Sets trap to kill proxy on EXIT
   - Waits up to 2 seconds for proxy to be ready
3. Executes `codex` with provider `zai_glm_proxy`

### `codex-glm-a()`

**Usage**: Account A
```bash
codex-glm-a [codex options]
```

**Example**:
```bash
codex-glm-a -s workspace-write
codex-glm-a --help
```

### `codex-glm-p()`

**Usage**: Account P
```bash
codex-glm-p [codex options]
```

---

## Advanced Configuration

### Change Port

Modify the function in `~/.zshrc`:

```bash
_codex_glm_with_proxy () {
  local KEY="$1"; shift
  local HOST="127.0.0.1"
  local PORT="8080"  # ← Change here
  # ...
}
```

And update `~/.codex/config.toml`:

```toml
[model_providers.zai_glm_proxy]
base_url = "http://127.0.0.1:8080/v1"
```

### Verbose Logging

Modify the log level in the proxy command:

```bash
aliyun-codex-bridge --host "$HOST" --port "$PORT" --log-level debug >"$LOGFILE" 2>&1 &
```

---

## Performance

### Startup Times

| Operation | Time |
|-----------|------|
| Health check (proxy running) | ~50ms |
| Health check (proxy not running) | ~2s |
| Proxy startup | ~500ms |
| Codex startup | ~1s |
| **Total (first time)** | **~3.5s** |
| **Total (proxy already up)** | **~1.5s** |

### Memory

| Process | RAM |
|----------|-----|
| aliyun-codex-bridge | ~30-50MB |
| codex CLI | ~100-200MB |
| **Total** | **~130-250MB** |

---

## Setup Checklist

- [ ] Proxy installed: `npm install -g aliyun-codex-bridge`
- [ ] API keys set: `export AI_API_KEY_A=...`
- [ ] Provider configured: `[model_providers.zai_glm_proxy]` in config.toml
- [ ] Functions updated: `source ~/.zshrc`
- [ ] Test health: `curl http://127.0.0.1:31415/health`
- [ ] Full test: `codex-glm-a`

---

## Related Files

- **Proxy Code**: `~/Dev/aliyun-codex-bridge/`
- **Codex Config**: `~/.codex/config.toml`
- **ZSH Functions**: `~/.zshrc`

---

## License

MIT


