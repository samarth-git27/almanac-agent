/**
 * The agent loop.
 *
 *   message ──► recall (deterministic: dates + ledger)  ──┐
 *                                                         ├─► model ⇄ web_search (≤ 4 rounds, parallel fan-out)
 *   clock (deterministic) ────────────────────────────────┘        │
 *                                                                  ├─► streamed answer
 *                                                                  ├─► citation guard (every link must have been seen)
 *                                                                  └─► ledger append, then async digest (off the hot path)
 *
 * Everything that must be right (what day it is, what was said before, which URLs are real) is computed
 * by the harness. The model is left to do what only a model can: decide what to search, read, and write.
 */
import { config } from './config.js';
import { systemClock, validTz, type Clock, ymdInTz } from './clock.js';
import type { Digest, Ledger, SourceRef, Turn } from './ledger.js';
import type { Block, ChatModel, Message, ToolResultBlock, ToolUseBlock, Usage } from './model.js';
import { dynamicBlock, SYSTEM_PROMPT } from './prompt.js';
import { buildRecall } from './recall.js';
import { describeFilters, SEARCH_TOOL, SearchTool, type SearchItem } from './search.js';
import { extractUrls, normUrl, uid } from './util.js';

export interface Trace {
  rounds: number;
  searches: { queries: string[]; ms: number; results: number; cached: boolean; error?: string }[];
  ttftMs: number | null;
  totalMs: number;
  usage: Usage;
  recall: string;
  refs: string[];
}

export type AgentEvent =
  | { type: 'meta'; now: string; refs: string[]; recall: { status: string; records: number } }
  | { type: 'search'; id: string; queries: string[]; filters: string[] }
  | { type: 'search_done'; id: string; ms: number; results: number; cached: boolean; error?: string }
  | { type: 'text'; delta: string }
  | { type: 'citations'; verified: string[]; unverified: string[] }
  | { type: 'done'; turnId: string; sources: SourceRef[]; trace: Trace }
  | { type: 'error'; message: string };

export interface AgentDeps {
  model: ChatModel;
  search: SearchTool;
  ledger: Ledger;
  /** produces the memory digest for a finished turn; optional */
  digester?: (turn: Turn) => Promise<Digest | undefined>;
  clock?: Clock;
}

export interface RunInput {
  message: string;
  sessionId: string;
  userId?: string;
  tz?: string;
}

const HISTORY_TURNS = 12;
const MAX_TOKENS = 1600;

/** Which of the URLs the model wrote were actually returned by a search (or recalled from the ledger)? */
export function checkCitations(answer: string, seen: Set<string>): { verified: string[]; unverified: string[] } {
  const verified: string[] = [];
  const unverified: string[] = [];
  for (const u of extractUrls(answer)) (seen.has(normUrl(u)) ? verified : unverified).push(u);
  return { verified, unverified };
}

export class Agent {
  private pending = new Set<Promise<unknown>>();
  private clock: Clock;

