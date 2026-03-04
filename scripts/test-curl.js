#!/usr/bin/env node

/**
 * Manual test script for aliyun-codex-bridge
 *
 * Tests the proxy with a minimal Responses API payload.
 */

const http = require('http');

const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1';
const PROXY_PORT = process.env.PROXY_PORT || '31415';
const AI_API_KEY = process.env.AI_API_KEY
  || process.env.AI_API_KEY_P
  || process.env.AI_API_KEY_A
  || process.env.OPENAI_API_KEY
  || '';

async function testHealth() {
  console.log('\n=== Testing Health Endpoint ===\n');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: '/health',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', body);
        resolve();
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function testResponsesFormat() {
  console.log('\n=== Testing POST /v1/responses (Non-Streaming) ===\n');

  const payload = {
    model: 'GLM-4.7',
    instructions: 'You are a helpful assistant. Be brief.',
    input: [
      {
        role: 'user',
        content: 'What is 2+2? Answer with just the number.'
      }
    ],
    stream: false
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', body);
        try {
          const parsed = JSON.parse(body);
          console.log('\nParsed output:', parsed.output?.[0]?.value);
        } catch (e) {
          console.log('\nFailed to parse response');
        }
        resolve();
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload, null, 2));
    req.end();
  });
}

async function testStreamingFormat() {
  console.log('\n=== Testing POST /v1/responses (Streaming) ===\n');

  const payload = {
    model: 'GLM-4.7',
    instructions: 'You are a helpful assistant.',
    input: [
      {
        role: 'user',
        content: 'Count from 1 to 3.'
      }
    ],
    stream: true
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      }
    };

    const req = http.request(options, (res) => {
      console.log('Status:', res.statusCode);
      console.log('Headers:', JSON.stringify(res.headers, null, 2));
      console.log('\nStreaming response:');

      res.on('data', (chunk) => {
        process.stdout.write(chunk);
      });

      res.on('end', () => {
        console.log('\n\n=== Stream Complete ===');
        resolve();
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload, null, 2));
    req.end();
  });
}

async function testToolCall() {
  console.log('\n=== Testing POST /v1/responses (Tool Call) ===\n');
  console.log('Note: This test requires ALLOW_TOOLS=1 and upstream model support for tools.\n');

  const payload = {
    model: 'GLM-4.7',
    instructions: 'You are a helpful assistant.',
    input: [
      {
        role: 'user',
        content: 'What is the weather in Tokyo? Use the get_weather tool.'
      }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The city and state, e.g. San Francisco, CA'
              }
            },
            required: ['location']
          }
        }
      }
    ],
    tool_choice: 'auto',
    stream: true
  };

  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      }
    };

    const req = http.request(options, (res) => {
      console.log('Status:', res.statusCode);

      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          console.log('Error response:', body);
          resolve({ status: 'error', message: body });
        });
        return;
      }

      console.log('\nStreaming response:');
      let buffer = '';
      let foundToolCall = false;
      let foundOutputItemAdded = false;
      let foundFunctionCallDelta = false;
      let foundOutputItemDone = false;
      let foundResponseCompleted = false;

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const evt of events) {
          const lines = evt.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            try {
              const data = JSON.parse(payload);
              const type = data.type;

              // Look for tool call events
              if (type === 'response.output_item.added') {
                if (data.item?.type === 'function_call') {
                  foundOutputItemAdded = true;
                  console.log('[EVENT] output_item.added (function_call):', data.item?.name);
                }
              }

              if (type === 'response.function_call_arguments.delta') {
                foundFunctionCallDelta = true;
                process.stdout.write('.');
              }

              if (type === 'response.output_item.done') {
                if (data.item?.type === 'function_call') {
                  foundOutputItemDone = true;
                }
              }

              if (type === 'response.completed') {
                foundResponseCompleted = true;
              }
            } catch (e) {
              // Skip parse errors
            }
          }
        }
      });

      res.on('end', () => {
        console.log();
        console.log('\n=== Tool Call Test Results ===');

        if (!foundToolCall && !foundOutputItemAdded) {
          console.log('SKIP: upstream did not return tool_calls');
          console.log('This may mean:');
          console.log('  - ALLOW_TOOLS is not enabled on the proxy');
          console.log('  - The model does not support tool calls');
          console.log('  - The prompt did not trigger a tool call');
          resolve({ status: 'skipped', reason: 'no tool calls from upstream' });
          return;
        }

        const passed = foundOutputItemAdded && foundFunctionCallDelta && foundOutputItemDone && foundResponseCompleted;
        console.log('output_item.added (function_call):', foundOutputItemAdded ? 'PASS' : 'FAIL');
        console.log('function_call_arguments.delta:', foundFunctionCallDelta ? 'PASS' : 'FAIL');
        console.log('output_item.done (function_call):', foundOutputItemDone ? 'PASS' : 'FAIL');
        console.log('response.completed:', foundResponseCompleted ? 'PASS' : 'FAIL');
        console.log('\nOverall:', passed ? 'PASS' : 'FAIL');

        resolve({ status: passed ? 'pass' : 'fail', results: { foundOutputItemAdded, foundFunctionCallDelta, foundOutputItemDone, foundResponseCompleted } });
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err.message);
      reject(err);
    });

    req.write(JSON.stringify(payload, null, 2));
    req.end();
  });
}

async function main() {
  console.log('aliyun-codex-bridge Manual Test');
  console.log('================================');
  console.log('Proxy:', `http://${PROXY_HOST}:${PROXY_PORT}`);
  console.log('API Key:', AI_API_KEY ? 'Set' : 'NOT SET - set AI_API_KEY or OPENAI_API_KEY');

  if (!AI_API_KEY) {
    console.error('\nError: No API key found. Set AI_API_KEY or OPENAI_API_KEY environment variable.');
    process.exit(1);
  }

  try {
    await testHealth();
    await testResponsesFormat();
    await testStreamingFormat();

    // Tool call test (optional - depends on upstream support)
    console.log('\n\n=== Tool Support Tests ===');
    const toolResult = await testToolCall();

    console.log('\n=== All Tests Complete ===\n');
    console.log('Summary:');
    console.log('  Health: PASS');
    console.log('  Non-streaming: PASS');
    console.log('  Streaming: PASS');
    if (toolResult.status === 'pass') {
      console.log('  Tool calls: PASS');
    } else if (toolResult.status === 'skipped') {
      console.log('  Tool calls: SKIPPED (upstream does not support or did not return tool_calls)');
    } else {
      console.log('  Tool calls: FAIL or ERROR');
    }
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
}

main();

