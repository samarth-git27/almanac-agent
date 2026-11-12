import Anthropic from '@anthropic-ai/sdk';
import { Agent } from './agent.js';
import { config } from './config.js';
import { digestTurn } from './digest.js';
import { GeminiModel } from './gemini.js';
import { Ledger } from './ledger.js';
import { AnthropicModel, type ChatModel } from './model.js';
import { SearchTool, TavilyProvider } from './search.js';

/** One provider, two model sizes: the main model talks to the user, the digest model writes memory. */
function makeModels(): { main: ChatModel; digest: ChatModel } {
  if (config.provider === 'gemini') {
    return { main: new GeminiModel(config.geminiKey!, config.model), digest: new GeminiModel(config.geminiKey!, config.ledgerModel) };
  }
  const client = new Anthropic({ apiKey: config.anthropicKey! });
  return { main: new AnthropicModel(client, config.model), digest: new AnthropicModel(client, config.ledgerModel) };
}

/** Wire real dependencies. Callers must have checked `missingKeys()` first. */
export function createApp(dataDir: string | null = config.dataDir): { agent: Agent; ledger: Ledger } {
  const ledger = new Ledger(dataDir);
  const { main, digest } = makeModels();
  const agent = new Agent({
    model: main,
    search: new SearchTool(new TavilyProvider(config.tavilyKey!)),
    ledger,
    digester: (turn) => digestTurn(digest, turn),
  });
  return { agent, ledger };
}
