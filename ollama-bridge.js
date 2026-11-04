// Local bridge between SillyTavern's Custom (OpenAI-compatible) source and
// Ollama's native /api/chat. The native API is what carries `think`, `num_ctx`
// and `keep_alive`, none of which the OpenAI shim on /v1 exposes.
//
// It listens on its own port rather than on a plugin route because ST calls the
// Custom endpoint from the server, without a session, and ST's CSRF middleware
// runs ahead of every /api/plugins route.
//
// This file imports nothing from SillyTavern so it can be tested on its own.
import http from 'node:http';
import https from 'node:https';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const defined = obj => Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));

const textOf = content => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
};

// Only inline images can be forwarded: Ollama takes raw base64, not URLs.
const imagesOf = content => {
    if (!Array.isArray(content)) return [];
    return content
        .filter(part => part?.type === 'image_url')
        .map(part => String(part.image_url?.url ?? part.image_url ?? ''))
        .filter(url => url.startsWith('data:'))
        .map(url => url.slice(url.indexOf(',') + 1));
};

const parseArguments = value => {
    if (typeof value !== 'string') return value ?? {};
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
};

function toOllamaMessages(messages = []) {
    // OpenAI links a tool result to its call by id, Ollama by function name.
    const toolNames = new Map();
    return messages.map(message => {
        for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name);
        const images = imagesOf(message.content);
        return defined({
            role: message.role === 'developer' ? 'system' : message.role,
            content: textOf(message.content),
            images: images.length ? images : undefined,
            thinking: message.reasoning_content ?? message.reasoning,
            tool_calls: message.tool_calls?.map(call => ({
                function: { name: call.function?.name, arguments: parseArguments(call.function?.arguments) },
            })),
            tool_name: message.role === 'tool' ? (message.name ?? toolNames.get(message.tool_call_id)) : undefined,
        });
    });
}

// An explicit `think` wins; otherwise the OpenAI-style effort fields are honoured
// so a body written for /v1 keeps working here.
function resolveThink(body) {
    if (body.think !== undefined && body.think !== null) return body.think;
    const effort = body.reasoning_effort ?? body.reasoning?.effort;
    if (effort === undefined || effort === null) return undefined;
    return effort === 'none' ? false : effort;
}

function toOllamaFormat(responseFormat) {
    if (responseFormat?.type === 'json_object') return 'json';
    if (responseFormat?.type === 'json_schema') return responseFormat.json_schema?.schema ?? responseFormat.json_schema?.value;
    return undefined;
}

export function toOllamaRequest(body) {
    return defined({
        model: body.model,
        messages: toOllamaMessages(body.messages),
        stream: body.stream === true,
        think: resolveThink(body),
        keep_alive: body.keep_alive,
        tools: body.tools?.length ? body.tools : undefined,
        format: toOllamaFormat(body.response_format),
        options: defined({
            temperature: body.temperature,
            top_p: body.top_p,
            top_k: body.top_k,
            presence_penalty: body.presence_penalty,
            frequency_penalty: body.frequency_penalty,
            seed: body.seed,
            stop: body.stop,
            num_predict: body.max_completion_tokens ?? body.max_tokens,
            num_ctx: body.num_ctx,
            ...body.options,
        }),
    });
}

export function toUsage(final) {
    const prompt = final.prompt_eval_count ?? 0;
    const completion = final.eval_count ?? 0;
    return defined({
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        // Optional in Ollama's API: left out rather than reported as zero.
        prompt_tokens_details: final.prompt_eval_cached_count === undefined
            ? undefined
            : { cached_tokens: final.prompt_eval_cached_count },
    });
}

const finishReason = (doneReason, hasToolCalls) => {
    if (hasToolCalls) return 'tool_calls';
    return doneReason === 'length' ? 'length' : 'stop';
};

const toToolCalls = (calls, offset, id) => calls.map((call, i) => ({
    index: offset + i,
    id: `call_${id}_${offset + i}`,
    type: 'function',
    function: {
        name: call.function?.name,
        arguments: JSON.stringify(call.function?.arguments ?? {}),
    },
}));

export function toCompletion(reply, { id, created, model }) {
    const message = reply.message ?? {};
    const toolCalls = toToolCalls(message.tool_calls ?? [], 0, id);
    return {
        id: `chatcmpl-${id}`,
        object: 'chat.completion',
        created,
        model,
        choices: [{
            index: 0,
            message: defined({
                role: 'assistant',
                content: message.content ?? '',
                reasoning_content: message.thinking || undefined,
                tool_calls: toolCalls.length ? toolCalls : undefined,
            }),
            finish_reason: finishReason(reply.done_reason, toolCalls.length > 0),
        }],
        usage: toUsage(reply),
    };
}

/** Returns a function mapping one Ollama NDJSON object to OpenAI stream chunks. */
export function createChunkTranslator({ id, created, model }) {
    let roleSent = false;
    let toolCount = 0;
    const chunk = (delta, finish_reason = null) => ({
        id: `chatcmpl-${id}`,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason }],
    });

    return event => {
        if (event.error) return [{ error: { message: String(event.error) } }];
        const out = [];
        const message = event.message ?? {};
        const delta = {};
        if (message.thinking) delta.reasoning_content = message.thinking;
        if (message.content) delta.content = message.content;
        if (message.tool_calls?.length) {
            delta.tool_calls = toToolCalls(message.tool_calls, toolCount, id);
            toolCount += message.tool_calls.length;
        }
        if (Object.keys(delta).length) {
            if (!roleSent) delta.role = 'assistant';
            roleSent = true;
            out.push(chunk(delta));
        }
        if (event.done) {
            out.push(chunk({}, finishReason(event.done_reason, toolCount > 0)));
            // Same shape as OpenAI's include_usage: no choices, usage on its own.
            out.push({ ...chunk({}), choices: [], usage: toUsage(event) });
        }
        return out;
    };
}

