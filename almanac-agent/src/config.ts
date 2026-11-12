import { existsSync } from 'node:fs';

// Zero-dependency .env loading (Node >= 20.12).
if (existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* a malformed .env should not crash boot; missing keys are reported below */
  }
}

const env = (k: string): string | undefined => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

const geminiKey = env('GEMINI_API_KEY') ?? env('GOOGLE_API_KEY');
const anthropicKey = env('ANTHROPIC_API_KEY');
export type Provider = 'gemini' | 'anthropic';
const forced = env('PROVIDER')?.toLowerCase();
/** PROVIDER wins if set; otherwise whichever key is present (Gemini first, since it has a free tier). */
const provider: Provider = forced === 'anthropic' || forced === 'gemini' ? forced : geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : 'gemini';

export const config = {
  port: Number(env('PORT') ?? 3000),
  provider,
  geminiKey,
  anthropicKey,
  tavilyKey: env('TAVILY_API_KEY'),
  // Gemini default is Flash-Lite: the free tier's daily request cap is far higher than for Flash.
  model: env('MODEL') ?? (provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'claude-sonnet-5-5'),
  ledgerModel: env('LEDGER_MODEL') ?? (provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'claude-haiku-5-5'),
  defaultTz: env('DEFAULT_TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  dataDir: env('DATA_DIR') ?? './data',
  /** Hard cap on model rounds per turn. The last round has tools disabled, so a turn always ends in an answer. */
  maxRounds: 4,
  /** Hard cap on tool_use blocks executed per round. */
  maxToolCallsPerRound: 2,
  maxMessageChars: 4000,
  userId: 'local',
};

export function missingKeys(): string[] {
  const missing: string[] = [];
  if (config.provider === 'gemini' && !config.geminiKey) missing.push('GEMINI_API_KEY (free at aistudio.google.com) or ANTHROPIC_API_KEY');
  if (config.provider === 'anthropic' && !config.anthropicKey) missing.push('ANTHROPIC_API_KEY');
  if (!config.tavilyKey) missing.push('TAVILY_API_KEY');
  return missing;
}
