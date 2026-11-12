// OPTIONAL demo data: `npm run seed` writes a few clearly-labelled past conversations into the ledger
// (a CRM shortlist "last Monday", a Postgres-hosting chat "last Tuesday", a chat on 3 Nov) so you can
// try recall questions without waiting a week. It never runs automatically. Delete data/ to reset.
import { addDays, mondayOf, ymdInTz } from '../src/clock.js';
import { config } from '../src/config.js';
import { Ledger, type Turn } from '../src/ledger.js';
import { uid } from '../src/util.js';

const tz = config.defaultTz;
const today = ymdInTz(new Date(), tz);
const lastMonday = addDays(mondayOf(today), -7);
const lastTuesday = addDays(lastMonday, 1);
const at = (d: string, hhmm: string): string => new Date(`${d}T${hhmm}:00Z`).toISOString();

const mk = (d: string, hhmm: string, user: string, assistant: string, digest: Turn['digest']): Turn => ({
  id: uid(), userId: config.userId, sessionId: `seed-${d}`, ts: at(d, hhmm), tz, localDate: d,
  user, assistant, queries: [], sources: [], digest,
});

const turns: Turn[] = [
  mk(lastMonday, '09:30',
    'We are a 20-person sales team picking a CRM. Shortlist five for me.',
    'For a 20-seat sales team I would shortlist: HubSpot Sales Hub (Starter about $20/seat/mo), Pipedrive (Advanced about $34/seat/mo), Salesforce Sales Cloud (Pro Suite about $100/seat/mo), Zoho CRM (Enterprise about $40/seat/mo) and Close (Growth about $99/seat/mo). Pipedrive and Close are the lightest to adopt; Salesforce has the deepest customisation.',
    { topic: 'CRM shortlist for 20-person sales team', entities: ['HubSpot', 'Pipedrive', 'Salesforce', 'Zoho CRM', 'Close'],
      userStated: ['team of 20 salespeople', 'shortlisted five CRM tools: HubSpot, Pipedrive, Salesforce, Zoho CRM, Close'],
      claims: [{ text: 'HubSpot Sales Hub Starter is about $20 per seat per month', volatile: true },
        { text: 'Pipedrive Advanced is about $34 per seat per month', volatile: true },
        { text: 'Salesforce Sales Cloud Pro Suite is about $100 per seat per month', volatile: true },
        { text: 'Zoho CRM Enterprise is about $40 per seat per month', volatile: true },
        { text: 'Close Growth is about $99 per seat per month', volatile: true }] }),
  mk(lastTuesday, '11:05',
    'Which managed Postgres hosting should I pick for a small SaaS? Compare pricing.',
    'For a small SaaS: Neon (free tier, paid from about $19/mo, scale-to-zero), Supabase (Pro $25/mo per project), AWS RDS (db.t4g.micro about $13/mo plus storage) and Render Postgres (from about $7/mo). Neon and Supabase are the best fit for early-stage products.',
    { topic: 'Managed Postgres hosting pricing comparison', entities: ['Neon', 'Supabase', 'AWS RDS', 'Render'],
      userStated: ['building a small SaaS', 'wants managed Postgres hosting'],
      claims: [{ text: 'Neon paid plans start at about $19 per month', volatile: true },
        { text: 'Supabase Pro costs $25 per month per project', volatile: true },
        { text: 'Render Postgres starts at about $7 per month', volatile: true }] }),
  mk(`${today.slice(0, 4)}-11-03`, '08:15',
    'What is the difference between a B-tree and a hash index in Postgres?',
    'A B-tree index supports equality and range queries and ordering; a hash index supports only equality, and since Postgres 10 is WAL-logged and crash-safe. In practice B-tree is the right default.',
    { topic: 'Postgres B-tree vs hash index', entities: ['Postgres'], userStated: [],
      claims: [{ text: 'Hash indexes in Postgres are WAL-logged and crash-safe since version 10', volatile: false }] }),
];

const ledger = new Ledger(config.dataDir);
const have = new Set(ledger.all(config.userId).map((t) => t.user));
let added = 0;
for (const t of turns) if (t.localDate <= today && !have.has(t.user)) (ledger.add(t), added++);
console.log(`Seeded ${added} demo turn(s) into ${config.dataDir}/ledger.jsonl (dated ${lastMonday}, ${lastTuesday}, ${today.slice(0, 4)}-11-03).`);
console.log('Try: "On Monday we shortlisted 5 CRM tools… has any changed pricing since?"');
