/**
 * Digest: after the answer has been delivered, a small fast model compresses the turn into a
 * structured memory record (topic, entities, what the user stated, what we claimed and whether
 * each claim is volatile). It runs off the hot path — the user never waits for it — and the ledger
 * works without it (recall falls back to raw text), so a failure here costs nothing.
 */
import type { ChatModel } from './model.js';
import type { Digest, Turn } from './ledger.js';
import { truncate } from './util.js';

const SYSTEM = `You compress one chat turn into a memory record. Reply with ONLY a JSON object, no prose:
{"topic": string (max 10 words),
 "entities": string[] (named products, companies, people, places discussed; max 8),
 "userStated": string[] (facts, constraints or decisions the USER stated, e.g. "team of 20 salespeople", "shortlisted: HubSpot, Pipedrive"; max 5),
 "claims": [{"text": string, "volatile": boolean}] (the assistant's key factual assertions, each self-contained and including numbers and the as-of date; volatile = likely to change: prices, plans, versions, availability, rankings, news; max 6)}`;

function asStrings(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => truncate(x, 240)).slice(0, max) : [];
}

export function parseDigest(raw: string): Digest | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const claims = Array.isArray(o.claims)
      ? o.claims
          .map((c) => c as Record<string, unknown>)
          .filter((c) => typeof c.text === 'string' && c.text.trim() !== '')
          .map((c) => ({ text: truncate(String(c.text), 280), volatile: c.volatile === true }))
          .slice(0, 6)
      : [];
    return {
      topic: typeof o.topic === 'string' ? truncate(o.topic, 100) : '',
      entities: asStrings(o.entities, 8),
      userStated: asStrings(o.userStated, 5),
      claims,
    };
  } catch {
    return undefined;
  }
}

export async function digestTurn(model: ChatModel, turn: Turn): Promise<Digest | undefined> {
  const res = await model.complete({
    system: [{ text: SYSTEM }],
    messages: [
      {
        role: 'user',
        content: `Date of this turn: ${turn.localDate}\n\nUSER:\n${truncate(turn.user, 1500)}\n\nASSISTANT:\n${truncate(turn.assistant, 3500)}`,
      },
    ],
    tools: [],
    allowTools: false,
    maxTokens: 700,
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return parseDigest(text);
}
