/**
 * The ledger: an append-only JSONL log of every conversation turn, with a small in-memory BM25 index.
 *
 * Why JSONL and not a database: zero native dependencies (`npm install` must always work), crash-safe
 * appends, trivially inspectable by a human, and the working set (one person's chat history) is tiny.
 * Why not embeddings: they need a second API and a vector store, and recall questions are mostly
 * "date + keywords", which BM25 plus the deterministic date resolver covers exactly.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface SourceRef {
  url: string;
  title?: string;
  published?: string;
}

export interface Digest {
  topic: string;
  entities: string[];
  /** Things the user stated or decided in this turn ("shortlisted: HubSpot, Pipedrive, …"). */
  userStated: string[];
  /** Things the assistant asserted, each self-contained. `volatile` = likely to go stale (prices, versions, news). */
  claims: { text: string; volatile: boolean }[];
}

export interface Turn {
  id: string;
  userId: string;
  sessionId: string;
  /** ISO-8601 UTC instant */
  ts: string;
  tz: string;
  /** Calendar day in the user's zone at the time, YYYY-MM-DD. Date lookups use this, not `ts`. */
  localDate: string;
  user: string;
  assistant: string;
  queries: string[];
  sources: SourceRef[];
  digest?: Digest;
}

type Line = ({ k: 'turn' } & Turn) | { k: 'digest'; turnId: string; digest: Digest };

const STOP = new Set(
  (
    'a an the and or but if then so of to in on at by for with about from into over after before between ' +
    'is are was were be been being am do does did done have has had having will would should could can may might must ' +
    'i me my mine we us our ours you your yours he she it its they them their this that these those there here ' +
    'what which who whom whose when where why how any some all each every both either neither no not only just also very ' +
    'ask asked asking tell told said say remember recall mention mentioned talk talked discuss discussed ' +
    'something anything everything thing things one ones than too as up out off again still yet ever since ' +
    'last previous earlier ago today yesterday tomorrow week month year day days weeks months years ' +
    'monday tuesday wednesday thursday friday saturday sunday ' +
    'like want need get got let please hey hi hello thanks thank ok okay big new ' +
    'answer answers correct incorrect right wrong true accurate valid anymore now current currently latest ' +
    'change changed changes changing update updated updates since then still different same'
  ).split(/\s+/),
);

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Lower-cased, stop-worded, lightly stemmed terms. */
export function tokenize(s: string): string[] {
  const raw = s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return raw.filter((t) => !STOP.has(t) && t.length > 1 && !/^\d$/.test(t)).map(stem);
}

export interface Ranked {
  turn: Turn;
  score: number;
  /** how many distinct query terms the turn contains */
  matched: number;
}

function docText(t: Turn): string {
  const d = t.digest;
  return [t.user, t.assistant, d?.topic, d?.entities.join(' '), d?.userStated.join(' '), d?.claims.map((c) => c.text).join(' ')]
    .filter(Boolean)
    .join('\n');
}

export class Ledger {
  private turns: Turn[] = [];
  private byId = new Map<string, Turn>();
  private file: string | null;
  private tfCache = new Map<string, { tf: Map<string, number>; len: number }>();

  /** `dir = null` gives a pure in-memory ledger (tests). */
  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, 'ledger.jsonl') : null;
    if (this.file) {
      mkdirSync(dir!, { recursive: true });
      if (existsSync(this.file)) this.load();
    }
  }

  private load(): void {
    const text = readFileSync(this.file!, 'utf8');
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // a torn final line from a crash must never block boot
      }
      if (line.k === 'turn') {
        const { k: _k, ...turn } = line;
        this.index(turn);
      } else if (line.k === 'digest') {
        const t = this.byId.get(line.turnId);
        if (t) t.digest = line.digest;
      }
    }
  }

  private index(turn: Turn): void {
    this.turns.push(turn);
    this.byId.set(turn.id, turn);
  }

  private write(line: Line): void {
    if (this.file) appendFileSync(this.file, JSON.stringify(line) + '\n');
  }

  add(turn: Turn): void {
    this.index(turn);
    this.write({ k: 'turn', ...turn });
  }

  setDigest(turnId: string, digest: Digest): void {
    const t = this.byId.get(turnId);
    if (!t) return;
    t.digest = digest;
    this.tfCache.delete(turnId);
    this.write({ k: 'digest', turnId, digest });
  }

  get(id: string): Turn | undefined {
    return this.byId.get(id);
  }

  all(userId: string): Turn[] {
    return this.turns.filter((t) => t.userId === userId);
  }

  /** Turns whose local calendar day falls in [start, end], oldest first. */
  window(userId: string, start: string, end: string): Turn[] {
    return this.turns
      .filter((t) => t.userId === userId && t.localDate >= start && t.localDate <= end)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  sessionTurns(userId: string, sessionId: string, limit: number): Turn[] {
    return this.turns
      .filter((t) => t.userId === userId && t.sessionId === sessionId)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-limit);
  }

  /** The `n` distinct recorded days closest to `date`, each with its latest turn. */
  nearest(userId: string, date: string, n: number, dist: (a: string, b: string) => number): { date: string; turn: Turn }[] {
    const byDay = new Map<string, Turn>();
    for (const t of this.all(userId)) {
      const cur = byDay.get(t.localDate);
      if (!cur || cur.ts < t.ts) byDay.set(t.localDate, t);
    }
    return [...byDay.entries()]
      .map(([d, turn]) => ({ date: d, turn, d: Math.abs(dist(d, date)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map(({ date: d, turn }) => ({ date: d, turn }));
  }

  private stats(t: Turn): { tf: Map<string, number>; len: number } {
    let s = this.tfCache.get(t.id);
    if (!s) {
      const tf = new Map<string, number>();
      const toks = tokenize(docText(t));
      for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
      s = { tf, len: toks.length };
      this.tfCache.set(t.id, s);
    }
    return s;
  }

  /**
   * BM25 over `subset`, with IDF computed on the user's whole history so scores mean the same
   * thing whether we search one day or everything. Terms are query *terms* (already tokenized).
   */
  rank(userId: string, terms: string[], subset?: Turn[]): Ranked[] {
    const uniq = [...new Set(terms)];
    if (!uniq.length) return [];
    const corpus = this.all(userId);
    const docs = subset ?? corpus;
    if (!corpus.length || !docs.length) return [];
    const stats = corpus.map((t) => this.stats(t));
    const avgdl = stats.reduce((a, s) => a + s.len, 0) / corpus.length || 1;
    const N = corpus.length;
    const df = new Map<string, number>();
    for (const term of uniq) df.set(term, stats.filter((s) => s.tf.has(term)).length);
    const k1 = 1.4;
    const b = 0.75;
    const out: Ranked[] = [];
    for (const turn of docs) {
      const s = this.stats(turn);
      let score = 0;
      let matched = 0;
      for (const term of uniq) {
        const f = s.tf.get(term) ?? 0;
        if (!f) continue;
        matched++;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * s.len) / avgdl));
      }
      if (score > 0) out.push({ turn, score, matched });
    }
    return out.sort((a, b2) => b2.score - a.score);
  }
}
