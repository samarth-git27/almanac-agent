/**
 * Calendar-date arithmetic done in code, never by the model.
 * Everything is expressed as "YYYY-MM-DD" strings (a calendar day in the user's time zone),
 * so there is no DST or UTC-offset drift in day arithmetic.
 */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const DAY_MS = 86_400_000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pad = (n: number): string => String(n).padStart(2, '0');
export const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

export function validTz(tz?: string | null): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function partsIn(d: Date, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

/** The calendar day an instant falls on in `tz`. */
export function ymdInTz(d: Date, tz: string): string {
  const p = partsIn(d, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

export function hmInTz(d: Date, tz: string): string {
  const p = partsIn(d, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

export function offsetInTz(d: Date, tz: string): string {
  const v = partsIn(d, tz, { timeZoneName: 'longOffset' }).timeZoneName ?? 'GMT';
  return v === 'GMT' ? '+00:00' : v.replace('GMT', '');
}

export function parseYmd(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

const toMs = (s: string): number => {
  const { y, m, d } = parseYmd(s);
  return Date.UTC(y, m - 1, d);
};
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (s: string, n: number): string => fromMs(toMs(s) + n * DAY_MS);
/** a − b in whole calendar days. */
export const diffDays = (a: string, b: string): number => Math.round((toMs(a) - toMs(b)) / DAY_MS);
/** 0 = Sunday … 6 = Saturday */
export const weekday = (s: string): number => new Date(toMs(s)).getUTCDay();
/** ISO week start (Monday) of the week containing `s`. */
export const mondayOf = (s: string): string => addDays(s, -((weekday(s) + 6) % 7));

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function addMonths(s: string, n: number): string {
  const { y, m, d } = parseYmd(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function fmtDay(s: string): string {
  const { y, m, d } = parseYmd(s);
  return `${WD[weekday(s)]} ${d} ${MON[m - 1]} ${y}`;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "in 4 days" … relative to `today` (both YYYY-MM-DD). */
export function relDay(s: string, today: string): string {
  const diff = diffDays(today, s);
  const n = Math.abs(diff);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff === -1) return 'tomorrow';
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  let span: string;
  if (n < 14) span = unit(n, 'day');
  else if (n < 60) span = unit(Math.floor(n / 7), 'week');
  else if (n < 700) span = unit(Math.floor(n / 30), 'month');
  else span = unit(Math.floor(n / 365), 'year');
  return diff > 0 ? `${span} ago` : `in ${span}`;
}

/** "Wed 11 Nov 2026, 15:48 (Asia/Calcutta, UTC+05:30)" */
export function nowLine(now: Date, tz: string): string {
  return `${fmtDay(ymdInTz(now, tz))}, ${hmInTz(now, tz)} (${tz}, UTC${offsetInTz(now, tz)})`;
}
