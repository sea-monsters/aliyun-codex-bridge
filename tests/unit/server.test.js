const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldUseNonStreamingUpstream,
  shouldRetryWithSingleChoice,
  buildInProgressResponse,
  translateResponsesToChat,
  translateChatToResponses,
  sanitizeAssistantToolCalls,
  normalizeMessageContentByRole,
  buildResponseObject,
} = require('../../src/server');

test('shouldUseNonStreamingUpstream enables non-streaming for n>1', () => {
  assert.equal(shouldUseNonStreamingUpstream({ n: 1 }), false);
  assert.equal(shouldUseNonStreamingUpstream({ n: 2 }), true);
  assert.equal(shouldUseNonStreamingUpstream({ n: '3' }), true);
});

test('translateResponsesToChat can enforce non-stream by request override', () => {
  const out = translateResponsesToChat(
    { model: 'qwen3.5-plus', stream: false, n: 2, input: [{ role: 'user', content: 'x' }] },
    false,
    { forceStream: false }
  );
  assert.equal(out.stream, false);
  assert.equal(out.n, 2);
});

test('shouldRetryWithSingleChoice detects n limitation error', () => {
  const body = '<400> InternalError.Algo.InvalidParameter: The n parameter must be 1 when enable_thinking is true';
  assert.equal(shouldRetryWithSingleChoice(400, body, { n: 2 }), true);
  assert.equal(shouldRetryWithSingleChoice(400, body, { n: 1 }), false);
  assert.equal(shouldRetryWithSingleChoice(500, body, { n: 2 }), false);
});

test('buildInProgressResponse creates responses-compatible in_progress payload', () => {
  const resp = buildInProgressResponse(
    { responseId: 'resp_x', createdAt: 123 },
    { model: 'qwen3.5-plus', input: [{ role: 'user', content: 'x' }], tools: [] }
  );
  assert.equal(resp.id, 'resp_x');
  assert.equal(resp.status, 'in_progress');
  assert.equal(resp.created_at, 123);
  assert.equal(resp.completed_at, null);
  assert.equal(resp.model, 'qwen3.5-plus');
});

test('translateResponsesToChat maps optional chat-completions fields', () => {
  const request = {
    model: 'qwen3.5-plus',
    input: [{ role: 'user', content: 'hello' }],
    frequency_penalty: 0.2,
    presence_penalty: 0.1,
    seed: 42,
    stop: ['END'],
    n: 2,
    logprobs: true,
    top_logprobs: 3,
    parallel_tool_calls: false,
    user: 'u1',
    text: {
      format: {
        type: 'json_schema',
        json_schema: {
          name: 'my_schema',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      },
    },
  };
  const out = translateResponsesToChat(request, false, { forceStream: false });
  assert.equal(out.frequency_penalty, 0.2);
  assert.equal(out.presence_penalty, 0.1);
  assert.equal(out.seed, 42);
  assert.deepEqual(out.stop, ['END']);
  assert.equal(out.n, 2);
  assert.equal(out.logprobs, true);
  assert.equal(out.top_logprobs, 3);
  assert.equal(out.parallel_tool_calls, false);
  assert.equal(out.user, 'u1');
  assert.equal(out.response_format.type, 'json_schema');
  assert.equal(out.response_format.json_schema.name, 'my_schema');
});

test('translateResponsesToChat passes through modalities/audio fields', () => {
  const request = {
    model: 'qwen3.5-plus',
    input: [{ role: 'user', content: 'hello' }],
    modalities: ['text', 'audio'],
    audio: { voice: 'alloy', format: 'wav' },
  };
  const out = translateResponsesToChat(request, false, { forceStream: false });
  assert.deepEqual(out.modalities, ['text', 'audio']);
  assert.deepEqual(out.audio, { voice: 'alloy', format: 'wav' });
});

test('translateResponsesToChat preserves user multimodal content', () => {
  const request = {
    model: 'qwen3.5-plus',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
          { type: 'input_audio', input_audio: { data: 'BASE64DATA', format: 'wav' } },
        ],
      },
    ],
  };
  const out = translateResponsesToChat(request, false, { forceStream: false });
  assert.ok(Array.isArray(out.messages[0].content));
  assert.deepEqual(out.messages[0].content[0], { type: 'text', text: 'look' });
  assert.equal(out.messages[0].content[1].type, 'image_url');
  assert.equal(out.messages[0].content[1].image_url.url, 'https://example.com/a.png');
  assert.equal(out.messages[0].content[2].type, 'input_audio');
  assert.equal(out.messages[0].content[2].input_audio.format, 'wav');
});

test('sanitizeAssistantToolCalls normalizes malformed tool_calls', () => {
  const input = [
    {
      id: 'call_1',
      name: 'Shell Command',
      arguments: { command: 'git status --short' },
    },
  ];
  const out = sanitizeAssistantToolCalls(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'call_1');
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'shell_command');
  assert.equal(typeof out[0].function.arguments, 'string');
  assert.match(out[0].function.arguments, /git status --short/);
});

test('normalizeMessageContentByRole falls back to plain string for non-user role', () => {
  const out = normalizeMessageContentByRole('assistant', [
    { type: 'input_text', text: 'a' },
    { type: 'input_image', image_url: 'https://example.com/a.png' },
  ]);
  assert.equal(typeof out, 'string');
  assert.match(out, /a/);
});

test('buildResponseObject echoes previous_response_id/store/truncation from request', () => {
  const response = buildResponseObject({
    id: 'resp_1',
    model: 'qwen3.5-plus',
    status: 'completed',
    created_at: 1,
    output: [],
    request: {
      previous_response_id: 'resp_prev',
      store: true,
      truncation: 'auto',
    },
  });
  assert.equal(response.previous_response_id, 'resp_prev');
  assert.equal(response.store, true);
  assert.equal(response.truncation, 'auto');
});

test('translateChatToResponses aggregates multi-choice output and usage', () => {
  const chatResponse = {
    model: 'qwen3.5-plus',
    choices: [
      { index: 0, message: { content: 'first' } },
      { index: 1, message: { content: 'second' } },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      output_tokens_details: { reasoning_tokens: 4 },
    },
  };
  const out = translateChatToResponses(chatResponse, { input: [], tools: [] }, null, false);
  const messages = out.output.filter((x) => x.type === 'message');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content[0].text, 'first');
  assert.equal(messages[1].content[0].text, 'second');
  assert.equal(out.usage.input_tokens, 10);
  assert.equal(out.usage.output_tokens, 20);
  assert.equal(out.usage.total_tokens, 30);
  assert.equal(out.usage.output_tokens_details.reasoning_tokens, 4);
});
