/**
 * Deterministic resolver for time expressions in a user's message.
 *
 * LLMs are unreliable at calendar arithmetic ("last Tuesday" said on a Wednesday). So the harness
 * resolves every relative or partial date to concrete calendar days *before* the model runs, and
 * hands the model the answer. Genuinely ambiguous phrases keep every candidate; the recall layer
 * lets the user's own history break the tie, and otherwise the default is stated out loud.
 */
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  fmtDay,
  isValidYmd,
  mondayOf,
  relDay,
  weekday,
  ymd,
} from './clock.js';

export interface Candidate {
  /** inclusive, YYYY-MM-DD */
  start: string;
  end: string;
  label: string;
}

export interface TemporalRef {
  phrase: string;
  /** offset of the phrase in the original message */
  index: number;
  /** candidates[0] is the default reading */
  candidates: Candidate[];
  ambiguous: boolean;
  note?: string;
}

type Resolution = Pick<TemporalRef, 'candidates' | 'ambiguous' | 'note'>;

const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri)';
const NUM_RE = '(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const monthOf = (s: string): number => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
const wdOf = (s: string): number => WEEKDAYS.indexOf(s.slice(0, 3).toLowerCase());
const numOf = (s: string): number => (/^\d+$/.test(s) ? Number(s) : (WORDS[s.toLowerCase()] ?? 0));

const day = (d: string, label: string): Candidate => ({ start: d, end: d, label });
const range = (start: string, end: string, label: string): Candidate => ({ start, end, label });
const single = (c: Candidate, note?: string): Resolution => ({ candidates: [c], ambiguous: false, ...(note ? { note } : {}) });

const WD_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Most recent `w` strictly before `today`. */
function mostRecentBefore(today: string, w: number): string {
  let d = (weekday(today) - w + 7) % 7;
  if (d === 0) d = 7;
  return addDays(today, -d);
}
/** First `w` strictly after `today`. */
function nextAfter(today: string, w: number): string {
  let d = (w - weekday(today) + 7) % 7;
  if (d === 0) d = 7;
  return addDays(today, d);
}
/** `w` within the ISO (Mon–Sun) week that starts at `monday`. */
const inWeek = (monday: string, w: number): string => addDays(monday, (w + 6) % 7);

function monthDay(m: number, d: number, yearStr: string | undefined, today: string): Resolution | null {
  if (yearStr) {
    let y = Number(yearStr);
    if (y < 100) y += 2000;
    return isValidYmd(y, m, d) ? single(day(ymd(y, m, d), 'explicit date')) : null;
  }
  const ty = Number(today.slice(0, 4));
  const cur = isValidYmd(ty, m, d) ? ymd(ty, m, d) : null;
  if (cur && cur <= today) return single(day(cur, 'this year'));
  const prev = isValidYmd(ty - 1, m, d) ? ymd(ty - 1, m, d) : null;
  const cands: Candidate[] = [];
  if (prev) cands.push(day(prev, 'last year'));
  if (cur) cands.push(day(cur, 'this year (upcoming)'));
  if (!cands.length) return null;
  return {
    candidates: cands,
    ambiguous: cands.length > 1,
    note: 'no year given and that date has not happened yet this year, so last year is the default',
  };
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpMatchArray, today: string) => Resolution | null;
}

