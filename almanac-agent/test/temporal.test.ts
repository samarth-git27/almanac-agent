import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonths, diffDays, mondayOf, relDay, weekday, ymdInTz } from '../src/clock.js';
import { resolveTemporal } from '../src/temporal.js';

const TODAY = '2026-11-11'; // a Wednesday
const first = (text: string) => resolveTemporal(text, TODAY)[0]!;

test('clock arithmetic', () => {
  assert.equal(weekday(TODAY), 3);
  assert.equal(mondayOf(TODAY), '2026-11-09');
  assert.equal(addDays('2026-12-30', 5), '2027-01-04');
  assert.equal(diffDays('2026-11-11', '2026-11-03'), 8);
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(relDay('2026-11-03', TODAY), '8 days ago');
  assert.equal(relDay('2026-10-14', TODAY), '4 weeks ago');
  assert.equal(relDay('2026-11-10', TODAY), 'yesterday');
});

test('time zone decides the calendar day', () => {
  const instant = new Date('2026-11-11T20:00:00Z');
  assert.equal(ymdInTz(instant, 'Asia/Kolkata'), '2026-11-12');
  assert.equal(ymdInTz(instant, 'America/Los_Angeles'), '2026-11-11');
});

test('"on Monday" resolves to the most recent Monday', () => {
  const r = first('On Monday we shortlisted 5 CRM tools');
  assert.equal(r.candidates[0]!.start, '2026-11-09');
  assert.equal(r.ambiguous, false);
});

test('"last Tuesday" on a Wednesday is ambiguous and keeps both readings', () => {
  const r = first('Last Tuesday I asked you about Postgres hosting');
  assert.equal(r.phrase.toLowerCase(), 'last tuesday');
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates.map((c) => c.start), ['2026-11-03', '2026-11-10']);
});

test('"last Tuesday" later in the week is unambiguous', () => {
  const r = resolveTemporal('last Tuesday', '2026-11-14')[0]!; // Saturday
  assert.equal(r.ambiguous, false);
  assert.equal(r.candidates[0]!.start, '2026-11-10');
});

test('explicit dates, with and without year', () => {
  assert.equal(first('What did I ask you on 3 November?').candidates[0]!.start, '2026-11-03');
  assert.equal(first('on Nov 3rd 2025').candidates[0]!.start, '2025-11-03');
  assert.equal(first('2026-10-01').candidates[0]!.start, '2026-10-01');
  assert.equal(first('03/11/2026').candidates[0]!.start, '2026-11-03');
});

test('a month/day that has not happened yet this year defaults to last year and flags it', () => {
  const r = first('what did I say on 25 December');
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates[0]!.start, '2025-12-25');
});

test('relative offsets and ranges', () => {
  assert.equal(first('yesterday').candidates[0]!.start, '2026-11-10');
  assert.equal(first('3 days ago').candidates[0]!.start, '2026-11-08');
  assert.equal(first('two weeks ago').candidates[0]!.start, '2026-10-28');
  const lw = first('last week').candidates[0]!;
  assert.deepEqual([lw.start, lw.end], ['2026-11-02', '2026-11-08']);
  const lm = first('last month').candidates[0]!;
  assert.deepEqual([lm.start, lm.end], ['2026-10-01', '2026-10-31']);
});

test('the longest match wins and does not double-count', () => {
  const refs = resolveTemporal('last Tuesday and also on Monday', TODAY);
  assert.equal(refs.length, 2);
  assert.equal(resolveTemporal('3 November 2025', TODAY).length, 1);
});

test('plain text and non-dates produce nothing', () => {
  assert.equal(resolveTemporal('3/4 of the team likes it; may the best CRM win', TODAY).length, 0);
});