  constructor(private readonly deps: AgentDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Resolves when background digest work is finished (tests, graceful shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private history(userId: string, sessionId: string): Message[] {
    const out: Message[] = [];
    for (const t of this.deps.ledger.sessionTurns(userId, sessionId, HISTORY_TURNS)) {
      out.push({ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant });
    }
    return out;
  }

  async run(input: RunInput, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<Turn | undefined> {
    const t0 = performance.now();
    const userId = input.userId ?? config.userId;
    const tz = validTz(input.tz) ?? validTz(config.defaultTz) ?? 'UTC';
    const now = this.clock();
    const today = ymdInTz(now, tz);
    const { ledger, model, search } = this.deps;

    const recall = buildRecall({ message: input.message, ledger, userId, sessionId: input.sessionId, now, tz });
    emit({
      type: 'meta',
      now: now.toISOString(),
      refs: recall.refLines,
      recall: { status: recall.status, records: recall.hits.filter((h) => h.strength === 'strong').length },
    });

    const messages: Message[] = [...this.history(userId, input.sessionId), { role: 'user', content: input.message }];
    const system = [{ text: SYSTEM_PROMPT, cache: true }, { text: dynamicBlock(now, tz, recall.block) }];

    // URLs the model is allowed to cite: everything a search returned this turn + sources in recalled records.
    const seen = new Set<string>();
    for (const h of recall.hits) for (const s of h.turn.sources) seen.add(normUrl(s.url));
    const sources = new Map<string, SourceRef>();
    const queries: string[] = [];
    const trace: Trace = {
      rounds: 0,
      searches: [],
      ttftMs: null,
      totalMs: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      recall: recall.status,
      refs: recall.refLines,
    };

    let answer = '';
    let needBreak = false;

    try {
      for (let round = 1; round <= config.maxRounds; round++) {
        const allowTools = round < config.maxRounds;
        trace.rounds = round;
        const res = await model.complete(
          { system, messages, tools: [SEARCH_TOOL], allowTools, maxTokens: MAX_TOKENS, ...(signal ? { signal } : {}) },
          (delta) => {
            if (trace.ttftMs === null) trace.ttftMs = Math.round(performance.now() - t0);
            if (needBreak) {
              needBreak = false;
              if (answer && !answer.endsWith('\n')) {
                answer += '\n\n';
                emit({ type: 'text', delta: '\n\n' });
              }
            }
            answer += delta;
            emit({ type: 'text', delta });
          },
        );
        for (const k of Object.keys(trace.usage) as (keyof Usage)[]) trace.usage[k] += res.usage[k];

        const calls = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (!calls.length || !allowTools) break;
        if (res.content.some((b) => b.type === 'text' && b.text.trim())) needBreak = true;

        messages.push({ role: 'assistant', content: res.content as Block[] });
        const results: ToolResultBlock[] = await Promise.all(
          calls.map(async (call, idx): Promise<ToolResultBlock> => {
            if (idx >= config.maxToolCallsPerRound) {
              return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Too many tool calls in one round; put all searches into a single web_search call.' };
            }
            if (call.name !== SEARCH_TOOL.name) {
              return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Unknown tool "${call.name}". The only tool is web_search.` };
            }
            const ctx = { now, tz, ...(signal ? { signal } : {}) };
            const { items, warnings } = search.parse(call.input, ctx);
            emit({
              type: 'search',
              id: call.id,
              queries: items.map((i: SearchItem) => i.query),
              filters: [...new Set(items.flatMap(describeFilters))],
            });
            const out = await search.execute(items, warnings, ctx);
            for (const s of out.sources) {
              seen.add(normUrl(s.url));
              if (!sources.has(normUrl(s.url))) sources.set(normUrl(s.url), s);
            }
            for (const r of out.reports) {
              queries.push(r.query);
              trace.searches.push({ queries: [r.query], ms: r.ms, results: r.hits, cached: r.cached, ...(r.error ? { error: r.error } : {}) });
            }
            emit({
              type: 'search_done',
              id: call.id,
              ms: Math.max(0, ...out.reports.map((r) => r.ms)),
              results: out.sources.length,
              cached: out.reports.length > 0 && out.reports.every((r) => r.cached),
              ...(out.isError ? { error: out.reports.find((r) => r.error)?.error ?? 'search failed' } : {}),
            });
            return { type: 'tool_result', tool_use_id: call.id, content: out.text, ...(out.isError ? { is_error: true } : {}) };
          }),
        );
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      if (signal?.aborted) return undefined;
      emit({ type: 'error', message: friendlyError(e) });
      return undefined;
    }

    if (signal?.aborted) return undefined;

    if (!answer.trim()) {
      answer = "I wasn't able to put together an answer within my search budget. Could you narrow the question a little, or ask it again?";
      emit({ type: 'text', delta: answer });
    }

    const cites = checkCitations(answer, seen);
    emit({ type: 'citations', ...cites });

    const turn: Turn = {
      id: uid(),
      userId,
      sessionId: input.sessionId,
      ts: now.toISOString(),
      tz,
      localDate: today,
      user: input.message,
      assistant: answer,
      queries,
      sources: [...sources.values()].slice(0, 12),
    };
    ledger.add(turn);
    trace.totalMs = Math.round(performance.now() - t0);
    emit({ type: 'done', turnId: turn.id, sources: turn.sources, trace });

    // Off the hot path: the user already has their answer.
    const { digester } = this.deps;
    if (digester) {
      const p = digester(turn)
        .then((d) => {
          if (d) ledger.setDigest(turn.id, d);
        })
        .catch(() => undefined)
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
    return turn;
  }
}

function friendlyError(e: unknown): string {
  const status = (e as { status?: number })?.status;
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403 || /api key not valid|api_key_invalid/i.test(msg)) {
    return `The model API key was rejected. Check your ${config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} in .env.`;
  }
  if (status === 404) return `The model was not found (404). Set MODEL in .env to one your account can use. (${msg})`;
  if (status === 429) {
    return config.provider === 'gemini'
      ? 'The free Gemini quota is used up for now (per-minute or per-day limit). Wait a minute and try again; the daily limit resets at midnight Pacific time. Switching MODEL to a Flash-Lite model gives a much higher daily limit.'
      : 'The model is rate-limited right now. Try again in a few seconds.';
  }
  if (status === 529 || status === 503) return 'The model is busy right now. Try again in a few seconds.';
  return `Something went wrong: ${msg}`;
}
