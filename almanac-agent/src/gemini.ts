/**
 * Gemini adapter (Google AI Studio REST API, streaming) behind the same tiny ChatModel interface.
 * Zero dependencies: plain fetch + SSE parsing.
 *
 * Things that are easy to get wrong, and handled here:
 *  - Gemini 3+ requires the `thoughtSignature` on a functionCall part to be echoed back unchanged,
 *    or the next request fails with HTTP 400. It rides along in ToolUseBlock.providerMeta.
 *  - functionResponse parts are matched to calls by *name*, not id, so we remember id → name.
 *  - Thought parts (`thought: true`) are never shown to the user.
 *  - Transient 500/503 (common on free tiers) and short 429 retry-after hints are retried once,
 *    but only before any text has streamed, so the user never sees a duplicated answer.
 */
import { ModelError, type ChatModel, type Message, type ModelRequest, type ModelResponse, type ToolDef, type Usage } from './model.js';
import { sleep } from './util.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GChunk {
  candidates?: { content?: { parts?: GPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
}

/** Keep only the JSON-Schema keywords Gemini's function declarations accept. */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const o = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['type', 'description', 'enum', 'required', 'minItems', 'maxItems'] as const) if (o[k] !== undefined) out[k] = o[k];
  if (o.properties && typeof o.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(o.properties as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (o.items) out.items = toGeminiSchema(o.items);
  return out;
}

export function toGeminiContents(messages: Message[]): { role: 'user' | 'model'; parts: GPart[] }[] {
  const names = new Map<string, string>(); // tool_use id → function name
  const out: { role: 'user' | 'model'; parts: GPart[] }[] = [];
  for (const m of messages) {
    const parts: GPart[] = [];
    if (typeof m.content === 'string') {
      if (m.content.trim()) parts.push({ text: m.content });
    } else {
      for (const b of m.content) {
        if (b.type === 'text') {
          if (b.text.trim()) parts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          names.set(b.id, b.name);
          const part: GPart = { functionCall: { name: b.name, args: b.input } };
          const sig = (b.providerMeta as { thoughtSignature?: string } | undefined)?.thoughtSignature;
          if (sig) part.thoughtSignature = sig;
          parts.push(part);
        } else {
          parts.push({
            functionResponse: {
              name: names.get(b.tool_use_id) ?? 'web_search',
              response: b.is_error ? { error: b.content } : { output: b.content },
            },
          });
        }
      }
    }
    if (parts.length) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

function toolDecls(tools: ToolDef[]): unknown {
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })) }];
}

async function failure(res: Response): Promise<{ error: ModelError; retryAfterMs: number }> {
  let message = `Gemini API error (HTTP ${res.status})`;
  let retryAfterMs = 0;
  try {
    const j = (await res.json()) as { error?: { message?: string; details?: { retryDelay?: string }[] } };
    if (j.error?.message) message = j.error.message;
    const delay = j.error?.details?.find((d) => typeof d.retryDelay === 'string')?.retryDelay;
    if (delay) retryAfterMs = Math.ceil(parseFloat(delay) * 1000) || 0;
  } catch {
    /* non-JSON error body */
  }
  return { error: new ModelError(message, res.status), retryAfterMs };
}

export class GeminiModel implements ChatModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = BASE,
  ) {}

  buildBody(req: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
    const system = req.system.map((p) => p.text).join('\n\n');
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools.length) {
      body.tools = toolDecls(req.tools);
      body.toolConfig = { functionCallingConfig: { mode: req.allowTools ? 'AUTO' : 'NONE' } };
    }
    return body;
  }

  async complete(req: ModelRequest, onText?: (delta: string) => void): Promise<ModelResponse> {
    const url = `${this.base}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(this.buildBody(req)),
      ...(req.signal ? { signal: req.signal } : {}),
    };

    let res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const { error, retryAfterMs } = await failure(res);
      const transient = res.status === 500 || res.status === 503;
      const shortQuota = res.status === 429 && retryAfterMs > 0 && retryAfterMs <= 4000;
      if (!transient && !shortQuota) throw error;
      await sleep(shortQuota ? retryAfterMs + 200 : 800);
      res = await this.fetchImpl(url, init);
      if (!res.ok) throw (await failure(res)).error;
    }
    if (!res.body) throw new ModelError('Gemini returned an empty response body.');

    const content: ModelResponse['content'] = [];
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let finish = 'end_turn';
    let blocked = '';
    let calls = 0;

    const onChunk = (c: GChunk): void => {
      if (c.promptFeedback?.blockReason) blocked = c.promptFeedback.blockReason;
      const u = c.usageMetadata;
      if (u) {
        usage.input = u.promptTokenCount ?? usage.input;
        usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || usage.output;
        usage.cacheRead = u.cachedContentTokenCount ?? usage.cacheRead;
      }
      const cand = c.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason.toLowerCase();
      for (const p of cand?.content?.parts ?? []) {
        if (p.thought) continue;
        if (p.functionCall?.name) {
          const sig = p.thoughtSignature ?? p.thought_signature;
          content.push({
            type: 'tool_use',
            id: `gem_${Date.now().toString(36)}_${calls++}`,
            name: p.functionCall.name,
            input: p.functionCall.args ?? {},
            ...(sig ? { providerMeta: { thoughtSignature: sig } } : {}),
          });
        } else if (typeof p.text === 'string' && p.text) {
          const last = content.at(-1);
          if (last?.type === 'text') last.text += p.text;
          else content.push({ type: 'text', text: p.text });
          onText?.(p.text);
        }
      }
    };

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const drain = (final: boolean): void => {
      buf = buf.replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0 || (final && buf.trim())) {
        const frame = i >= 0 ? buf.slice(0, i) : buf;
        buf = i >= 0 ? buf.slice(i + 2) : '';
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data || data === '[DONE]') continue;
        try {
          onChunk(JSON.parse(data) as GChunk);
        } catch {
          /* ignore a malformed frame rather than failing the turn */
        }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      drain(false);
    }
    buf += dec.decode();
    drain(true);

    if (!content.length && blocked) {
      content.push({ type: 'text', text: `I can't help with that request (the model provider blocked it: ${blocked.toLowerCase().replace(/_/g, ' ')}).` });
    }
    const hasCall = content.some((b) => b.type === 'tool_use');
    return { content, stopReason: hasCall ? 'tool_use' : finish, usage };
  }
}
