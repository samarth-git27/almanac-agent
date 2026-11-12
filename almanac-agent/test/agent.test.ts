import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, checkCitations, type AgentEvent } from '../src/agent.js';
import { Ledger } from '../src/ledger.js';
import type { ChatModel, ModelRequest, ModelResponse } from '../src/model.js';
import { SearchTool, parseSearchInput, type SearchHit, type SearchItem, type SearchProvider } from '../src/search.js';
import { normUrl } from '../src/util.js';

const NOW = new Date('2026-11-11T10:20:00Z');
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

class FakeSearch implements SearchProvider {
  calls: SearchItem[] = [];
  constructor(private readonly hits: SearchHit[] = [{ title: 'HubSpot pricing', url: 'https://www.hubspot.com/pricing/sales?utm_source=x', snippet: 'Starter $20', published: '2026-11-10', score: 1 }], private readonly fail = false) {}
  async search(item: SearchItem): Promise<SearchHit[]> {
    this.calls.push(item);
    if (this.fail) throw new Error('boom');
    return this.hits;
  }
}

/** Plays back a fixed script of responses and records every request it receives. */
class ScriptedModel implements ChatModel {
  requests: ModelRequest[] = [];
  constructor(private readonly script: ModelResponse['content'][]) {}
  async complete(req: ModelRequest, onText?: (d: string) => void): Promise<ModelResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)) as ModelRequest);
    const content = this.script[this.requests.length - 1] ?? [{ type: 'text', text: 'done' }];
    for (const b of content) if (b.type === 'text') onText?.(b.text);
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage };
  }
}

const call = (searches: unknown) => [{ type: 'tool_use' as const, id: 'tu1', name: 'web_search', input: { searches } }];
const text = (t: string) => [{ type: 'text' as const, text: t }];

function setup(script: ModelResponse['content'][], provider = new FakeSearch()) {
  const ledger = new Ledger(null);
  const model = new ScriptedModel(script);
  const agent = new Agent({ model, search: new SearchTool(provider), ledger, clock: () => NOW });
  return { ledger, model, provider, agent };
}
async function ask(agent: Agent, message: string, sessionId = 's1') {
  const events: AgentEvent[] = [];
  await agent.run({ message, sessionId, tz: 'Asia/Kolkata' }, (e) => events.push(e));
  return events;
}

test('search round trip: tool result is fed back, answer streams, turn is stored', async () => {
  const { agent, model, ledger } = setup([
    call([{ query: 'HubSpot Sales Hub pricing' }, { query: 'HubSpot pricing news', since: '2026-11-09' }]),
    text('HubSpot Starter is $20/seat ([source](https://hubspot.com/pricing/sales)).'),
  ]);
  const events = await ask(agent, 'What does HubSpot cost?');
  assert.equal(model.requests.length, 2);
  const second = model.requests[1]!.messages.at(-1)!;
  assert.equal(Array.isArray(second.content) && second.content[0]!.type, 'tool_result');
  assert.match(JSON.stringify(second.content), /published 2026-11-10 \(yesterday\)/);
  assert.ok(events.some((e) => e.type === 'search'));
  const cites = events.find((e) => e.type === 'citations');
  assert.deepEqual(cites && cites.type === 'citations' && cites.unverified, []); // tracking params and www. do not break matching
  assert.equal(ledger.all('local').length, 1);
  assert.equal(events.at(-1)!.type, 'done');
});

test('hallucinated links are flagged', async () => {
  const { agent } = setup([call([{ query: 'hubspot pricing' }]), text('See [this](https://made-up.example/pricing) and [real](https://www.hubspot.com/pricing/sales).')]);
  const events = await ask(agent, 'price?');
  const c = events.find((e) => e.type === 'citations');
  assert.ok(c && c.type === 'citations');
  assert.deepEqual(c.unverified, ['https://made-up.example/pricing']);
  assert.equal(c.verified.length, 1);
});

