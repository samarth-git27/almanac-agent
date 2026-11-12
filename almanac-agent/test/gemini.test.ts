import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiModel, toGeminiContents } from '../src/gemini.js';
import { AnthropicModel, ModelError, type Message, type ModelRequest } from '../src/model.js';
import { SEARCH_TOOL } from '../src/search.js';

const sse = (chunks: unknown[], status = 200): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(''), { status, headers: { 'content-type': 'text/event-stream' } });
const err = (status: number, message: string, details: unknown[] = []): Response =>
  new Response(JSON.stringify({ error: { code: status, message, details } }), { status });

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: [{ text: 'STATIC', cache: true }, { text: 'DYNAMIC' }],
  messages: [{ role: 'user', content: 'hi' }],
  tools: [SEARCH_TOOL],
  allowTools: true,
  maxTokens: 500,
  ...over,
});

test('request mapping: system, tools, tool mode, roles', () => {
  const m = new GeminiModel('k', 'gemini-x');
  const body = m.buildBody(req()) as Record<string, any>;
  assert.equal(body.systemInstruction.parts[0].text, 'STATIC\n\nDYNAMIC');
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(body.generationConfig.maxOutputTokens, 500);
  const decl = body.tools[0].functionDeclarations[0];
  assert.equal(decl.name, 'web_search');
  assert.equal(decl.parameters.properties.searches.items.properties.query.type, 'string');
  assert.equal(decl.parameters.required[0], 'searches');
  assert.equal((m.buildBody(req({ allowTools: false })) as any).toolConfig.functionCallingConfig.mode, 'NONE');
  const noTools = m.buildBody(req({ tools: [] })) as any;
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.toolConfig, undefined);
});

test('function calls round-trip with their thought signature; responses are matched by name', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'text', text: '  ' },
      { type: 'tool_use', id: 'a1', name: 'web_search', input: { searches: [{ query: 'x y' }] }, providerMeta: { thoughtSignature: 'SIG' } },
      { type: 'tool_use', id: 'a2', name: 'web_search', input: { searches: [{ query: 'z w' }] } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a1', content: 'result one' },
      { type: 'tool_result', tool_use_id: 'a2', content: 'boom', is_error: true },
    ] },
  ];
  const c = toGeminiContents(msgs);
  assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
  assert.equal(c[1]!.parts.length, 2, 'blank text part dropped');
  assert.equal(c[1]!.parts[0]!.thoughtSignature, 'SIG');
  assert.equal(c[1]!.parts[1]!.thoughtSignature, undefined, 'only the first call carries a signature; none is invented');
  assert.deepEqual(c[2]!.parts[0]!.functionResponse, { name: 'web_search', response: { output: 'result one' } });
  assert.deepEqual(c[2]!.parts[1]!.functionResponse, { name: 'web_search', response: { error: 'boom' } });
});

test('streaming: text deltas, skipped thought parts, tool call with signature, usage, CRLF framing', async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], 'KEY');
    return sse([
      { candidates: [{ content: { parts: [{ text: 'let me think', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }, { functionCall: { name: 'web_search', args: { searches: [{ query: 'q q' }] } }, thoughtSignature: 'S1' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40 } },
    ]);
  }) as typeof fetch;
  const deltas: string[] = [];
  const res = await new GeminiModel('KEY', 'gemini-x', fetchImpl).complete(req(), (d) => deltas.push(d));
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(res.content[0]!.type === 'text' && res.content[0]!.text, 'Hello');
  const call = res.content[1]!;
  assert.ok(call.type === 'tool_use');
  assert.deepEqual(call.providerMeta, { thoughtSignature: 'S1' });
  assert.equal(res.stopReason, 'tool_use');
  assert.deepEqual(res.usage, { input: 100, output: 25, cacheRead: 40, cacheWrite: 0 });
});

test('a blocked prompt becomes a short polite answer instead of a crash', async () => {
  const fetchImpl = (async () => sse([{ promptFeedback: { blockReason: 'SAFETY' } }])) as typeof fetch;
  const res = await new GeminiModel('k', 'm', fetchImpl).complete(req());
  assert.match(res.content[0]!.type === 'text' ? res.content[0]!.text : '', /blocked it: safety/);
});

test('transient 503 is retried once; a long 429 is not retried and keeps its status', async () => {
  let n = 0;
  const flaky = (async () => (++n === 1 ? err(503, 'overloaded') : sse([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]))) as typeof fetch;
  const res = await new GeminiModel('k', 'm', flaky).complete(req());
  assert.equal(n, 2);
  assert.equal(res.content[0]!.type === 'text' && res.content[0]!.text, 'ok');

  let calls = 0;
  const quota = (async () => (calls++, err(429, 'quota exceeded', [{ retryDelay: '45s' }]))) as typeof fetch;
  await assert.rejects(new GeminiModel('k', 'm', quota).complete(req()), (e: unknown) => e instanceof ModelError && e.status === 429);
  assert.equal(calls, 1);
});

test('bad key surfaces Google\'s own message', async () => {
  const bad = (async () => err(400, 'API key not valid. Please pass a valid API key.')) as typeof fetch;
  await assert.rejects(new GeminiModel('k', 'm', bad).complete(req()), /API key not valid/);
});

test('Anthropic adapter never leaks provider-only metadata into its request', async () => {
  let sent: any;
  const client = {
    messages: {
      stream: (params: unknown) => {
        sent = params;
        return { on: () => undefined, finalMessage: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) };
      },
    },
  };
  const msgs: Message[] = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'web_search', input: {}, providerMeta: { thoughtSignature: 'S' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] },
  ];
  await new AnthropicModel(client as never, 'claude-x').complete(req({ messages: msgs }));
  assert.equal(JSON.stringify(sent).includes('providerMeta'), false);
  assert.equal(JSON.stringify(sent).includes('thoughtSignature'), false);
});
