/**
 * Regression tests for the security-review parsing in qa/phase7-gate.ts (C6-REVIEW and the
 * Notes block) and qa/phase8-gate.ts (S-REVIEW). Wired into `npm test` through
 * services/arena/test/phase7-gate.test.ts.
 *
 * Bugs pinned (docs/phase-7/GATE-EVIDENCE.md criterion 6, "Harness wording note"):
 *   1. the verdict regex was case-insensitive and matched the word "pass" in "after the closure
 *      pass of …" before reaching PASS-WITH-CONDITIONS, printing `verdict: PASS`;
 *   2. the Notes block listed the "Must close before the public flip" table of the superseded
 *      first review (G-19, G-20, G-21, G-6, G-10) instead of the findings still open in §7.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReviewFindings, parseReviewVerdict } from '../phase7-gate.ts';

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'security-review-sample.md'), 'utf8');

/** The pre-fix C6/S-REVIEW regex, kept here to show the fixture reproduces bug 1. */
function oldVerdict(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /verdict/i.test(l));
  const window = at < 0 ? [] : [lines[at], ...lines.slice(at + 1).filter((l) => l.trim()).slice(0, 3)];
  return window.map((l) => /\b(PASS[- ]WITH[- ]CONDITIONS|PASS|FAIL|BLOCKED)\b/i.exec(l)?.[1]).find(Boolean)?.toUpperCase().replace(/ /g, '-') ?? 'none';
}

test('security review: the fixture reproduces the old bug (lowercase "pass" in prose read as the verdict)', () => {
  // "## 0. Verdict" is the first "verdict" line; the old window reached the "Current verdict" line's prose "closure pass".
  assert.equal(oldVerdict(FIXTURE), 'PASS');
});

test('security review: verdict read case-sensitively from the "Current verdict" line; orchestrator note → PASS (pending counter-signature)', () => {
  const v = parseReviewVerdict(FIXTURE);
  assert.equal(v.verdict, 'PASS-WITH-CONDITIONS');
  assert.match(v.display, /^PASS \(pending counter-signature\)/);
  assert.match(v.display, /"Current verdict" line: PASS-WITH-CONDITIONS/);
  assert.ok(v.note && /Orchestrator note/.test(v.note));
});

test('security review: without the orchestrator note the verdict is the token on the line, prose "pass" ignored', () => {
  const noNote = FIXTURE.split('\n').filter((l) => !/Orchestrator note/.test(l)).join('\n');
  assert.deepEqual([parseReviewVerdict(noNote).verdict, parseReviewVerdict(noNote).display], ['PASS-WITH-CONDITIONS', 'PASS-WITH-CONDITIONS']);
  const proseOnly = '## 0. Verdict\n\n**Current verdict, after the closure pass: the reviewer will pass judgement later.**\n';
  assert.equal(parseReviewVerdict(proseOnly).verdict, 'none', 'a lowercase "pass" is never a verdict');
  assert.equal(parseReviewVerdict('**Current verdict:** PASS.\n').display, 'PASS');
});

test('security review: an orchestrator note never lifts FAIL or BLOCKED', () => {
  for (const tok of ['FAIL', 'BLOCKED']) {
    const t = FIXTURE.replace('is PASS-WITH-CONDITIONS, with one condition', `is ${tok}`);
    const v = parseReviewVerdict(t);
    assert.equal(v.verdict, tok);
    assert.equal(v.display, tok);
  }
});

test('security review: superseded verdicts are not read; a review without "Current verdict" falls back past superseded lines', () => {
  const first = '# Review\n\n## 0. Verdict\n\n**Earlier verdict (superseded): FAIL.**\n\n**Verdict: PASS-WITH-CONDITIONS.** The closure pass found nothing.\n';
  assert.equal(parseReviewVerdict(first).verdict, 'PASS-WITH-CONDITIONS');
});

test('security review Notes: open findings come from the §7 status table, not the superseded must-close table', () => {
  const v = parseReviewVerdict(FIXTURE);
  const st = openReviewFindings(FIXTURE, v.note);
  assert.equal(st.table, true);
  assert.deepEqual(st.open.map((f) => f.id), ['G-103', 'G-106', 'G-107', 'G-110']);
  // G-104/G-105 are "New" in §7 but closed by the orchestrator note; G-109 was reopened only by G-104.
  assert.deepEqual(st.closedByNote.map((f) => f.id).sort(), ['G-104', 'G-105', 'G-109']);
  const all = [...st.open, ...st.closedByNote].map((f) => f.id);
  for (const id of ['G-101', 'G-102', 'G-108', 'G-199']) assert.ok(!all.includes(id), `${id} must not be listed`);
});

test('security review Notes: without the note, "New" rows and rows reopened by them are open', () => {
  const st = openReviewFindings(FIXTURE);
  assert.deepEqual(st.open.map((f) => f.id), ['G-103', 'G-106', 'G-107', 'G-109', 'G-110', 'G-104', 'G-105']);
  assert.deepEqual(st.closedByNote, []);
  assert.equal(openReviewFindings('# no table\n').table, false);
});