test('the last round disables tools, so a turn always ends in an answer', async () => {
  const loop = Array.from({ length: 6 }, () => call([{ query: 'again' }]));
  const { agent, model } = setup([...loop.slice(0, 3), text('Best answer I can give.')]);
  const events = await ask(agent, 'keep searching forever');
  assert.equal(model.requests.length, 4);
  assert.equal(model.requests[3]!.allowTools, false);
  assert.ok(events.some((e) => e.type === 'text' && e.delta.includes('Best answer')));
});

test('a failing search tells the model, not the user', async () => {
  const { agent, model } = setup([call([{ query: 'some query' }]), text('I could not verify that.')], new FakeSearch([], true));
  await ask(agent, 'anything');
  assert.match(JSON.stringify(model.requests[1]!.messages.at(-1)), /FAILED/);
});

test('recall is injected into the system prompt and the clock is ground truth', async () => {
  const { agent, model, ledger } = setup([text('Nothing on record.')]);
  await ask(agent, 'On Monday we shortlisted 5 CRM tools. Has any changed pricing since?');
  const dyn = model.requests[0]!.system.at(-1)!.text;
  assert.match(dyn, /Wed 11 Nov 2026/);
  assert.match(dyn, /recall status="none"/);
  assert.match(dyn, /"Monday" = Mon 9 Nov 2026/);
  assert.equal(model.requests[0]!.system[0]!.cache, true, 'static prompt must carry the cache breakpoint');
  assert.equal(ledger.all('local').length, 1);
});

test('conversation history is replayed within a session only', async () => {
  const { agent, model } = setup([text('one'), text('two')]);
  await ask(agent, 'first question', 'A');
  await ask(agent, 'second question', 'A');
  assert.equal(model.requests[1]!.messages.length, 3);
  const { agent: b, model: m2 } = setup([text('x'), text('y')]);
  await ask(b, 'q1', 'A');
  await ask(b, 'q2', 'B');
  assert.equal(m2.requests[1]!.messages.length, 1);
});

test('digest runs after the answer and never blocks or breaks it', async () => {
  const ledger = new Ledger(null);
  const agent = new Agent({
    model: new ScriptedModel([text('ok')]), search: new SearchTool(new FakeSearch()), ledger, clock: () => NOW,
    digester: async () => { throw new Error('digest model down'); },
  });
  const events = await ask(agent, 'hello');
  await agent.flush();
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(ledger.all('local')[0]!.digest, undefined);
});

test('search input is validated: bad and future dates are dropped with a note', () => {
  const { items, warnings } = parseSearchInput({ searches: [{ query: 'a b', since: '2026-13-40' }, { query: 'c d', since: '2027-01-01' }, { query: 'e f', since: '2026-11-01', until: '2026-10-01' }] }, '2026-11-11');
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => !i.since || i.since === '2026-11-01'));
  assert.equal(items[2]!.until, undefined);
  assert.equal(warnings.length, 3);
  assert.equal(parseSearchInput({ query: 'solo' }, '2026-11-11').items.length, 1);
  assert.equal(parseSearchInput({}, '2026-11-11').items.length, 0);
});

test('identical searches are served from cache and URLs dedupe across searches', async () => {
  const provider = new FakeSearch();
  const tool = new SearchTool(provider);
  const ctx = { now: NOW, tz: 'UTC' };
  const out = await tool.execute([{ query: 'a b' }, { query: 'c d' }], [], ctx);
  assert.equal(out.sources.length, 1);
  await tool.execute([{ query: 'a b' }], [], ctx);
  assert.equal(provider.calls.length, 2);
});

test('url normalisation and citation check', () => {
  assert.equal(normUrl('https://www.Example.com/a/?utm_source=x&b=1'), 'example.com/a?b=1');
  const seen = new Set([normUrl('https://example.com/a')]);
  assert.deepEqual(checkCitations('[x](https://www.example.com/a/) https://nope.dev/z.', seen), { verified: ['https://www.example.com/a/'], unverified: ['https://nope.dev/z'] });
});
