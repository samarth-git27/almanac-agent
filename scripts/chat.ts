// Terminal chat: `npm run chat`. Same agent, same ledger as the web UI.
import { createInterface } from 'node:readline/promises';
import { createApp } from '../src/app.js';
import { config, missingKeys } from '../src/config.js';

const missing = missingKeys();
if (missing.length) {
  console.error(`Missing ${missing.join(' and ')} — copy .env.example to .env first.`);
  process.exit(1);
}
const { agent } = createApp();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const sessionId = `cli-${Date.now()}`;
console.log('Almanac (terminal). Ctrl+C to quit.\n');
for (;;) {
  const message = (await rl.question('you › ')).trim();
  if (!message) continue;
  process.stdout.write('\n');
  await agent.run({ message, sessionId, tz: config.defaultTz }, (e) => {
    if (e.type === 'text') process.stdout.write(e.delta);
    else if (e.type === 'search') process.stdout.write(`\x1b[2m  ⌕ ${e.queries.join(' · ')}\x1b[0m\n`);
    else if (e.type === 'citations' && e.unverified.length) process.stdout.write(`\n\x1b[33m  ⚠ unverified links: ${e.unverified.join(', ')}\x1b[0m`);
    else if (e.type === 'done') process.stdout.write(`\n\x1b[2m  ${e.trace.totalMs}ms · first token ${e.trace.ttftMs}ms · ${e.trace.rounds} round(s)\x1b[0m\n\n`);
    else if (e.type === 'error') process.stdout.write(`\n\x1b[31m${e.message}\x1b[0m\n\n`);
  });
}