const RULES: Rule[] = [
  // 2026-11-03
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m) => (isValidYmd(+m[1]!, +m[2]!, +m[3]!) ? single(day(ymd(+m[1]!, +m[2]!, +m[3]!), 'ISO date')) : null),
  },
  // 3 November, 3rd of Nov 2025
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, today) => monthDay(monthOf(m[2]!), Number(m[1]), m[3], today),
  },
  // November 3, Nov 3rd, 2025
  {
    re: new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, today) => monthDay(monthOf(m[1]!), Number(m[2]), m[3], today),
  },
  // 03/11/2026 (read as DD/MM; only with a year, so "3/4 of the team" is never a date)
  {
    re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g,
    resolve: (m) => {
      const [d, mo] = [Number(m[1]), Number(m[2])];
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      if (!isValidYmd(y, mo, d)) return null;
      return single(day(ymd(y, mo, d), 'numeric date'), d <= 12 && mo <= 12 && d !== mo ? 'read as DD/MM/YYYY' : undefined);
    },
  },
  {
    re: /\b(today|earlier today|this (?:morning|afternoon|evening)|tonight|just now)\b/gi,
    resolve: (_m, today) => single(day(today, 'today')),
  },
  { re: /\bday before yesterday\b/gi, resolve: (_m, t) => single(day(addDays(t, -2), 'two days ago')) },
  { re: /\b(yesterday|last night)\b/gi, resolve: (_m, t) => single(day(addDays(t, -1), 'yesterday')) },
  { re: /\btomorrow\b/gi, resolve: (_m, t) => single(day(addDays(t, 1), 'tomorrow')) },
  // 3 days ago, two weeks ago, a month ago
  {
    re: new RegExp(`\\b${NUM_RE}\\s+(day|week|month|year)s?\\s+ago\\b`, 'gi'),
    resolve: (m, today) => {
      const n = numOf(m[1]!);
      if (!n) return null;
      const unit = m[2]!.toLowerCase();
      if (unit === 'day') return single(day(addDays(today, -n), `${n} days ago`));
      if (unit === 'week') return single(day(addDays(today, -7 * n), `${n} weeks ago`), 'approximate: exactly 7×N days back');
      if (unit === 'month') return single(day(addMonths(today, -n), `${n} months ago`), 'approximate: same day-of-month');
      return single(day(addMonths(today, -12 * n), `${n} years ago`), 'approximate: same date');
    },
  },
  // the last 10 days / past 2 weeks
  {
    re: new RegExp(`\\b(?:last|past|previous)\\s+${NUM_RE}\\s+(days?|weeks?|months?)\\b`, 'gi'),
    resolve: (m, today) => {
      const n = numOf(m[1]!);
      if (!n) return null;
      const u = m[2]!.toLowerCase();
      const start = u.startsWith('day') ? addDays(today, -n) : u.startsWith('week') ? addDays(today, -7 * n) : addMonths(today, -n);
      return single(range(start, today, `last ${n} ${u}`));
    },
  },
  {
    re: /\b(?:last|previous|past)\s+(week|month)\b/gi,
    resolve: (m, today) => {
      if (m[1]!.toLowerCase() === 'week') {
        const start = addDays(mondayOf(today), -7);
        return single(range(start, addDays(start, 6), 'previous Mon–Sun week'));
      }
      const [y, mo] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
      const py = mo === 1 ? y - 1 : y;
      const pm = mo === 1 ? 12 : mo - 1;
      return single(range(ymd(py, pm, 1), ymd(py, pm, daysInMonth(py, pm)), 'previous calendar month'));
    },
  },
  {
    re: /\bthis\s+(week|month)\b/gi,
    resolve: (m, today) =>
      m[1]!.toLowerCase() === 'week'
        ? single(range(mondayOf(today), today, 'this week so far'))
        : single(range(`${today.slice(0, 7)}-01`, today, 'this month so far')),
  },
  // last Tuesday — "Tuesday of last week" by default, "the most recent Tuesday" as the alternative
  {
    re: new RegExp(`\\b(?:last|previous|past)\\s+${WEEKDAY_RE}\\b`, 'gi'),
    resolve: (m, today) => {
      const w = wdOf(m[1]!);
      const recent = mostRecentBefore(today, w);
      const lastWeek = inWeek(addDays(mondayOf(today), -7), w);
      if (recent === lastWeek) return single(day(recent, `${WD_NAME[w]} of last week`));
      // Three or more days back, "last Tuesday" almost always means the most recent one.
      if (diffDays(today, recent) >= 3) return single(day(recent, `the most recent ${WD_NAME[w]}`));
      return {
        candidates: [day(lastWeek, `${WD_NAME[w]} of last week`), day(recent, `the most recent ${WD_NAME[w]}`)],
        ambiguous: true,
        note: `"last ${WD_NAME[w]}" is ambiguous this early in the week`,
      };
    },
  },
  {
    re: new RegExp(`\\bthis\\s+${WEEKDAY_RE}\\b`, 'gi'),
    resolve: (m, today) => single(day(inWeek(mondayOf(today), wdOf(m[1]!)), `${WD_NAME[wdOf(m[1]!)]} of this week`)),
  },
  {
    re: new RegExp(`\\bnext\\s+${WEEKDAY_RE}\\b`, 'gi'),
    resolve: (m, today) => {
      const w = wdOf(m[1]!);
      const upcoming = nextAfter(today, w);
      const nextWeek = inWeek(addDays(mondayOf(today), 7), w);
      if (upcoming === nextWeek) return single(day(upcoming, `next ${WD_NAME[w]}`));
      return {
        candidates: [day(upcoming, `the upcoming ${WD_NAME[w]}`), day(nextWeek, `${WD_NAME[w]} of next week`)],
        ambiguous: true,
        note: `"next ${WD_NAME[w]}" is ambiguous`,
      };
    },
  },
  // bare weekday: on Monday — past-biased, because this layer exists to resolve recall
  {
    re: new RegExp(`\\b${WEEKDAY_RE}\\b`, 'gi'),
    resolve: (m, today) => {
      const w = wdOf(m[1]!);
      if (weekday(today) === w) {
        return {
          candidates: [day(today, `today (${WD_NAME[w]})`), day(addDays(today, -7), `last ${WD_NAME[w]}`)],
          ambiguous: true,
          note: `today is a ${WD_NAME[w]}`,
        };
      }
      const past = mostRecentBefore(today, w);
      const upcoming = nextAfter(today, w);
      return single(day(past, `most recent ${WD_NAME[w]}`), `assumed the past one; the upcoming ${WD_NAME[w]} is ${fmtDay(upcoming)}`);
    },
  },
];

