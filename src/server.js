#!/usr/bin/env node

/**
 * aliyun-codex-bridge
 *
 * Local proxy that translates OpenAI Responses API format to Coding Plan Dashscope Chat Completions format.
 * Allows Codex to use Coding Plan Dashscope models through the /responses endpoint.
 *
 * Author: Davide A. Guglielmi
 * License: MIT
 */

const http = require('http');
const { randomUUID } = require('crypto');

// Configuration from environment
const PORT = parseInt(process.env.PORT || '31415', 10);
const HOST = process.env.HOST || '127.0.0.1';
const AI_BASE_URL =
  process.env.AI_API_BASE ||
  'https://coding.dashscope.aliyuncs.com/v1';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'glm-4.7';
const LOG_STREAM_RAW = process.env.LOG_STREAM_RAW === '1';
const LOG_STREAM_MAX = parseInt(process.env.LOG_STREAM_MAX || '800', 10);
const SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS = process.env.SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS === '1';
const DEFER_OUTPUT_TEXT_UNTIL_DONE = process.env.DEFER_OUTPUT_TEXT_UNTIL_DONE === '1';
const SUPPRESS_REASONING_TEXT = process.env.SUPPRESS_REASONING_TEXT === '1';
const ALLOW_MULTI_TOOL_CALLS = process.env.ALLOW_MULTI_TOOL_CALLS !== '0';

// Env toggles for compatibility
// Default true: preserve system/developer roles unless explicitly disabled.
const ALLOW_SYSTEM = process.env.ALLOW_SYSTEM !== '0';
const ALLOW_TOOLS_ENV = process.env.ALLOW_TOOLS === '1';
// Default true: do not forward incoming Authorization to upstream.
const FORCE_ENV_AUTH = process.env.FORCE_ENV_AUTH !== '0';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Generate a random request ID for logging
 */
function generateRequestId() {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function createSseEmitter(writeFn) {
  let seq = 1;
  return (obj) => {
    if (obj.sequence_number == null) obj.sequence_number = seq++;
    writeFn(obj);
  };
}

function extractToolCallsFromChoice(choice, delta) {
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    return delta.tool_calls;
  }
  if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    return choice.message.tool_calls;
  }
  if (Array.isArray(choice?.tool_calls) && choice.tool_calls.length > 0) {
    return choice.tool_calls;
  }
  return null;
}

/**
 * Lightweight validation for Requests API format
 * Returns { valid: boolean, errors: string[] }
 */
function validateRequest(request, format) {
  const errors = [];

  if (format === 'responses') {
    if (request.instructions !== undefined && typeof request.instructions !== 'string') {
      errors.push('instructions must be a string');
    }

    if (request.input !== undefined) {
      if (typeof request.input !== 'string' && !Array.isArray(request.input)) {
        errors.push('input must be a string or array');
      } else if (Array.isArray(request.input)) {
        for (const item of request.input) {
          if (item?.type === 'function_call_output') {
            const callId = item.call_id || item.tool_call_id;
            if (!callId || typeof callId !== 'string' || !callId.trim()) {
              errors.push('function_call_output item requires non-empty call_id (or tool_call_id)');
              break;
            }
          }
        }
      }
    }

    if (request.model !== undefined && typeof request.model !== 'string') {
      errors.push('model must be a string');
    }

    if (request.tools !== undefined) {
      if (!Array.isArray(request.tools)) {
        errors.push('tools must be an array');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Build a response.failed SSE event
 */
function buildResponseFailed({
  responseId,
  model,
  createdAt,
  errorCode,
  errorMessage,
  responsesRequest = null,
  input = [],
  tools = [],
  usage = null,
}) {
  const response = buildResponseObject({
    id: responseId,
    model,
    status: 'failed',
    created_at: createdAt,
    completed_at: null,
    input: input || responsesRequest?.input || [],
    output: [],
    tools: tools || responsesRequest?.tools || [],
    request: responsesRequest || null,
    usage,
    error: {
      code: errorCode,
      message: errorMessage,
    },
  });

  return {
    type: 'response.failed',
    response,
  };
}

function buildResponseObject({
  id,
  model,
  status,
  created_at,
  completed_at = null,
  input = [],
  output = [],
  tools = [],
  request = null,
  usage = null,
  error = null,
}) {
  const instructions = request?.instructions ?? null;
  const max_output_tokens = request?.max_output_tokens ?? null;
  const metadata = request?.metadata ?? {};
  const text = request?.text ?? { format: { type: 'text' } };
  const tool_choice = request?.tool_choice ?? 'auto';
  const temperature = request?.temperature ?? 1;
  const top_p = request?.top_p ?? 1;
  const user = request?.user ?? null;
  const reasoning_effort = request?.reasoning?.effort ?? null;

  // Struttura compatibile con Responses API per Codex CLI
  return {
    id,
    object: 'response',
    created_at,
    status,
    completed_at,
    error,
    incomplete_details: null,
    input,
    instructions,
    max_output_tokens,
    model,
    output,
    previous_response_id: null,
    reasoning_effort,
    store: false,
    temperature,
    text,
    tool_choice,
    tools,
    top_p,
    truncation: 'disabled',
    usage,
    user,
    metadata,
  };
}

/**
 * Logger
 */
function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[LOG_LEVEL]) {
    console.error(`[${level.toUpperCase()}]`, new Date().toISOString(), ...args);
  }
}

/**
 * Build a redacted upstream chunk preview for diagnostics.
 * Avoids logging raw response content/reasoning text.
 */
function summarizeChunkForLog(chunk) {
  const choice = chunk?.choices?.[0] || {};
  const delta = choice?.delta || {};
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  return {
    object: chunk?.object,
    id: chunk?.id,
    model: chunk?.model,
    created: chunk?.created,
    finish_reason: choice?.finish_reason ?? null,
    has_content: typeof delta.content === 'string',
    content_len: typeof delta.content === 'string' ? delta.content.length : 0,
    has_reasoning: typeof extractReasoningText(delta) === 'string' && extractReasoningText(delta).length > 0,
    reasoning_len: (() => {
      const rt = extractReasoningText(delta);
      return typeof rt === 'string' ? rt.length : 0;
    })(),
    tool_calls: toolCalls.map((tc) => ({
      index: tc?.index ?? null,
      id: tc?.id ?? null,
      name: tc?.function?.name ?? null,
      args_len: typeof tc?.function?.arguments === 'string' ? tc.function.arguments.length : 0,
    })),
    has_usage: !!chunk?.usage,
  };
}

/**
 * Detect if request body is Responses format or Chat format
 */
function detectFormat(body) {
  if (body.instructions !== undefined || body.input !== undefined) {
    return 'responses';
  }
  if (body.messages !== undefined) {
    return 'chat';
  }
  return 'unknown';
}

/**
 * Detect if request carries tool-related data
 */
function requestHasTools(request) {
  if (!request || typeof request !== 'object') return false;

  if (Array.isArray(request.tools) && request.tools.length > 0) return true;
  if (request.tool_choice) return true;

  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!item) continue;
      if (item.type === 'function_call_output') return true;
      if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return true;
      if (item.tool_call_id) return true;
    }
  }

  if (Array.isArray(request.messages)) {
    for (const msg of request.messages) {
      if (!msg) continue;
      if (msg.role === 'tool') return true;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
      if (msg.tool_call_id) return true;
    }
  }

  return false;
}

