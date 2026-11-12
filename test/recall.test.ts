import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, tokenize, type Turn } from '../src/ledger.js';
import { buildRecall } from '../src/recall.js';
import { parseDigest } from '../src/digest.js';

const NOW = new Date('2026-11-11T10:20:00Z'); // Wed 11 Nov 2026, 15:50 in Kolkata
const TZ = 'Asia/Kolkata';
let n = 0;
const turn = (localDate: string, user: string, assistant: string, extra: Partial<Turn> = {}): Turn => ({
  id: `t${++n}`, userId: 'u', sessionId: `s-${localDate}`, ts: `${localDate}T06:00:00.000Z`, tz: TZ, localDate,
  user, assistant, queries: [], sources: [], ...extra,
});
const recall = (ledger: Ledger, message: string) => buildRecall({ message, ledger, userId: 'u', sessionId: 'now', now: NOW, tz: TZ });

function seeded(): Ledger {
  const l = new Ledger(null);
  l.add(turn('2026-11-09', 'We are a 20-person sales team. Shortlist five CRM tools.', 'HubSpot, Pipedrive, Salesforce, Zoho, Close. HubSpot Starter is $20/seat.', {
    digest: { topic: 'CRM shortlist', entities: ['HubSpot'], userStated: ['shortlisted five CRM tools'], claims: [{ text: 'HubSpot Starter is $20 per seat', volatile: true }] },
  }));
  l.add(turn('2026-11-03', 'Compare managed Postgres hosting pricing: Neon, Supabase, RDS.', 'Neon from $19/mo, Supabase Pro $25/mo.'));
  l.add(turn('2026-11-03', 'Explain B-tree vs hash index', 'B-tree supports ranges.'));
  return l;
}

test('tokenizer drops filler and keeps product names', () => {
  assert.deepEqual(tokenize('What did I ask you about Postgres hosting last Tuesday?'), ['postgre', 'hosting'.replace(/ing$/, '')]);
});

test('recall finds the CRM shortlist from "On Monday we shortlisted…"', () => {
  const r = recall(seeded(), 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?');
  assert.equal(r.status, 'found');
  assert.match(r.block, /HubSpot Starter is \$20/);
  assert.match(r.block, /Mon 9 Nov 2026/);
  assert.match(r.block, /likely to have changed/);
});

test('ambiguous "last Tuesday" is settled by the ledger', () => {
  const r = recall(seeded(), 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
  assert.equal(r.status, 'found');
  assert.match(r.block, /Neon from \$19/);
  assert.match(r.block, /Tue 3 Nov 2026/);
  assert.doesNotMatch(r.block, /B-tree/, 'a strong topic match must not drag in the unrelated same-day turn as a full record');
});

test('date-only recall lists everything from that day', () => {
  const r = recall(seeded(), 'What did I ask you on 3 November? Is your answer still correct today?');
  assert.equal(r.status, 'found');
  assert.match(r.block, /Postgres/);
  assert.match(r.block, /B-tree/);
});

test('an empty ledger yields an explicit NO-record notice, never a guess', () => {
  const r = recall(new Ledger(null), 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?');
  assert.equal(r.status, 'none');
  assert.match(r.block, /NO record/);
  assert.match(r.block, /Do not guess/);
  assert.match(r.block, /ledger is empty/);
});

test('a record on a different day is only offered as a weak match', () => {
  const l = new Ledger(null);
  l.add(turn('2026-10-01', 'Shortlist five CRM tools', 'HubSpot, Pipedrive...'));
  const r = recall(l, 'On Monday we shortlisted CRM tools. Anything changed?');
  assert.equal(r.status, 'partial');
  assert.match(r.block, /cannot find that exact conversation/);
  assert.match(r.block, /similar topic, different day/);
});

test('world questions that merely contain a date do not trigger memory', () => {
  const r = recall(seeded(), 'Who won the US election on 3 November?');
  assert.equal(r.status, 'not-requested');
  assert.equal(r.block, '');
  assert.equal(recall(seeded(), 'What is the capital of France?').block, '');
});

test('digest parsing tolerates fences and junk', () => {
  const d = parseDigest('```json\n{"topic":"CRMs","entities":["HubSpot"],"userStated":[],"claims":[{"text":"x costs $5","volatile":true},{"nope":1}]}\n```');
  assert.equal(d?.topic, 'CRMs');
  assert.equal(d?.claims.length, 1);
  assert.equal(parseDigest('no json here'), undefined);
});
