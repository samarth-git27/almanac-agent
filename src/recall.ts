/**
 * Recall: turn "what did I ask you on 3 November?" into evidence *before* the model runs.
 *
 * The agent has exactly one tool (web search), so memory cannot be a tool. It is a deterministic
 * pre-retrieval step instead: resolve the time references, look in the ledger, and inject either
 * the matching records or an explicit NO-RECORD notice. The notice is the important half: the most
 * common failure of chat agents here is inventing a plausible past ("your five CRMs were...").
 */
import { diffDays, fmtDay, hmInTz, relDay, ymdInTz } from './clock.js';
import { tokenize, type Ledger, type Turn } from './ledger.js';
import { describeRef, resolveTemporal, type Candidate, type TemporalRef } from './temporal.js';
import { hostOf, truncate } from './util.js';

/** Phrases that mean "you should know something from before". */
const CUE =
  /\b(did i|have i|i (?:asked|told|mentioned|said|wanted|was asking)|we (?:shortlisted|discussed|talked|picked|chose|decided|looked|went|compared|covered|made|had|spoke)|you (?:told|said|recommended|suggested|answered|gave|mentioned|picked)|last time|previous(?:ly)?|earlier|your (?:answer|recommendation|advice|shortlist|list|suggestion)s?|that (?:answer|list|shortlist|comparison|recommendation)|as (?:we|you) (?:discussed|said)|remember|recall|since (?:then|that|we|you|i)|back then|at that time|still correct|still true|still right)\b/i;

export interface RecallInput {
  message: string;
  ledger: Ledger;
  userId: string;
  sessionId: string;
  now: Date;
  tz: string;
}

export interface RecallHit {
  turn: Turn;
  strength: 'strong' | 'weak-date' | 'weak-topic';
  score: number;
}

export interface RecallPacket {
  status: 'not-requested' | 'found' | 'partial' | 'none';
  today: string;
  refs: TemporalRef[];
  /** the reading of each ambiguous phrase that the evidence (or the default) selected, keyed by ref.index */
  chosen: Map<number, Candidate>;
  /** one human-readable line per resolved time reference */
  refLines: string[];
  hits: RecallHit[];
  /** text for the model's context; empty when recall was not requested */
  block: string;
}

/** "What did I ask you on 3 November?" names a day, not a topic: whatever words follow are not search terms. */
const DATE_ONLY = /\bwhat (?:did|have|was|were) (?:i|we|my|our)\b.*\b(?:ask|asked|say|said|tell|told|discuss|discussed|mention|mentioned|question|questions|talk|talked)\b/i;

function contentTerms(message: string, refs: TemporalRef[]): string[] {
  if (refs.length && DATE_ONLY.test(message)) return [];
  let text = message;
  for (const r of [...refs].sort((a, b) => b.index - a.index)) {
    text = text.slice(0, r.index) + ' ' + text.slice(r.index + r.phrase.length);
  }
  return tokenize(text);
}

function head(turn: Turn, i: number, today: string): string {
  return `[R${i}] ${fmtDay(turn.localDate)} ${hmInTz(new Date(turn.ts), turn.tz)} (${relDay(turn.localDate, today)})`;
}

function fullRecord(h: RecallHit, i: number, today: string): string {
  const t = h.turn;
  const lines = [`${head(t, i, today)}${h.strength === 'strong' ? '' : ' [weak match]'}`];
  lines.push(`  User: "${truncate(t.user, 700)}"`);
  lines.push(`  You answered: "${truncate(t.assistant, 1500)}"`);
  const d = t.digest;
  if (d?.userStated.length) lines.push(`  User stated: ${d.userStated.map((s) => truncate(s, 200)).join('; ')}`);
  if (d?.claims.length) {
    lines.push(
      `  Claims you made then (as of ${fmtDay(t.localDate)}; * = likely to have changed): ` +
        d.claims.map((c) => `${c.volatile ? '*' : ''}${truncate(c.text, 220)}`).join(' | '),
    );
  }
  if (t.sources.length) {
    lines.push(`  Sources then: ${t.sources.slice(0, 4).map((s) => `${s.title ? truncate(s.title, 50) + ' ' : ''}<${s.url}> (${hostOf(s.url)})`).join(', ')}`);
  }
  return lines.join('\n');
}

function compactRecord(h: RecallHit, i: number, today: string): string {
  const t = h.turn;
  const tag = h.strength === 'weak-date' ? 'same day, different topic' : 'similar topic, different day';
  return `${head(t, i, today)} [${tag}] User: "${truncate(t.user, 220)}"`;
}