function isAllowed(req) {
    // ST's server-side call has no Origin and a loopback Host. A web page in the
    // user's browser fails one of those: its POSTs carry Origin, and a rebinding
    // domain shows up in Host. Without this any site could start paid cloud
    // generations.
    if (req.headers.origin) return false;
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    return LOOPBACK_HOSTS.has(host);
}

async function readJson(req) {
    const parts = [];
    let size = 0;
    for await (const part of req) {
        size += part.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
        parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function sendError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
}

const authHeader = value => {
    const key = String(value ?? '').replace(/^Bearer\s*/i, '').trim();
    return key && key !== 'undefined' && key !== 'null' ? { Authorization: `Bearer ${key}` } : {};
};

// node:http rather than fetch: fetch gives up after five minutes without a first
// byte, which a large local model can easily take to load.
function postJson(url, payload, headers, signal) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = (target.protocol === 'https:' ? https : http).request(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            signal,
        }, resolve);
        request.on('error', reject);
        request.end(JSON.stringify(payload));
    });
}

async function readText(stream) {
    const parts = [];
    for await (const part of stream) parts.push(part);
    return Buffer.concat(parts).toString('utf8');
}

function errorMessage(text, status) {
    try {
        const parsed = JSON.parse(text);
        return String(parsed.error?.message ?? parsed.error ?? text);
    } catch {
        return text || `Ollama returned ${status}`;
    }
}

// Sets `think` on a model without thinking support and Ollama refuses the whole
// request, which would make one global dropdown break every other model. Drop
// the field and retry once.
async function openUpstream(url, payload, headers, signal) {
    const first = await postJson(url, payload, headers, signal);
    if (first.statusCode !== 400 || payload.think === undefined) return { upstream: first };
    const text = await readText(first);
    if (!/think/i.test(text)) return { upstream: first, consumedText: text };
    const { think: _ignored, ...withoutThink } = payload;
    return { upstream: await postJson(url, withoutThink, headers, signal) };
}

async function* ndjson(stream) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const part of stream) {
        buffer += decoder.decode(part, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (line) yield JSON.parse(line);
        }
    }
    const rest = buffer.trim();
    if (rest) yield JSON.parse(rest);
}

async function handleChat(req, res, upstreamUrl) {
    const body = await readJson(req);
    const payload = toOllamaRequest(body);
    const meta = {
        id: Date.now().toString(36),
        created: Math.floor(Date.now() / 1000),
        model: body.model,
    };

    // ST aborting a generation closes this connection; pass that on so the
    // model stops instead of finishing a reply nobody will read.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    const { upstream, consumedText } = await openUpstream(
        `${upstreamUrl}/api/chat`, payload, authHeader(req.headers.authorization), controller.signal,
    );

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const text = consumedText ?? await readText(upstream);
        return sendError(res, upstream.statusCode, errorMessage(text, upstream.statusCode));
    }

    if (!payload.stream) {
        const reply = JSON.parse(await readText(upstream));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(toCompletion(reply, meta)));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const translate = createChunkTranslator(meta);
    try {
        for await (const event of ndjson(upstream)) {
            for (const chunk of translate(event)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
    } catch (error) {
        if (!controller.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
}

async function handleModels(res, upstreamUrl) {
    const upstream = await fetch(`${upstreamUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return sendError(res, upstream.status, errorMessage(await upstream.text(), upstream.status));
    const { models = [] } = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        object: 'list',
        data: models.map(model => ({
            id: model.name,
            object: 'model',
            created: Math.floor(new Date(model.modified_at ?? 0).getTime() / 1000),
            owned_by: 'ollama',
        })),
    }));
}

function createHandler(upstreamUrl) {
    return async (req, res) => {
        try {
            if (!isAllowed(req)) return sendError(res, 403, 'Only local server-side requests are accepted');
            const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
            if (req.method === 'GET' && path === '/v1/models') return await handleModels(res, upstreamUrl);
            if (req.method === 'POST' && path === '/v1/chat/completions') return await handleChat(req, res, upstreamUrl);
            return sendError(res, 404, 'Not found');
        } catch (error) {
            if (error.name === 'AbortError') return res.destroy();
            if (res.headersSent) return res.destroy();
            if (error instanceof SyntaxError) return sendError(res, 400, 'Invalid JSON');
            const unreachable = error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED';
            return sendError(
                res,
                error.status ?? 502,
                unreachable ? `Could not reach Ollama at ${upstreamUrl}` : error.message,
            );
        }
    };
}

/**
 * Starts the bridge on 127.0.0.1. A taken port must not take SillyTavern down
 * with it, so failure is reported in the result instead of being thrown.
 */
export function startBridge({ port, upstreamUrl }) {
    const upstream = String(upstreamUrl).replace(/\/+$/, '');
    const server = http.createServer(createHandler(upstream));
    return new Promise(resolve => {
        server.once('error', error => resolve({ running: false, upstream, error: error.message, close: async () => { } }));
        server.listen(port, '127.0.0.1', () => {
            const bound = server.address().port;
            resolve({
                running: true,
                port: bound,
                url: `http://127.0.0.1:${bound}/v1`,
                upstream,
                close: () => new Promise(done => {
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}