function summarizeTools(tools, limit = 8) {
  if (!Array.isArray(tools)) return null;
  const types = {};
  const names = [];

  for (const tool of tools) {
    const type = tool?.type || 'unknown';
    types[type] = (types[type] || 0) + 1;
    if (names.length < limit) {
      if (type === 'function') {
        names.push(tool?.function?.name || tool?.name || '(missing_name)');
      } else {
        names.push(type);
      }
    }
  }

  return { count: tools.length, types, sample_names: names };
}

function summarizeToolShape(tool) {
  if (!tool || typeof tool !== 'object') return null;
  return {
    keys: Object.keys(tool),
    type: tool.type,
    name: tool.name,
    functionKeys: tool.function && typeof tool.function === 'object' ? Object.keys(tool.function) : null,
    functionName: tool.function?.name
  };
}

function isForcedFunctionToolChoice(toolChoice) {
  return !!(
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    toolChoice.function &&
    typeof toolChoice.function.name === 'string' &&
    toolChoice.function.name.trim()
  );
}

/**
 * Model family strategy for forced function tool_choice.
 * - qwen / minimax / glm: downgrade forced-object tool_choice to auto
 * - kimi: keep forced-object tool_choice
 */
function supportsForcedFunctionToolChoice(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith('kimi')) return true;
  if (m.startsWith('qwen')) return false;
  if (m.startsWith('minimax')) return false;
  if (m.startsWith('glm')) return false;
  return false;
}

function adaptToolChoiceForModel(model, toolChoice) {
  if (!toolChoice) {
    return { toolChoice, strategy: 'none', changed: false };
  }
  if (!isForcedFunctionToolChoice(toolChoice)) {
    return { toolChoice, strategy: 'passthrough', changed: false };
  }
  if (supportsForcedFunctionToolChoice(model)) {
    return { toolChoice, strategy: 'forced_function_supported', changed: false };
  }
  return { toolChoice: 'auto', strategy: 'forced_function_downgraded_to_auto', changed: true };
}

function shouldRetryWithAutoToolChoice(status, errorBody, upstreamBody) {
  if (status !== 400) return false;
  if (!isForcedFunctionToolChoice(upstreamBody?.tool_choice)) return false;
  const text = String(errorBody || '').toLowerCase();
  return (
    text.includes('tool_choice') &&
    text.includes('thinking mode') &&
    text.includes('object')
  );
}

/**
 * Flatten content parts to string - supports text, input_text, output_text
 */
function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter(p =>
        (p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text')) && p.text
      )
      .map(p => p.text);
    if (texts.length) return texts.join('\n');
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  if (content == null) return '';
  return String(content);
}

/**
 * Extract reasoning text from upstream payloads (message or delta).
 */
function extractReasoningText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const candidates = ['reasoning_content', 'reasoning', 'thinking', 'thought'];
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === 'string' && val.length) return val;
  }
  return '';
}

/**
 * Compute a safe incremental delta for providers that sometimes stream
 * the full content-so-far instead of true deltas.
 */
function computeDelta(prev, incoming) {
  if (!incoming) return { delta: '', next: prev };
  if (!prev) return { delta: incoming, next: incoming };

  // Full-content streaming: incoming is the full buffer so far.
  if (incoming.startsWith(prev)) {
    return { delta: incoming.slice(prev.length), next: incoming };
  }

  // Duplicate chunk (provider repeated last fragment).
  if (prev.endsWith(incoming)) {
    return { delta: '', next: prev };
  }

  // Overlap fix: avoid duplicated boundary text.
  const max = Math.min(prev.length, incoming.length);
  for (let i = max; i > 0; i--) {
    if (prev.endsWith(incoming.slice(0, i))) {
      const delta = incoming.slice(i);
      return { delta, next: prev + delta };
    }
  }

  // Fallback: treat as incremental.
  return { delta: incoming, next: prev + incoming };
}

