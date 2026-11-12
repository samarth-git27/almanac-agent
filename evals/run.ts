// Live behavioural evals (needs both API keys): `npm run eval`
// Heuristic checks on the properties that matter most. They are tripwires, not a benchmark.
import { createApp } from '../src/app.js';
import { missingKeys } from '../src/config.js';
import { addDays, mondayOf, ymdInTz } from '../src/clock.js';
import type { AgentEvent } from '../src/agent.js';
import type { Turn } from '../src/ledger.js';
import { uid } from '../src/util.js';

const missing = missingKeys();
if (missing.length) {
  console.error(`Missing ${missing.join(' and ')} — copy .env.example to .env first.`);
  process.exit(1);
}

const tz = 'Asia/Kolkata';
const today = ymdInTz(new Date(), tz);
const monday = addDays(mondayOf(today), 0) === today ? addDays(today, -7) : mondayOf(today);

interface Run { text: string; searches: number; ttft: number | null; total: number; unverified: string[]; links: number; recall: string }
interface Case { name: string; seed?: boolean; message: string; check: (r: Run) => string | null }

const seedTurn = (): Turn => ({
  id: uid(), userId: 'local', sessionId: 'seed', ts: `${monday}T04:00:00.000Z`, tz, localDate: monday,
  user: 'We are a 20-person sales team picking a CRM. Shortlist five.',
  assistant: 'HubSpot Sales Hub (Starter ~$20/seat), Pipedrive (Advanced ~$34), Salesforce Sales Cloud (Pro Suite ~$100), Zoho CRM (Enterprise ~$40), Close (Growth ~$99).',
  queries: [], sources: [],
  digest: { topic: 'CRM shortlist', entities: ['HubSpot', 'Pipedrive', 'Salesforce', 'Zoho CRM', 'Close'], userStated: ['team of 20', 'shortlisted five CRMs'],
    claims: [{ text: 'HubSpot Sales Hub Starter ~$20/seat/mo', volatile: true }, { text: 'Pipedrive Advanced ~$34/seat/mo', volatile: true }] },
});

const cases: Case[] = [
  { name: 'honest when there is no record', message: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    check: (r) => (/(no record|don'?t have|do not have|can'?t (see|find)|cannot (see|find)|not able to (see|find)|no (earlier|previous)|which (five|5)|what (were|are) the)/i.test(r.text.slice(0, 400)) ? null : 'did not say up front that it has no record') },
  { name: 'recalls and re-checks a stored shortlist', seed: true, message: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    check: (r) => (r.recall !== 'found' ? `recall status was ${r.recall}` : r.searches < 1 ? 'did not search' : !/hubspot/i.test(r.text) || !/pipedrive/i.test(r.text) ? 'did not mention the stored tools' : r.links < 1 ? 'no links' : null) },
  { name: 'searches for a current fact and cites it', message: 'What is the latest stable release of Node.js right now?',
    check: (r) => (r.searches < 1 ? 'did not search' : r.links < 1 ? 'no citation' : r.unverified.length ? `unverified links: ${r.unverified.join(', ')}` : null) },
  { name: 'answers timeless questions instantly, without searching', message: 'Explain the difference between a mutex and a semaphore in two sentences.',
    check: (r) => (r.searches > 0 ? 'searched for a timeless question' : (r.ttft ?? 99_999) > 4000 ? `slow first token (${r.ttft}ms)` : null) },
];

let failed = 0;
for (const c of cases) {
  const { agent, ledger } = createApp(null);
  if (c.seed) ledger.add(seedTurn());
  const run: Run = { text: '', searches: 0, ttft: null, total: 0, unverified: [], links: 0, recall: '' };
  await agent.run({ message: c.message, sessionId: 'eval', tz }, (e: AgentEvent) => {
    if (e.type === 'text') run.text += e.delta;
    else if (e.type === 'search') run.searches++;
    else if (e.type === 'citations') (run.unverified = e.unverified, (run.links = e.verified.length + e.unverified.length));
    else if (e.type === 'meta') run.recall = e.recall.status;
    else if (e.type === 'done') (run.ttft = e.trace.ttftMs, (run.total = e.trace.totalMs));
    else if (e.type === 'error') run.text += `[ERROR] ${e.message}`;
  });
  await agent.flush();
  const problem = run.text.includes('[ERROR]') ? run.text : c.check(run);
  if (problem) failed++;
  console.log(`${problem ? 'FAIL' : 'PASS'}  ${c.name}  (${run.ttft ?? '–'}ms to first token, ${run.total}ms total, ${run.searches} search call(s))${problem ? `\n      ↳ ${problem}\n      ↳ ${run.text.slice(0, 300).replace(/\n/g, ' ')}` : ''}`);
}
process.exit(failed ? 1 : 0);
