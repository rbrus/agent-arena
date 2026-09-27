/**
 * Phase-7 GATE (C1) — the Open Arena, wired into `npm test`.
 *
 * Drives the standalone `qa/phase7-gate.ts` harness (the SAME code `npm run gate`
 * runs) with the suites and the benchmark OFF:
 *   - suites off: criterion 5 runs `npm test` itself, so running it from inside
 *     `npm test` would recurse;
 *   - bench off: a µs/tick number measured while node --test runs every other
 *     test file in parallel is noise, not evidence.
 * What it keeps green under regression is the part that must never drift: the
 * public CLI reproduces the frozen gate anchors over REST in all three tiers and
 * over ws/mcp/a2a byte for byte, the reports validate, verify/replay agree, the
 * calibration sweep digests are unchanged, and SARIF maps not_assessed correctly.
 * Criteria 5–7 depend on repository state and human sign-off (security review,
 * NOTICE holder); they are judged by `npm run gate` and docs/phase-7/GATE-EVIDENCE.md.
 *
 * Layout: the harness auto-detects the private repo or the exported public one
 * (EXTRACTION-DRYRUN.md B2); this wrapper passes in both. In the public layout criterion 6
 * (the private security review) is N-A (private evidence) and nothing else is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { runGate, detectLayout } = await import('../../../qa/phase7-gate.ts');
// The C6/S-REVIEW parser regressions and the layout-switch regressions (qa/ is outside the
// npm test glob; importing registers them here).
await import('../../../qa/test/security-review-parse.test.ts');
await import('../../../qa/test/gate-layout.test.ts');
await import('../../../qa/test/gate-subprocess.test.ts');
const CODE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('Phase-7 GATE: criteria 1–4 + verify/replay hold through the public CLI (frozen anchors, transport invariance, calibration, SARIF)', { timeout: 600_000 }, async () => {
  const r = await runGate({ suites: false, bench: false });
  assert.equal(r.layout, detectLayout(CODE), 'auto-detected layout');
  const na = r.checks.filter((c) => c.status === 'N-A').map((c) => c.id);
  assert.deepEqual(na, r.layout === 'public' ? ['C6-REVIEW', 'C6-SCOPE'] : [], 'only the private security review is N-A, and only in the public layout');
  const scored = r.checks.filter((c) => ['C1', 'C2', 'C3', 'C4'].includes(c.crit) || c.id === 'X-VERIFY' || c.id === 'X-REPLAY');
  // FINDING lines (e.g. X-NAIVE-SERVED) are recorded defects outside criteria 1–4; they are reported, not asserted.
  for (const c of scored) assert.equal(c.status, 'PASS', `[${c.id}] ${c.name} — ${c.detail}`);
  for (const k of ['C1', 'C2', 'C3', 'C4'] as const) assert.equal(r.criteria[k], 'PASS', `criterion ${k}`);
  assert.ok(scored.length >= 60, `expected the full criterion 1–4 battery, got ${scored.length}`);
  // The grep gate is deterministic too, but it is a repository-state check: reported, not asserted here.
});
