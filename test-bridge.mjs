// Runs the bridge against a stub of Ollama's /api/chat.
// Run with: node test-bridge.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { createChunkTranslator, startBridge, toCompletion, toOllamaRequest, toUsage } from './ollama-bridge.js';

// --- Request translation ---------------------------------------------------
const request = toOllamaRequest({
    model: 'qwen3:8b',
    stream: true,
    temperature: 0.7,
    max_tokens: 400,
    think: 'high',
    num_ctx: 16384,
    keep_alive: '30m',
    options: { min_p: 0.05 },
    messages: [
        { role: 'developer', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ],
});
assert.equal(request.think, 'high');
assert.equal(request.keep_alive, '30m');
assert.deepEqual(request.options, { temperature: 0.7, num_predict: 400, num_ctx: 16384, min_p: 0.05 });
assert.equal(request.messages[0].role, 'system');
assert.deepEqual(request.messages[1].images, ['QUJD']);
assert.deepEqual(request.messages[2].tool_calls[0].function.arguments, { q: 'x' });
assert.equal(request.messages[3].tool_name, 'lookup', 'tool results are matched to calls by name');

assert.equal(toOllamaRequest({ reasoning_effort: 'none' }).think, false);
assert.equal(toOllamaRequest({ reasoning_effort: 'high' }).think, 'high');
assert.equal(toOllamaRequest({ reasoning: { effort: 'max' } }).think, 'max');
assert.equal(toOllamaRequest({ think: false, reasoning_effort: 'high' }).think, false, 'explicit think wins');
assert.equal('think' in toOllamaRequest({}), false, 'unset think must stay unset so the model default applies');
assert.equal(toOllamaRequest({ response_format: { type: 'json_object' } }).format, 'json');

// --- Usage: the meter reads cached_tokens from prompt_tokens_details ------------
assert.deepEqual(toUsage({ prompt_eval_count: 100, prompt_eval_cached_count: 80, eval_count: 20 }), {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 },
});
assert.equal(toUsage({ prompt_eval_count: 1, eval_count: 1 }).prompt_tokens_details, undefined);

// --- Response translation ------------------------------------------------------
const meta = { id: 't', created: 1, model: 'm' };
const translate = createChunkTranslator(meta);
const [thinking] = translate({ message: { thinking: 'hmm' } });
assert.deepEqual(thinking.choices[0].delta, { reasoning_content: 'hmm', role: 'assistant' });
const [text] = translate({ message: { content: 'hi' } });
assert.deepEqual(text.choices[0].delta, { content: 'hi' }, 'role is only sent once');
const [finish, usage] = translate({ message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 2, eval_count: 3 });
assert.equal(finish.choices[0].finish_reason, 'length');
assert.deepEqual(usage.choices, []);
assert.equal(usage.usage.total_tokens, 5);

const calls = createChunkTranslator(meta);
const [call] = calls({ message: { tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }] } });
assert.equal(call.choices[0].delta.tool_calls[0].function.arguments, '{"a":1}');
assert.equal(calls({ done: true })[0].choices[0].finish_reason, 'tool_calls');

const whole = toCompletion({ message: { content: 'hi', thinking: 'hmm' }, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }, meta);
assert.equal(whole.choices[0].message.reasoning_content, 'hmm');

