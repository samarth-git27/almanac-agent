import { randomUUID } from 'node:crypto';

export const uid = (): string => randomUUID();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Canonical form of a URL for "have we seen this page?" comparisons. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$)/i.test(k)) x.searchParams.delete(k);
    }
    const host = x.hostname.toLowerCase().replace(/^www\./, '');
    const path = x.pathname.replace(/\/+$/, '');
    return host + path + (x.search || '');
  } catch {
    return u.trim().toLowerCase();
  }
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** Pull every http(s) URL out of markdown-ish text (links and bare URLs), exactly as written. */
export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (m[1]) out.add(m[1]);
  for (const m of text.matchAll(/(?<![(\w])(https?:\/\/[^\s)\]>"'<]+)/g)) {
    if (m[1]) out.add(m[1].replace(/[.,;:!?]+$/, ''));
  }
  return [...out];
}