/** Find and resolve every time expression in `text`, relative to `today` (YYYY-MM-DD in the user's zone). */
export function resolveTemporal(text: string, today: string): TemporalRef[] {
  interface Found {
    start: number;
    end: number;
    phrase: string;
    res: Resolution;
  }
  const found: Found[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const res = rule.resolve(m, today);
      if (res && m.index !== undefined) found.push({ start: m.index, end: m.index + m[0].length, phrase: m[0], res });
    }
  }
  // Longest match wins; anything overlapping an accepted match is dropped ("last Tuesday" beats "Tuesday").
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: Found[] = [];
  for (const f of found) {
    if (!accepted.some((a) => f.start < a.end && a.start < f.end)) accepted.push(f);
  }
  return accepted
    .sort((a, b) => a.start - b.start)
    .map((f) => ({ phrase: f.phrase, index: f.start, ...f.res }));
}

const fmtCand = (c: Candidate, today: string): string =>
  c.start === c.end ? `${fmtDay(c.start)} (${relDay(c.start, today)})` : `${fmtDay(c.start)} to ${fmtDay(c.end)}`;

/** Human/LLM-readable line for one resolved reference. `chosen` (if given) is shown as the reading in force. */
export function describeRef(ref: TemporalRef, today: string, chosen?: Candidate): string {
  const first = chosen ?? ref.candidates[0]!;
  const rest = ref.candidates.filter((c) => c !== first);
  let s = `"${ref.phrase}" = ${fmtCand(first, today)}`;
  if (rest.length) s += `; other reading: ${rest.map((c) => fmtCand(c, today)).join(' / ')}`;
  if (ref.note) s += ` (${ref.note})`;
  return s;
}