function normalizeToolName(name, fallback = 'tool') {
  const base = String(name || fallback).trim().toLowerCase();
  const safe = base.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  if (!safe) return 'tool';
  if (/^[a-z_]/.test(safe)) return safe;
  return `tool_${safe}`;
}

function stringifyToolArguments(args) {
  if (typeof args === 'string') return args;
  if (args === undefined || args === null) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/**
 * Translate Responses format to Chat Completions format
 */
function translateResponsesToChat(request, allowTools, options = {}) {
  const messages = [];
  const knownToolCalls = new Map();

  // Add system message from instructions (with ALLOW_SYSTEM toggle)
  if (request.instructions) {
    if (ALLOW_SYSTEM) {
      messages.push({
        role: 'system',
        content: request.instructions
      });
    } else {
      // Prepend to first user message for Z.ai compatibility
      const instr = String(request.instructions).trim();
      if (messages.length && messages[0].role === 'user') {
        messages[0].content = `[INSTRUCTIONS]\n${instr}\n[/INSTRUCTIONS]\n\n${messages[0].content || ''}`;
      } else {
        messages.unshift({ role: 'user', content: `[INSTRUCTIONS]\n${instr}\n[/INSTRUCTIONS]` });
      }
    }
  }

  // Handle input: can be string (simple user message) or array (message history)
  if (request.input) {
    if (typeof request.input === 'string') {
      // Simple string input -> user message
      messages.push({
        role: 'user',
        content: request.input
      });
    } else if (Array.isArray(request.input)) {
      // Array of ResponseItem objects
      for (const item of request.input) {
        // Preserve function_call items as assistant tool_calls messages for upstream validation.
        if (allowTools && item.type === 'function_call') {
          const callId = item.call_id || item.id || `call_${randomUUID().replace(/-/g, '')}`;
          const name = normalizeToolName(item.name || 'tool');
          const argumentsText = stringifyToolArguments(item.arguments);
          const toolCall = {
            id: callId,
            type: 'function',
            function: {
              name,
              arguments: argumentsText
            }
          };
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall]
          });
          knownToolCalls.set(callId, {
            name,
            arguments: argumentsText
          });
          continue;
        }

        // Handle function_call_output items (tool responses) - only if allowTools
        if (allowTools && item.type === 'function_call_output') {
          const callId = item.call_id || item.tool_call_id || '';
          if (!callId) {
            log('warn', 'Skipping function_call_output item without call_id/tool_call_id');
            continue;
          }
          const lastMsg = messages.length ? messages[messages.length - 1] : null;
          const hasPrecedingToolCall =
            !!lastMsg &&
            lastMsg.role === 'assistant' &&
            Array.isArray(lastMsg.tool_calls) &&
            lastMsg.tool_calls.some(tc => tc && tc.id === callId);

          // Some providers reject tool messages unless they immediately follow assistant.tool_calls.
          if (!hasPrecedingToolCall && callId) {
            const known = knownToolCalls.get(callId);
            const syntheticName = normalizeToolName(known?.name || 'tool');
            const syntheticArgs = stringifyToolArguments(known?.arguments || '');
            messages.push({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: callId,
                  type: 'function',
                  function: {
                    name: syntheticName,
                    arguments: syntheticArgs
                  }
                }
              ]
            });
          }

          const toolMsg = {
            role: 'tool',
            tool_call_id: callId,
            content: ''
          };

          // Extract content from output or content field
          if (item.output !== undefined) {
            toolMsg.content = typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output);
          } else if (item.content !== undefined) {
            toolMsg.content = typeof item.content === 'string'
              ? item.content
              : JSON.stringify(item.content);
          }

          messages.push(toolMsg);
          continue;
        }

        // Only process items with a 'role' field (Message items)
        // Skip Reasoning, FunctionCall, LocalShellCall, etc.
        if (!item.role) continue;

        // Map non-standard roles to upstream-compatible roles
        // Upstream accepts: system, user, assistant, tool
        let role = item.role;
        if (role === 'developer') {
          role = ALLOW_SYSTEM ? 'system' : 'user';
        } else if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
          // Skip any other non-standard roles
          continue;
        }

        const msg = {
          role: role,
          content: flattenContent(item.content)
        };

        // Handle tool calls if present (only if allowTools)
        if (allowTools && item.tool_calls && Array.isArray(item.tool_calls)) {
          msg.tool_calls = item.tool_calls;
        }

        // Handle tool call ID for tool responses (only if allowTools)
        if (allowTools && item.tool_call_id) {
          msg.tool_call_id = item.tool_call_id;
        }

        messages.push(msg);
      }
    }
  }

  // Build chat request
  // Preserve model casing from client request for providers with case-sensitive model IDs.
  const model = request.model || DEFAULT_MODEL;
  const chatRequest = {
    model: model,
    messages: messages,
    stream: options.forceStream ? true : (request.stream !== false) // default true
  };

  // Pass through reasoning controls when present (provider may ignore unknown fields)
  if (request.reasoning !== undefined) {
    chatRequest.reasoning = request.reasoning;
    if (request.reasoning && typeof request.reasoning === 'object' && request.reasoning.effort !== undefined) {
      chatRequest.reasoning_effort = request.reasoning.effort;
    }
  }

  // Map optional fields
  if (request.max_output_tokens) {
    chatRequest.max_tokens = request.max_output_tokens;
  } else if (request.max_tokens) {
    chatRequest.max_tokens = request.max_tokens;
  }

  if (request.temperature !== undefined) {
    chatRequest.temperature = request.temperature;
  }

  if (request.top_p !== undefined) {
    chatRequest.top_p = request.top_p;
  }

  // Tools handling (only if allowTools)
  if (allowTools && request.tools && Array.isArray(request.tools)) {
    const normalized = [];

    for (let i = 0; i < request.tools.length; i++) {
      const tool = request.tools[i];
      if (!tool || typeof tool !== 'object') continue;

      const fn = tool.function && typeof tool.function === 'object' ? tool.function : null;
      const rawName = fn?.name || tool.name || tool.type || `tool_${i + 1}`;
      const name = normalizeToolName(rawName, `tool_${i + 1}`);
      if (!name) continue;

      // Convert non-function tool definitions to function schema for Chat Completions compatibility.
      const typeHint = tool.type && tool.type !== 'function' ? ` [original_type=${tool.type}]` : '';
      const description = (fn?.description ?? tool.description ?? `Bridged tool ${name}`) + typeHint;
      const parameters =
        fn?.parameters ??
        tool.parameters ??
        tool.input_schema ??
        { type: 'object', properties: {} };

      const functionObj = { name, parameters };
      if (description) functionObj.description = description;

      // Send minimal tool schema for upstream compatibility
      normalized.push({
        type: 'function',
        function: functionObj
      });
    }

    chatRequest.tools = normalized;

    // Only add tools array if there are valid tools
    if (chatRequest.tools.length === 0) {
      delete chatRequest.tools;
    }
  }

  if (allowTools && request.tool_choice) {
    const adapted = adaptToolChoiceForModel(model, request.tool_choice);
    chatRequest.tool_choice = adapted.toolChoice;
    if (adapted.changed) {
      log('info', 'Tool choice adapted by model strategy', {
        model,
        strategy: adapted.strategy,
      });
    }
    if (!chatRequest.tools || chatRequest.tools.length === 0) {
      delete chatRequest.tool_choice;
    }
  }

  log('debug', 'Translated Responses->Chat:', {
    messagesCount: messages.length,
    model: chatRequest.model,
    stream: chatRequest.stream
  });

  return chatRequest;
}