export function buildRecall(inp: RecallInput): RecallPacket {
  const today = ymdInTz(inp.now, inp.tz);
  const refs = resolveTemporal(inp.message, today);
  const cue = CUE.test(inp.message);
  const silent: RecallPacket = { status: 'not-requested', today, refs, chosen: new Map(), refLines: [], hits: [], block: '' };
  if (!refs.length && !cue) return silent;

  const terms = contentTerms(inp.message, refs);
  const need = Math.min(2, terms.length);
  const hits = new Map<string, RecallHit>();
  const chosen = new Map<number, Candidate>();

  for (const ref of refs) {
    // Evidence breaks ambiguity: if the ledger has activity in exactly one reading, that reading wins.
    const evals = ref.candidates.map((c) => {
      const turns = inp.ledger.window(inp.userId, c.start, c.end);
      const ranked = terms.length ? inp.ledger.rank(inp.userId, terms, turns) : [];
      const evidence = terms.length ? ranked.reduce((a, r) => a + (r.matched >= need ? r.score : 0), 0) : turns.length;
      return { c, turns, ranked, evidence };
    });
    let best = evals[0]!;
    for (const e of evals) if (e.evidence > best.evidence) best = e;
    chosen.set(ref.index, best.c);
    const scored = new Map(best.ranked.map((r) => [r.turn.id, r]));
    for (const t of best.turns) {
      const r = scored.get(t.id);
      const strong = terms.length === 0 || (r !== undefined && r.matched >= need);
      hits.set(t.id, { turn: t, strength: strong ? 'strong' : 'weak-date', score: r?.score ?? 0 });
    }
  }

  if (terms.length) {
    for (const r of inp.ledger.rank(inp.userId, terms).filter((x) => x.matched >= need).slice(0, 3)) {
      if (!hits.has(r.turn.id)) hits.set(r.turn.id, { turn: r.turn, strength: 'weak-topic', score: r.score });
    }
  }

  const list = [...hits.values()];
  const strong = list.filter((h) => h.strength === 'strong');
  const status: RecallPacket['status'] = strong.length ? 'found' : list.length ? 'partial' : 'none';

  // A message with a date but no "remember"-style cue ("what happened on 3 November?") is usually a
  // world question. Only inject memory then if it clearly matches on date AND topic.
  if (!cue && (terms.length === 0 || status !== 'found')) return { ...silent, refs, chosen };

  const refLines = refs.map((r) => describeRef(r, today, chosen.get(r.index)));
  const resolved = refLines.length ? `Time references resolved by the harness: ${refLines.join(' · ')}\n` : '';
  const ledgerSize = inp.ledger.all(inp.userId).length;

  let block: string;
  if (status === 'found') {
    const ordered = strong
      .sort((a, b) => b.score - a.score || a.turn.ts.localeCompare(b.turn.ts))
      .slice(0, terms.length ? 4 : 8)
      .sort((a, b) => a.turn.ts.localeCompare(b.turn.ts));
    // A date-only question ("what did I ask on 3 Nov?") lists the day's turns compactly, with the answer
    // for the newest few; a topical match gets full records. Weak matches are dropped once a strong one exists.
    const records = ordered.map((h, i) =>
      terms.length || i >= ordered.length - 3 ? fullRecord(h, i + 1, today) : compactRecord(h, i + 1, today),
    );
    block = [
      '<recall status="found">',
      resolved + "These are records of this user's EARLIER conversations with you, read from your persistent ledger. They are the only memory you have.",
      ...records,
      "How to use: speak about the past only from these records; never add details they don't contain. If asked whether something still holds, re-check each starred (volatile) claim with web_search — one search for the current state with no date filter, one with since = the record's date for what's new — then report per claim: still true / changed (what, when, link) / could not verify.",
      '</recall>',
    ].join('\n');
  } else if (status === 'partial') {
    block = [
      '<recall status="partial">',
      resolved + 'Your ledger has nothing that clearly matches what the user is referring to. Closest records (they may NOT be the conversation the user means):',
      ...list.slice(0, 3).map((h, i) => compactRecord(h, i + 1, today)),
      'Say plainly that you cannot find that exact conversation. If one of these looks right, ask "do you mean this one?" in a single line — do not assert it is the one, and do not fill in details it does not contain.',
      '</recall>',
    ].join('\n');
  } else {
    const anchor = [...chosen.values()][0]?.start ?? today;
    const near = inp.ledger.nearest(inp.userId, anchor, 3, diffDays);
    const nearLine = near.length
      ? `Closest recorded days: ${near.map((n) => `${fmtDay(n.date)} ("${truncate(n.turn.user, 70)}")`).join('; ')}.`
      : 'The ledger is empty: you have no recorded earlier conversations with this user at all.';
    block = [
      '<recall status="none">',
      resolved +
        `The user is referring to an earlier conversation, but your ledger holds NO record of it (${ledgerSize} recorded turn${ledgerSize === 1 ? '' : 's'} in total). You cannot see any conversation that is not listed here.`,
      nearLine,
      "Say so in your first sentence — plainly, once, no apology spiral. Do not guess or reconstruct what was said, and never present a guess as the user's own list or decision. Then be useful: ask for the missing specifics in one line, and if a sensible bridge exists (e.g. the leading options in that category) research it while labelling it clearly as your assumption, not their list.",
      '</recall>',
    ].join('\n');
  }

  return { status, today, refs, chosen, refLines, hits: list, block };
}
