/**
 * Regression tests for the gate harnesses' repository-layout switch (qa/phase7-gate.ts and
 * qa/phase8-gate.ts, `--layout private|public|auto`). Wired into `npm test` through
 * services/arena/test/phase7-gate.test.ts.
 *
 * Bug pinned (docs/phase-7/EXTRACTION-DRYRUN.md blocker B2): both harnesses hard-coded the private
 * layout (`REPO = ascension/..`, `.github-public/`, `docs/phase-*`, `REPO/contracts`), so in the
 * exported public tree the gate printed 11 FAILs (C3-DOCS, C4-WORKFLOW, C5-GREP, C5-TIER0,
 * C5-NPM-TEST, C6-REVIEW, C7-*) and the two `npm test` wrappers failed. Fixed contract:
 *   - auto = private iff `<code>/../docs/phase-7/GATE-EVIDENCE.md` and `<code>/.github-public/` exist;
 *   - contracts/ is found like wot-contracts' findContractsDir (WOT_CONTRACTS_DIR, then ancestors);
 *   - checks on private evidence are `N-A (private evidence)`: printed, never scored; a criterion
 *     whose every check is N-A is N-A; the verdict line says
 *     `GATE: OPEN (public layout: N private criteria not evaluated)`;
 *   - the C5 grep scans contracts/ in both layouts, under the same `contracts/…` paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p7 from '../phase7-gate.ts';
import * as p8 from '../phase8-gate.ts';

const WORKSPACE = '{"private": true, "workspaces": ["packages/*"]}\n';
function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-layout-'));
  for (const f of files) {
    const p = join(root, f);
    if (f.endsWith('/')) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, f.endsWith('package.json') ? WORKSPACE : 'x\n');
    }
  }
  return root;
}
const PRIVATE = ['ascension/package.json', 'ascension/qa/', 'ascension/.github-public/workflows/', 'docs/phase-7/GATE-EVIDENCE.md', 'contracts/schemas/'];
const PUBLIC = ['package.json', 'qa/', '.github/workflows/', 'contracts/schemas/', 'docs/scenarios/'];
const NOENV = {};

test('layout: auto-detects private only when both GATE-EVIDENCE.md and .github-public/ exist', (t) => {
  const priv = tree(PRIVATE);
  const pub = tree(PUBLIC);
  const noEvidence = tree(PRIVATE.filter((f) => !f.startsWith('docs/')));
  const noGhPublic = tree(PRIVATE.filter((f) => !f.includes('.github-public')));
  t.after(() => [priv, pub, noEvidence, noGhPublic].forEach((d) => rmSync(d, { recursive: true, force: true })));
  assert.equal(p7.detectLayout(join(priv, 'ascension')), 'private');
  assert.equal(p7.detectLayout(pub), 'public');
  assert.equal(p7.detectLayout(join(noEvidence, 'ascension')), 'public', 'no GATE-EVIDENCE.md → public');
  assert.equal(p7.detectLayout(join(noGhPublic, 'ascension')), 'public', 'no .github-public/ → public');
});

test('layout: private paths read .github-public/, docs/phase-7/*-public.md and the sibling contracts/', (t) => {
  const priv = tree(PRIVATE);
  t.after(() => rmSync(priv, { recursive: true, force: true }));
  const code = join(priv, 'ascension');
  const P = p7.layoutPaths(code, 'auto', NOENV);
  assert.equal(P.layout, 'private');
  assert.equal(P.how, 'auto');
  assert.equal(P.privateEvidence, true);
  assert.equal(P.contracts, join(priv, 'contracts'));
  assert.equal(P.docs, join(priv, 'docs'));
  assert.equal(P.workflows, join(code, '.github-public', 'workflows'));
  assert.equal(P.license, join(code, '.github-public', 'LICENSE'));
  assert.equal(P.readme, join(priv, 'docs', 'phase-7', 'README-public.md'));
  assert.equal(P.contributing, join(priv, 'docs', 'phase-7', 'CONTRIBUTING-public.md'));
});

test('layout: public paths read .github/workflows/, root docs and contracts/ inside the code root', (t) => {
  const pub = tree(PUBLIC);
  t.after(() => rmSync(pub, { recursive: true, force: true }));
  const P = p7.layoutPaths(pub, 'auto', NOENV);
  assert.equal(P.layout, 'public');
  assert.equal(P.privateEvidence, false);
  assert.equal(P.contracts, join(pub, 'contracts'));
  assert.equal(P.docs, join(pub, 'docs'));
  assert.equal(P.workflows, join(pub, '.github', 'workflows'));
  assert.deepEqual([P.license, P.notice, P.readme, P.security, P.contributing], ['LICENSE', 'NOTICE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md'].map((f) => join(pub, f)));
});

test('layout: --layout forces a layout; contracts/ still resolves via contractsDir() or WOT_CONTRACTS_DIR', (t) => {
  const priv = tree(PRIVATE);
  const other = tree(['elsewhere/contracts/schemas/', 'empty/package.json']);
  t.after(() => [priv, other].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const code = join(priv, 'ascension');
  const P = p7.layoutPaths(code, 'public', NOENV);
  assert.equal(P.layout, 'public');
  assert.equal(P.how, 'forced');
  assert.equal(P.contracts, join(priv, 'contracts'), '<workspace>/../contracts in the private tree');
  assert.equal(p7.locateContracts(code, { WOT_CONTRACTS_DIR: join(other, 'elsewhere', 'contracts') }), join(other, 'elsewhere', 'contracts'));
  assert.throws(() => p7.locateContracts(code, { WOT_CONTRACTS_DIR: join(other, 'empty') }), /has no schemas\//);
  if (!process.env.WOT_CONTRACTS_DIR) assert.throws(() => p7.locateContracts(join(other, 'empty'), NOENV), /contracts\/ not found/);
});

test('layout: --layout argument parsing', () => {
  assert.equal(p7.parseLayoutArg([]), 'auto');
  assert.equal(p7.parseLayoutArg(['--stable', '--layout', 'public']), 'public');
  assert.equal(p7.parseLayoutArg(['--layout=private', '--no-suites']), 'private');
  assert.equal(p7.parseLayoutArg(['--layout', 'auto']), 'auto');
  assert.throws(() => p7.parseLayoutArg(['--layout', 'ascension']), /private, public or auto/);
  assert.throws(() => p7.parseLayoutArg(['--layout']), /private, public or auto/);
});

type C7 = p7.Check;
const c7 = (crit: p7.Crit, id: string, status: C7['status']): C7 => ({ crit, id, name: id, status, detail: '' });

test('phase7: N-A checks are not scored; an all-N-A criterion is N-A and does not block', () => {
  const crits: p7.Crit[] = ['C1', 'C5', 'C6', 'C7'];
  const checks = [c7('C1', 'C1-A', 'PASS'), c7('C5', 'C5-A', 'PASS'), c7('C5', 'C5-X', 'N-A'), c7('C6', 'C6-REVIEW', 'N-A'), c7('C6', 'C6-SCOPE', 'N-A'), c7('C7', 'C7-A', 'PASS')];
  const criteria = p7.scoreCriteria(checks, crits);
  assert.deepEqual(criteria, { C1: 'PASS', C5: 'PASS', C6: 'N-A', C7: 'PASS' });
  assert.deepEqual(p7.notEvaluated(checks), ['C5', 'C6']);
  // A FAIL next to an N-A still fails; a SKIP still makes the criterion INCOMPLETE.
  assert.equal(p7.scoreCriteria([c7('C6', 'a', 'N-A'), c7('C6', 'b', 'FAIL')], ['C6']).C6, 'FAIL');
  assert.equal(p7.scoreCriteria([c7('C6', 'a', 'N-A'), c7('C6', 'b', 'SKIP')], ['C6']).C6, 'INCOMPLETE');
});

test('phase7: verdict line per layout', () => {
  const open = { C1: 'PASS', C2: 'PASS', C3: 'PASS', C4: 'PASS', C5: 'PASS', C6: 'N-A', C7: 'PASS', X: 'PASS' } as const;
  assert.equal(p7.verdictLine({ criteria: open, gateOpen: true, layout: 'public', notEvaluated: ['C6'] }), 'GATE: OPEN (public layout: 1 private criterion not evaluated)');
  assert.equal(p7.verdictLine({ criteria: { ...open, C6: 'PASS' }, gateOpen: true, layout: 'private', notEvaluated: [] }), 'GATE: OPEN');
  assert.equal(p7.verdictLine({ criteria: { ...open, C5: 'FAIL' }, gateOpen: false, layout: 'public', notEvaluated: ['C6'] }), 'GATE: BLOCKED (C5) (public layout: 1 private criterion not evaluated)',
    'an N-A criterion is never listed as blocking');
  assert.equal(p7.layoutSuffix('public', ['S', 'H']), ' (public layout: 2 private criteria not evaluated)');
  assert.equal(p7.layoutSuffix('private', ['S']), '');
});

test('N-A rendering: the status column reads "N-A (private evidence)"', () => {
  assert.equal(p7.NA_LABEL, 'N-A (private evidence)');
  assert.equal(p7.renderCheck({ id: 'C6-REVIEW', name: 'review', status: 'N-A', detail: 'why' }), '    N-A (private evidence) [C6-REVIEW] review  — why');
  assert.equal(p7.renderCheck({ id: 'C1-X', name: 'x', status: 'PASS', detail: '' }), '    PASS    [C1-X] x', 'other statuses keep the 7-wide column');
});

type C8 = p8.Check;
const c8 = (crit: p8.Crit, id: string, status: C8['status']): C8 => ({ crit, id, name: id, status, detail: '' });

test('phase8: S-REVIEW and H are N-A in the public layout; the gate opens on the code-driven criteria', () => {
  const crits: p8.Crit[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'S', 'X', 'H'];
  const base = [c8('C1', 'a', 'PASS'), c8('C2', 'a', 'PASS'), c8('C3', 'a', 'PASS'), c8('C4', 'a', 'PASS'), c8('C5', 'a', 'PASS'), c8('S', 'S-LEAK-ENGINE', 'PASS')];
  const pub = [...base, c8('S', 'S-REVIEW', 'N-A'), c8('H', 'H-MAP-REVIEW', 'N-A')];
  const criteria = p8.scoreCriteria(pub, crits);
  assert.equal(criteria.S, 'PASS', 'S still scores its leak suites');
  assert.equal(criteria.H, 'N-A');
  assert.equal(p8.isGateOpen(criteria), true);
  assert.deepEqual(p7.notEvaluated(pub), ['S', 'H']);
  assert.equal(p8.verdictLine({ criteria, gateOpen: true, humanPending: [], layout: 'public', notEvaluated: ['S', 'H'] }), 'GATE: OPEN (public layout: 2 private criteria not evaluated)');
  // Private layout: unchanged wording, H awaits the human.
  const priv = [...base, c8('S', 'S-REVIEW', 'PASS'), c8('H', 'H-MAP-REVIEW', 'HUMAN')];
  const pc = p8.scoreCriteria(priv, crits);
  assert.equal(pc.H, 'ACCEPTANCE');
  assert.equal(p8.verdictLine({ criteria: pc, gateOpen: p8.isGateOpen(pc), humanPending: ['H-MAP-REVIEW'], layout: 'private', notEvaluated: [] }), 'GATE: OPEN — human acceptance required: H-MAP-REVIEW');
  // A scored FAIL still blocks in the public layout.
  const bad = p8.scoreCriteria([...pub, c8('C5', 'C5-PAGE', 'FAIL')], crits);
  assert.equal(p8.isGateOpen(bad), false);
  assert.equal(p8.verdictLine({ criteria: bad, gateOpen: false, humanPending: [], layout: 'public', notEvaluated: ['S', 'H'] }), 'GATE: BLOCKED (C5) (public layout: 2 private criteria not evaluated)');
});

test('C5 grep: contracts/ is scanned in both layouts under the same paths, once', (t) => {
  const priv = tree(PRIVATE);
  const pub = tree(PUBLIC);
  t.after(() => [priv, pub].forEach((d) => rmSync(d, { recursive: true, force: true })));
  for (const [root, code] of [[priv, join(priv, 'ascension')], [pub, pub]] as const) {
    writeFileSync(join(root, 'contracts', 'schemas', 'x.schema.json'), '{"description": "a Vault"}\n');
    writeFileSync(join(code, 'qa', 'y.ts'), 'const bazaar = 1;\n');
    const hits = p7.grepCut(code, p7.locateContracts(code, NOENV)).map((h) => `${h.file}:${h.token}`).sort();
    assert.deepEqual(hits, ['contracts/schemas/x.schema.json:Vault', 'qa/y.ts:bazaar'], `layout rooted at ${code}`);
  }
});

test('C5 grep allowlist: contracts removal notes pass only next to a REMOVED marker', () => {
  const note = (file: string, token: string, ctx: string) => p7.allowRuleFor({ file, token, ctx })?.rule;
  assert.equal(note('contracts/openapi.yaml', 'Vault', '    **Removed in 2.0.0 (ADR-001 §6):** the Great Hunt,\n    Adapters, the Vault, Coach-mode'), 'contracts-removal-notes');
  assert.equal(note('contracts/openapi.yaml', 'hunt', '        REMOVED in 2.0.0 (ADR-001 §6): `market:trade`, `hunt:participate`'), 'contracts-removal-notes');
  // A re-introduced surface without the marker fails.
  assert.equal(note('contracts/openapi.yaml', 'hunt', '  /v1/hunt/clues:\n    get:'), undefined);
  assert.equal(note('contracts/schemas/hunt_clue.schema.json', 'hunt', 'REMOVED'), undefined, 'a new schema file is not covered');
  assert.equal(note('contracts/schemas/match_end.schema.json', 'coach_interventions', 'CONTRACTS 2.0.0 (ADR-001): the optional economy/ladder fields `refund`, `payout`, `coach_interventions` are no longer emitted'), 'contracts-removal-notes');
  assert.equal(note('qa/test/gate-layout.test.ts', 'bazaar', ''), 'gate-harness-self', 'this test names cut words by design');
  assert.equal(note('qa/other.test.ts', 'bazaar', ''), undefined, 'the self rule covers only the harness and this test');
  assert.equal(note('contracts/schemas/run_spec.schema.json', 'adapter', 'named as the scenario adapter'), 'contracts-scenario-adapter');
  assert.equal(note('contracts/schemas/run_spec.schema.json', 'Adapters', 'the Adapters power-up'), undefined);
  // arena-league: only the scenario record field is allowed, not prose "adapters".
  assert.equal(note('packages/arena-league/src/reports.ts', 'adapterCoercions', ''), 'league-scenario-record-field');
  assert.equal(note('packages/arena-league/src/reports.ts', 'adapters', ''), undefined);
  assert.equal(note('packages/arena-league/package.json', 'adapters', ''), undefined);
});