/**
 * Translate Chat Completions response to Responses format
 * Handles both output_text and reasoning_text content
 * Handles tool_calls if present (only if allowTools)
 */
function translateChatToResponses(chatResponse, responsesRequest, ids, allowTools) {
  const msg = chatResponse.choices?.[0]?.message ?? {};
  const outputText = msg.content ?? '';
  const reasoningText = SUPPRESS_REASONING_TEXT ? '' : extractReasoningText(msg);

  const createdAt = ids?.createdAt ?? nowSec();
  const responseId = ids?.responseId ?? `resp_${randomUUID().replace(/-/g, '')}`;
  const msgId = ids?.msgId ?? `msg_${randomUUID().replace(/-/g, '')}`;

  const content = [];
  if (outputText) {
    content.push({ type: 'output_text', text: outputText, annotations: [] });
  }

  const msgItem = {
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  };

  // Build output array: reasoning item (if any) + message item (if any) + tool calls
  const finalOutput = [];

  if (reasoningText) {
    finalOutput.push({
      id: `rs_${randomUUID().replace(/-/g, '')}`,
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: reasoningText }],
      summary: [],
    });
  }

  const hasToolCalls = allowTools && msg.tool_calls && Array.isArray(msg.tool_calls);
  if (content.length > 0 || !hasToolCalls) {
    finalOutput.push(msgItem);
  }

  // Handle tool_calls (only if allowTools)
  if (hasToolCalls) {
    for (const tc of msg.tool_calls) {
      const callId = tc.id || `call_${randomUUID().replace(/-/g, '')}`;
      const name = tc.function?.name || '';
      const args = tc.function?.arguments || '';

      // Enhanced logging for FunctionCall debugging
      log('info', `FunctionCall: ${name}(${callId}) args_length=${args.length}`);

      finalOutput.push({
        id: callId,
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name,
        arguments: args,
      });
    }
  }

  return buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || chatResponse.model || DEFAULT_MODEL,
    status: 'completed',
    created_at: createdAt,
    completed_at: nowSec(),
    input: responsesRequest?.input || [],
    output: finalOutput,
    tools: responsesRequest?.tools || [],
    request: responsesRequest || null,
  });
}

/**
 * Extract and normalize Bearer token
 */
function getBearer(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  if (!t) return '';
  // If already "Bearer xxx" keep it, otherwise add it
  if (!t.toLowerCase().startsWith('bearer ')) t = `Bearer ${t}`;
  return t;
}

/**
 * Pick auth token from env AI_API_KEY (priority) or incoming headers
 */
function pickAuth(incomingHeaders) {
  // PRIORITY: env AI_API_KEY (force correct key) -> incoming header
  const envTok = (process.env.AI_API_KEY || '').trim();
  if (envTok) return getBearer(envTok);

  if (FORCE_ENV_AUTH) return '';

  const h = (incomingHeaders['authorization'] || incomingHeaders['Authorization'] || '').trim();
  return getBearer(h);
}

/**
 * Make upstream request to Coding Plan Dashscope
 */
async function makeUpstreamRequest(path, body, headers) {
  // Ensure base URL ends with / for proper path concatenation
  const baseUrl = AI_BASE_URL.endsWith('/') ? AI_BASE_URL : AI_BASE_URL + '/';
  // Remove leading slash from path to avoid replacing base URL path
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(cleanPath, baseUrl);

  const auth = pickAuth(headers);
  if (!auth) {
    throw new Error('Missing upstream API key: set AI_API_KEY');
  }
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Authorization': auth,
    'Accept-Encoding': 'identity'  // Disable compression to avoid gzip issues
  };

  log('info', 'Upstream request:', {
    url: url.href,
    path: path,
    cleanPath: cleanPath,
    base: AI_BASE_URL,
    auth_len: auth.length,
    auth_prefix: auth.slice(0, 14) + '...', // Mask full token, keep prefix "Bearer xxxxxx..."
    bodyKeys: Object.keys(body),
    bodyPreview: JSON.stringify(body).substring(0, 800),
    messagesCount: body.messages?.length || 0,
    allRoles: body.messages?.map(m => m.role) || []
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(body)
  });

  return response;
}