// --- End to end through a real socket ---------------------------------------------
const seen = [];
let aborted = null;
const stub = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', modified_at: '2026-01-01T00:00:00Z' }] }));
    }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    seen.push({ body, authorization: req.headers.authorization });
    if (body.model === 'plain' && body.think !== undefined) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: '"plain" does not support thinking' }));
    }
    if (body.model === 'slow') {
        res.write(`${JSON.stringify({ message: { content: 'x' } })}\n`);
        return res.on('close', () => aborted?.());
    }
    if (body.model === 'missing') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'model not found' }));
    }
    if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ message: { content: 'whole', thinking: 'why' }, done: true, done_reason: 'stop', prompt_eval_count: 4, eval_count: 2 }));
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    // Split mid-line on purpose: chunk boundaries do not follow JSON lines.
    const lines = [{ message: { thinking: 'let me see' } }, { message: { content: 'answer' } }, { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, prompt_eval_cached_count: 6, eval_count: 5 }]
        .map(line => JSON.stringify(line)).join('\n');
    res.write(lines.slice(0, 12));
    await new Promise(resolve => setTimeout(resolve, 10));
    res.end(lines.slice(12));
});
await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
const bridge = await startBridge({ port: 0, upstreamUrl: `http://127.0.0.1:${stub.address().port}/` });
assert.equal(bridge.running, true);

const post = (body, headers = {}) => fetch(`${bridge.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
});

const models = await (await fetch(`${bridge.url}/models`)).json();
assert.equal(models.data[0].id, 'qwen3:8b');

const streamed = await post({ model: 'qwen3:8b', stream: true, think: true, num_ctx: 8192, messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer undefined' });
assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
const lines = (await streamed.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
assert.equal(lines.at(-1), '[DONE]');
const events = lines.slice(0, -1).map(line => JSON.parse(line));
assert.equal(events[0].choices[0].delta.reasoning_content, 'let me see');
assert.equal(events[1].choices[0].delta.content, 'answer');
assert.deepEqual(events.at(-1).usage.prompt_tokens_details, { cached_tokens: 6 });
assert.equal(seen.at(-1).body.think, true);
assert.equal(seen.at(-1).body.options.num_ctx, 8192);
assert.equal(seen.at(-1).authorization, undefined, 'an empty ST key must not be forwarded as a credential');

const single = await (await post({ model: 'qwen3:8b', messages: [] }, { Authorization: 'Bearer abc' })).json();
assert.equal(single.choices[0].message.reasoning_content, 'why');
assert.equal(seen.at(-1).authorization, 'Bearer abc');

const before = seen.length;
const retried = await (await post({ model: 'plain', think: true, messages: [] })).json();
assert.equal(retried.choices[0].message.content, 'whole', 'a model without thinking must still answer');
assert.equal(seen.length, before + 2);
assert.equal('think' in seen.at(-1).body, false);

const missing = await post({ model: 'missing', think: true, stream: true, messages: [] });
assert.equal(missing.status, 404);
assert.equal((await missing.json()).error.message, 'model not found');

// Stopping a generation in ST must stop the model too.
const controller = new AbortController();
const closed = new Promise(resolve => { aborted = resolve; });
const slow = await fetch(`${bridge.url}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model: 'slow', stream: true, messages: [] }),
    signal: controller.signal,
});
await slow.body.getReader().read();
controller.abort();
await closed;

// A web page in the user's browser always sends Origin, and may rebind Host.
assert.equal((await post({ model: 'qwen3:8b', messages: [] }, { Origin: 'https://evil.example' })).status, 403);
const rebound = await new Promise(resolve => {
    http.get({ host: '127.0.0.1', port: bridge.port, path: '/v1/models', headers: { Host: 'evil.example' } }, resolve);
});
assert.equal(rebound.statusCode, 403);
rebound.resume();

// A taken port is reported, not thrown: it must not stop SillyTavern from booting.
const taken = await startBridge({ port: bridge.port, upstreamUrl: 'http://127.0.0.1:1' });
assert.equal(taken.running, false);
assert.match(taken.error, /EADDRINUSE/);

await bridge.close();
const down = await startBridge({ port: 0, upstreamUrl: 'http://127.0.0.1:1' });
const refused = await fetch(`${down.url}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
assert.equal(refused.status, 502);
assert.match((await refused.json()).error.message, /Could not reach Ollama/);
await down.close();
stub.closeAllConnections();
stub.close();
console.log('ollama bridge: all checks passed');
