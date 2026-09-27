/**
 * Phase-8 GATE (C1) — Diplomacy, wired into `npm test`.
 *
 * Drives the standalone `qa/phase8-gate.ts` harness (the SAME code `npm run gate:phase8`
 * runs) with the Diplomacy suites and the --full checks OFF:
 *   - suites off: S-SUITES runs the Diplomacy test files as a subprocess, and `npm test`
 *     already runs every one of them;
 *   - --full off: the 300-game held-out collusion audit and the all-pairs 16-seed sweep take
 *     minutes; they are judged by `npm run gate:phase8` and docs/phase-8/GATE-EVIDENCE.md.
 * What it keeps green under regression: DATC 164/164 and the pinned map digest; the 7-power
 * reference game re-sims bit-for-bit; press never enters the replay hash (resim and over WSS);
 * every golden pair reproduces the frozen hashes and verdicts; the collusion house-only
 * invariant; the manipulation 16/16 sweep; the public CLI reproduces the golden over rest, ws,
 * mcp and a2a with valid report/SARIF and verify → verified; docs; the two leak suites.
 * The security review (S-REVIEW) and the map review (H) are repository state and human
 * sign-off: reported by the gate, not asserted here. FINDING lines are not asserted either.
 * Layout: auto-detected (private repo or the exported public one, EXTRACTION-DRYRUN.md B2); in the
 * public layout S-REVIEW and H-MAP-REVIEW are N-A (private evidence), every other check still runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { runGate } = await import('../../../qa/phase8-gate.ts');
const { detectLayout } = await import('../../../qa/phase7-gate.ts');
const CODE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('Phase-8 GATE: criteria 1–5 + leak suites hold (DATC, determinism, golden pairs, CLI over four transports, docs)', { timeout: 900_000 }, async () => {
  const r = await runGate({ suites: false, full: false });
  assert.equal(r.layout, detectLayout(CODE), 'auto-detected layout');
  const na = r.checks.filter((c) => c.status === 'N-A').map((c) => c.id);
  assert.deepEqual(na, r.layout === 'public' ? ['H-MAP-REVIEW', 'S-REVIEW'] : [], 'only the private evidence rows are N-A, and only in the public layout');
  const scored = r.checks.filter((c) => ['C1', 'C2', 'C3', 'C4', 'C5'].includes(c.crit) || c.id === 'S-LEAK-ENGINE' || c.id === 'S-LEAK-WRAPPER');
  const expectedSkips = new Set(['C3-SWEEP-ALL', 'C3-COLLUSION-HELDOUT']); // --full only
  for (const c of scored) {
    if (expectedSkips.has(c.id)) assert.equal(c.status, 'SKIP', `[${c.id}] runs only with --full`);
    else assert.equal(c.status, 'PASS', `[${c.id}] ${c.name} — ${c.detail}`);
  }
  for (const k of ['C1', 'C2', 'C4', 'C5'] as const) assert.equal(r.criteria[k], 'PASS', `criterion ${k}`);
  assert.equal(r.criteria.C3, 'INCOMPLETE', 'criterion 3 completes only with --full');
  assert.ok(scored.length >= 35, `expected the full criterion 1–5 battery, got ${scored.length}`);
});