/**
 * Handle streaming response from Coding Plan Dashscope with proper Responses API event format
 * Separates reasoning_content, content, and tool_calls into distinct events
 */
async function streamChatToResponses(upstreamBody, responsesRequest, ids, allowTools, writer = {}) {
  const emit = writer.emit || createSseEmitter(() => {});
  const end = writer.end || (() => {});
  const decoder = new TextDecoder();
  const reader = upstreamBody.getReader();
  let buffer = '';

  const createdAt = ids.createdAt;
  const responseId = ids.responseId;
  const msgId = ids.msgId;
  const model = responsesRequest?.model || DEFAULT_MODEL;

  const CONTENT_INDEX = 0;
  const outputItems = [];
  let currentTextItem = null;
  let messageCount = 0;

  // Track if stream has been terminated to avoid double-end
  let streamTerminated = false;
  let responseUsage = null;

  function sse(obj) {
    emit(obj);
  }

  /**
   * Send response.failed SSE event and safely close the stream
   */
  let failedResponse = null;
  function sendResponseFailed(errorCode, errorMessage) {
    if (streamTerminated) return;
    streamTerminated = true;

    const failedEvent = buildResponseFailed({
      responseId,
      model,
      createdAt,
      errorCode,
      errorMessage,
      responsesRequest,
      input: responsesRequest?.input || [],
      tools: responsesRequest?.tools || [],
      usage: responseUsage,
    });
    failedResponse = failedEvent.response;
    sse(failedEvent);
    try {
      const cancel = reader.cancel();
      if (cancel && typeof cancel.catch === 'function') {
        cancel.catch(() => {});
      }
    } catch {
      // Ignore errors during reader cancel
    }
    try {
      end();
    } catch {
      // Ignore errors during end
    }
  }

  // response.created / response.in_progress
  const baseResp = buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || DEFAULT_MODEL,
    status: 'in_progress',
    created_at: createdAt,
    completed_at: null,
    input: responsesRequest?.input || [],
    output: [],
    tools: responsesRequest?.tools || [],
    request: responsesRequest || null,
  });

  sse({ type: 'response.created', response: baseResp });
  sse({ type: 'response.in_progress', response: baseResp });

  let allOutputText = '';
  let allReasoningText = '';
  let sawToolCalls = false;
  let lastFinishReason = null;

  function addOutputItem(item) {
    outputItems.push(item);
    return outputItems.length - 1;
  }

  function startTextItem(kind, forceReasoning = false) {
    if (kind === 'reasoning' && SUPPRESS_REASONING_TEXT && !forceReasoning) {
      return null;
    }
    if (currentTextItem && currentTextItem.type === kind && !currentTextItem.closed) {
      return currentTextItem;
    }
    if (currentTextItem && !currentTextItem.closed) {
      closeTextItem(currentTextItem);
    }

    let id;
    let item;
    if (kind === 'message') {
      id = messageCount === 0 ? msgId : `msg_${randomUUID().replace(/-/g, '')}`;
      messageCount += 1;
      item = {
        id,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      };
    } else {
      id = `rs_${randomUUID().replace(/-/g, '')}`;
      item = {
        id,
        type: 'reasoning',
        status: 'in_progress',
        content: [],
        summary: [],
      };
    }

    const outputIndex = addOutputItem(item);
    sse({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    });

    currentTextItem = {
      type: kind,
      id,
      outputIndex,
      text: '',
      contentAdded: false,
      closed: false,
      forced: forceReasoning,
    };
    return currentTextItem;
  }

  function ensureContentPart(itemState) {
    if (!itemState || itemState.contentAdded) return;
    const part =
      itemState.type === 'message'
        ? { type: 'output_text', text: '', annotations: [] }
        : { type: 'reasoning_text', text: '' };

    sse({
      type: 'response.content_part.added',
      item_id: itemState.id,
      output_index: itemState.outputIndex,
      content_index: CONTENT_INDEX,
      part,
    });
    itemState.contentAdded = true;
  }

  function closeTextItem(itemState, options = {}) {
    if (!itemState || itemState.closed) return;

    if (itemState.type === 'message') {
      const allowOutputText = options.allowOutputText !== false;
      if (allowOutputText && itemState.text.length) {
        if (!itemState.contentAdded) {
          ensureContentPart(itemState);
        }
        sse({
          type: 'response.output_text.done',
          item_id: itemState.id,
          output_index: itemState.outputIndex,
          content_index: CONTENT_INDEX,
          text: itemState.text,
        });
        if (itemState.contentAdded) {
          sse({
            type: 'response.content_part.done',
            item_id: itemState.id,
            output_index: itemState.outputIndex,
            content_index: CONTENT_INDEX,
            part: { type: 'output_text', text: itemState.text, annotations: [] },
          });
        }
      }

      const msgItemDone = {
        id: itemState.id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content:
          allowOutputText && itemState.text.length
            ? [{ type: 'output_text', text: itemState.text, annotations: [] }]
            : [],
      };

      sse({
        type: 'response.output_item.done',
        output_index: itemState.outputIndex,
        item: msgItemDone,
      });
      outputItems[itemState.outputIndex] = msgItemDone;
    } else {
      const allowReasoningText = !SUPPRESS_REASONING_TEXT || itemState.forced;
      if (allowReasoningText && itemState.text.length) {
        if (!itemState.contentAdded) {
          ensureContentPart(itemState);
        }
        sse({
          type: 'response.reasoning_text.done',
          item_id: itemState.id,
          output_index: itemState.outputIndex,
          content_index: CONTENT_INDEX,
          text: itemState.text,
        });
        if (itemState.contentAdded) {
          sse({
            type: 'response.content_part.done',
            item_id: itemState.id,
            output_index: itemState.outputIndex,
            content_index: CONTENT_INDEX,
            part: { type: 'reasoning_text', text: itemState.text },
          });
        }
      }

      const reasoningItemDone = {
        id: itemState.id,
        type: 'reasoning',
        status: 'completed',
        content: allowReasoningText && itemState.text.length ? [{ type: 'reasoning_text', text: itemState.text }] : [],
        summary: [],
      };

      sse({
        type: 'response.output_item.done',
        output_index: itemState.outputIndex,
        item: reasoningItemDone,
      });
      outputItems[itemState.outputIndex] = reasoningItemDone;
    }

    itemState.closed = true;
    if (currentTextItem === itemState) {
      currentTextItem = null;
    }
  }

  // Tool call tracking (only if allowTools)
  const toolCallsMap = new Map(); // index -> { callId, name, outputIndex, arguments, partialArgs, done }
  const toolCallsById = new Map(); // callId -> index
  let nextToolIndex = 0;

  function finalizeToolCall(tcData) {
    if (!tcData || tcData.done) return;
    tcData.arguments = tcData.partialArgs;
    sse({
      type: 'response.function_call_arguments.done',
      item_id: tcData.callId,
      output_index: tcData.outputIndex,
      arguments: tcData.arguments,
    });

    const fnItemDone = {
      id: tcData.callId,
      type: 'function_call',
      status: 'completed',
      call_id: tcData.callId,
      name: tcData.name,
      arguments: tcData.arguments,
    };

    sse({
      type: 'response.output_item.done',
      output_index: tcData.outputIndex,
      item: fnItemDone,
    });
    tcData.completedItem = fnItemDone;
    outputItems[tcData.outputIndex] = fnItemDone;
    tcData.done = true;
  }

  try {
    while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const evt of events) {
      const lines = evt.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          // termina upstream
          continue;
        }

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.error) {
          const err = chunk.error || {};
          const code = err.code || 'upstream_stream_error';
          const message = err.message || 'Upstream provider returned stream error';
          sendResponseFailed(code, message);
          return failedResponse;
        }

        if (LOG_STREAM_RAW) {
          const preview = JSON.stringify(summarizeChunkForLog(chunk));
          log('debug', 'Upstream chunk:', preview.length > LOG_STREAM_MAX ? preview.slice(0, LOG_STREAM_MAX) + '…' : preview);
        }

        const choice = chunk.choices?.[0] || {};
        const delta = choice.delta || {};
        const finishReason = choice.finish_reason;

        if (chunk.usage) {
          const usage = chunk.usage || {};
          const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
          const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
          const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
          const reasoningTokens =
            usage.reasoning_tokens ??
            usage.output_tokens_details?.reasoning_tokens ??
            0;
          responseUsage = {
            input_tokens: promptTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: completionTokens,
            output_tokens_details: { reasoning_tokens: reasoningTokens },
            total_tokens: totalTokens,
          };
        }

        if (finishReason) {
          lastFinishReason = finishReason;

          // Handle content_filter - send response.failed and stop streaming
          if (finishReason === 'content_filter') {
            sendResponseFailed(
              'content_filter',
              'Content was filtered by upstream provider'
            );
            return failedResponse; // Exit the loop entirely
          }
        }

        // Handle tool_calls (only if allowTools)
        const toolCalls = extractToolCallsFromChoice(choice, delta);
        if (allowTools && Array.isArray(toolCalls)) {
          if (SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS) {
            sawToolCalls = true;
          }
          if (!ALLOW_MULTI_TOOL_CALLS && toolCalls.length > 1) {
            log('warn', `Multiple tool_calls received (${toolCalls.length}); only the first will be processed`);
          }
          const toolCallsToProcess = ALLOW_MULTI_TOOL_CALLS ? toolCalls : toolCalls.slice(0, 1);
          for (const tc of toolCallsToProcess) {
            let index = tc.index;
            const tcId = tc.id;

            if (index == null) {
              if (tcId && toolCallsById.has(tcId)) {
                index = toolCallsById.get(tcId);
              } else {
                index = nextToolIndex++;
              }
            } else if (index >= nextToolIndex) {
              nextToolIndex = index + 1;
            }

            if (!toolCallsMap.has(index)) {
              // New tool call - send output_item.added
              const callId = tcId || `call_${randomUUID().replace(/-/g, '')}`;
              const name = tc.function?.name || '';
              const fnItemInProgress = {
                id: callId,
                type: 'function_call',
                status: 'in_progress',
                call_id: callId,
                name: name,
                arguments: '',
              };

              const outputIndex = addOutputItem(fnItemInProgress);

              toolCallsMap.set(index, {
                callId,
                name,
                outputIndex,
                arguments: '',
                partialArgs: '',
                done: false
              });
              if (callId) toolCallsById.set(callId, index);

              sse({
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: fnItemInProgress,
              });

              if (name) {
                sse({
                  type: 'response.function_call_name.done',
                  item_id: callId,
                  output_index: outputIndex,
                  name: name,
                });
              }
            }

            const tcData = toolCallsMap.get(index);

            // Handle name update if it comes later
            if (tc.function?.name && !tcData.name) {
              tcData.name = tc.function.name;
              sse({
                type: 'response.function_call_name.done',
                item_id: tcData.callId,
                output_index: tcData.outputIndex,
                name: tcData.name,
              });
            }

            // Handle arguments delta
            if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
              tcData.partialArgs += tc.function.arguments;

              sse({
                type: 'response.function_call_arguments.delta',
                item_id: tcData.callId,
                output_index: tcData.outputIndex,
                delta: tc.function.arguments,
              });
            }

            // Check if this tool call is done (finish_reason comes later in the choice)
            if (finishReason === 'tool_calls') {
              finalizeToolCall(tcData);
            }
          }
          // Skip to next iteration after handling tool_calls
          continue;
        }

        // NON mescolare reasoning in output_text
        const reasoningDelta = extractReasoningText(delta);
        if (reasoningDelta) {
          const computed = computeDelta(allReasoningText, reasoningDelta);
          allReasoningText = computed.next;
          if (computed.delta.length) {
            const reasoningItem = startTextItem('reasoning');
            if (reasoningItem) {
              reasoningItem.text += computed.delta;
              if (!reasoningItem.contentAdded) {
                ensureContentPart(reasoningItem);
              }
              sse({
                type: 'response.reasoning_text.delta',
                item_id: reasoningItem.id,
                output_index: reasoningItem.outputIndex,
                content_index: CONTENT_INDEX,
                delta: computed.delta,
              });
            }
          }
        }

        if (typeof delta.content === 'string' && delta.content.length) {
          const computed = computeDelta(allOutputText, delta.content);
          allOutputText = computed.next;
          if (computed.delta.length) {
            const msgItem = startTextItem('message');
            if (msgItem) {
              msgItem.text += computed.delta;
              const emitOutputText = !DEFER_OUTPUT_TEXT_UNTIL_DONE
                && !(SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS && sawToolCalls);
              if (emitOutputText) {
                if (!msgItem.contentAdded) {
                  ensureContentPart(msgItem);
                }
                sse({
                  type: 'response.output_text.delta',
                  item_id: msgItem.id,
                  output_index: msgItem.outputIndex,
                  content_index: CONTENT_INDEX,
                  delta: computed.delta,
                });
              }
            }
          }
        }
      }
    }
    }
  } catch (streamError) {
    // Exception occurred during streaming - send response.failed
    log('error', 'Stream exception:', streamError);
    sendResponseFailed('stream_error', `Stream processing error: ${streamError.message}`);
    return failedResponse;
  }

  // If stream was terminated due to content_filter or error, don't send completion events
  if (streamTerminated) {
    return failedResponse;
  }

  // Ensure any pending tool calls are finalized once at end of stream
  if (toolCallsMap.size > 0) {
    for (const tcData of toolCallsMap.values()) {
      finalizeToolCall(tcData);
    }
  }

  const suppressForTools = SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS
    && sawToolCalls
    && lastFinishReason === 'tool_calls';
  const includeOutputText = allOutputText.length > 0 && !suppressForTools;

  if (suppressForTools && allOutputText.length > 0) {
    log('info', 'Suppressing assistant output_text due to tool_calls', { finish_reason: lastFinishReason });
    // Route suppressed assistant text into reasoning stream so it is visible outside chat.
    const separator = allReasoningText.length ? '\n\n' : '';
    const routed = separator + allOutputText;
    allReasoningText += routed;
    if (currentTextItem && currentTextItem.type === 'message' && !currentTextItem.closed) {
      closeTextItem(currentTextItem, { allowOutputText: false });
    }
    const reasoningItem = startTextItem('reasoning', true);
    if (reasoningItem) {
      reasoningItem.text += routed;
      if (!reasoningItem.contentAdded) {
        ensureContentPart(reasoningItem);
      }
      sse({
        type: 'response.reasoning_text.delta',
        item_id: reasoningItem.id,
        output_index: reasoningItem.outputIndex,
        content_index: CONTENT_INDEX,
        delta: routed,
      });
    }
  }

  if (currentTextItem && !currentTextItem.closed) {
    if (currentTextItem.type === 'message') {
      closeTextItem(currentTextItem, { allowOutputText: includeOutputText });
    } else {
      closeTextItem(currentTextItem);
    }
  }

  let finalOutput = outputItems.filter(Boolean);
  if (suppressForTools) {
    finalOutput = finalOutput.filter(
      item => !(item.type === 'message' && Array.isArray(item.content) && item.content.length === 0)
    );
  }

  const completed = buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || DEFAULT_MODEL,
    status: 'completed',
    created_at: createdAt,
    completed_at: nowSec(),
    input: responsesRequest?.input || [],
    output: finalOutput,
    tools: responsesRequest?.tools || [],
    request: responsesRequest || null,
    usage: responseUsage,
  });

  sse({ type: 'response.completed', response: completed });
  try {
    end();
  } catch {
    // Ignore errors during end
  }

  log('info', `Stream completed - ${allOutputText.length} output, ${allReasoningText.length} reasoning, ${toolCallsMap.size} tool_calls`);
  return completed;
}

