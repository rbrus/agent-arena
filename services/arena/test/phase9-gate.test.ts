/**
 * Phase-9 GATE (C1, in-repo part) — wired into `npm test`, opt-in like the cross-check suite:
 *
 *   ARENA_PHASE9=1 npm test          (≈ 2–3 min: ~40 CLI child processes, two cross-check runs)
 *
 * Drives the standalone `qa/phase9-gate.ts` harness (the SAME code `npm run gate:phase9` runs)
 * without the full npm-leg cross-check matrix (that one is `npm run crosscheck` / the gate itself).
 * What it keeps green under regression: the hosted run path through the documented seam, its
 * report and SARIF, the per-episode equality with the open CLI and the frozen anchors, the hosted
 * cross-check record and `--compare`, pre-seal and sealed `verify --hosted-seal`, the evidence
 * report (schema, "Not assessed", clause ids, wording, no target text), the packs, the hosted
 * environment contract, credential scrubbing and commit-then-reveal.
 *
 * The C2m regression checks (C2M_FLIPPED: G-45…G-49, the hosted_env.json field parity) are asserted
 * like every other check. Not asserted: S-REVIEW (repository state and the security-architect's
 * sign-off, as in the Phase 8 wrapper), FINDING rows, and the Sixi-side rows (always N-A).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

if (process.env.ARENA_PHASE9 === '1') {
  const { runGate, C2M_FLIPPED } = await import('../../../qa/phase9-gate.ts');
  test('Phase-9 GATE (in-repo): every in-repo check passes (S-REVIEW reported, not asserted); Sixi-side rows are N-A', { timeout: 900_000 }, async () => {
    const r = await runGate({ localCrosscheck: false });
    const sixi = r.checks.filter((c) => c.status === 'N-A' && c.naKind !== 'private').map((c) => c.id).sort();
    assert.deepEqual(sixi, ['C1-SCAN-ACTION', 'C1-XCHECK-JOB', 'C3-N-OF-M', 'C4-NEUTRAL-GROUND', 'C5-CRED-LIFECYCLE', 'C5-RESIDENCY', 'C5-SWISS-ATTACKERS', 'C6-PRICING'], 'exactly the Sixi-side rows are N-A (Sixi side)');
    const priv = r.checks.filter((c) => c.status === 'N-A' && c.naKind === 'private').map((c) => c.id);
    assert.deepEqual(priv, r.layout === 'public' ? ['S-REVIEW'] : [], 'the review is N-A (private evidence) only in the public layout');
    const expectedSkips = new Set(['X-XCHECK-LOCAL', 'C2-LOCAL-RECORD-REFUSED']); // full npm-leg matrix off in the wrapper
    for (const c of r.checks) {
      if (c.status === 'N-A' || c.status === 'FINDING' || c.id === 'S-REVIEW') continue;
      if (expectedSkips.has(c.id)) assert.equal(c.status, 'SKIP', `[${c.id}] runs only in the full gate`);
      else assert.equal(c.status, 'PASS', `[${c.id}] ${c.name} — ${c.detail}`);
    }
    for (const id of C2M_FLIPPED) assert.ok(r.checks.some((c) => c.id === id), `C2m regression check ${id} ran`);
    assert.ok(r.checks.filter((c) => c.status === 'PASS').length >= 25, 'the full in-repo battery ran');
  });
} else {
  test('Phase-9 gate (skipped; set ARENA_PHASE9=1 to run)', { skip: true }, () => {});
}