/**
 * Handle POST requests
 */
async function handlePostRequest(req, res) {
  // Use normalized pathname instead of raw req.url
  const { pathname: path } = new URL(req.url, 'http://127.0.0.1');
  const requestId = generateRequestId();

  // Log with request_id
  log('info', `[${requestId}] Incoming ${req.method} ${path}`);

  // Handle both /responses and /v1/responses, /chat/completions and /v1/chat/completions
  const isResponses = (path === '/responses' || path === '/v1/responses');
  const isChat = (path === '/chat/completions' || path === '/v1/chat/completions');

  if (!isResponses && !isChat) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path }));
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch (e) {
    log('warn', `[${requestId}] Invalid JSON: ${e.message}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // Lightweight validation for Responses format
  const format = detectFormat(request);
  if (format === 'responses') {
    const validation = validateRequest(request, format);
    if (!validation.valid) {
      log('warn', `[${requestId}] Validation failed:`, validation.errors);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Validation Failed',
        details: validation.errors
      }));
      return;
    }
  }

  const hasTools = requestHasTools(request);
  const allowTools = ALLOW_TOOLS_ENV || hasTools;

  log('info', `[${requestId}] Request details:`, {
    path,
    format,
    model: request.model,
    allowTools,
    toolsPresent: hasTools
  });
  if (hasTools) {
    log('debug', 'Tools summary:', summarizeTools(request.tools));
    if (request.tools && request.tools[0]) {
      log('debug', 'Tool[0] shape:', summarizeToolShape(request.tools[0]));
    }
  }

  let upstreamBody;
  const clientWantsStream = (format === 'responses')
    ? (request.stream !== false)
    : (request.stream === true);

  // format is already defined above during validation

  if (format === 'responses') {
    // Translate Responses to Chat (force upstream streaming for unified handling)
    upstreamBody = translateResponsesToChat(request, allowTools, { forceStream: true });
  } else if (format === 'chat') {
    // Pass through Chat format (force upstream streaming for unified handling)
    upstreamBody = { ...request, stream: true };
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown request format' }));
    return;
  }

  try {
    let upstreamResponse = await makeUpstreamRequest(
      '/chat/completions',
      upstreamBody,
      req.headers
    );

    let errorBody = '';
    let status = 0;
    if (!upstreamResponse.ok) {
      errorBody = await upstreamResponse.text();
      status = upstreamResponse.status;

      if (shouldRetryWithAutoToolChoice(status, errorBody, upstreamBody)) {
        log('warn', `[${requestId}] Retrying upstream with tool_choice=auto due to model incompatibility`);
        const retryBody = { ...upstreamBody, tool_choice: 'auto' };
        upstreamBody = retryBody;
        upstreamResponse = await makeUpstreamRequest(
          '/chat/completions',
          retryBody,
          req.headers
        );
        if (!upstreamResponse.ok) {
          errorBody = await upstreamResponse.text();
          status = upstreamResponse.status;
        }
      }
    }

    if (!upstreamResponse.ok) {
      log('error', `[${requestId}] Upstream error:`, {
        status: status,
        body: errorBody.substring(0, 200)
      });

      // For streaming requests, send SSE response.failed
      if (clientWantsStream) {
        const ids = {
          createdAt: nowSec(),
          responseId: `resp_${randomUUID().replace(/-/g, '')}`,
          msgId: `msg_${randomUUID().replace(/-/g, '')}`,
        };

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const failedEvent = buildResponseFailed({
          responseId: ids.responseId,
          model: request.model || DEFAULT_MODEL,
          createdAt: ids.createdAt,
          errorCode: 'upstream_error',
          errorMessage: `Upstream request failed with status ${status}: ${errorBody.substring(0, 100)}`,
          responsesRequest: request,
          input: request?.input || [],
          tools: request?.tools || [],
        });
        const emit = createSseEmitter((obj) => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        });
        emit(failedEvent);
        res.end();
        return;
      }

      // Non-streaming: return JSON error
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Upstream request failed',
        upstream_status: status,
        upstream_body: errorBody
      }));
      return;
    }

    // Handle streaming response
    if (clientWantsStream) {
      const ids = {
        createdAt: nowSec(),
        responseId: `resp_${randomUUID().replace(/-/g, '')}`,
        msgId: `msg_${randomUUID().replace(/-/g, '')}`,
      };
      log('info', 'Starting streaming response');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const emit = createSseEmitter((obj) => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        });
        await streamChatToResponses(
          upstreamResponse.body,
          request,
          ids,
          allowTools,
          { emit, end: () => res.end() }
        );
        log('info', 'Streaming completed');
      } catch (e) {
        log('error', 'Streaming error:', e);
      }
    } else {
      // Non-streaming response (stream-first upstream)
      const ids = {
        createdAt: nowSec(),
        responseId: `resp_${randomUUID().replace(/-/g, '')}`,
        msgId: `msg_${randomUUID().replace(/-/g, '')}`,
      };

      const emit = createSseEmitter(() => {});
      const response = await streamChatToResponses(
        upstreamResponse.body,
        request,
        ids,
        allowTools,
        { emit, end: () => {} }
      );
      if (!response) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream processing failed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  } catch (error) {
    log('error', 'Request failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Create HTTP server
 */
const server = http.createServer(async (req, res) => {
  // Use normalized pathname
  const { pathname } = new URL(req.url, 'http://127.0.0.1');

  log('debug', 'Request:', req.method, pathname);

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Models endpoint (Codex often calls /v1/models)
  if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'GLM-4.7', object: 'model' },
        { id: 'glm-4.7', object: 'model' }
      ]
    }));
    return;
  }

  // POST requests
  if (req.method === 'POST') {
    await handlePostRequest(req, res);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

/**
 * Start server
 */
server.listen(PORT, HOST, () => {
  log('info', `aliyun-codex-bridge listening on http://${HOST}:${PORT}`);
  log('info', `Proxying to Coding Plan Dashscope at: ${AI_BASE_URL}`);
  log('info', `Health check: http://${HOST}:${PORT}/health`);
  log('info', `Models endpoint: http://${HOST}:${PORT}/v1/models`);
});

