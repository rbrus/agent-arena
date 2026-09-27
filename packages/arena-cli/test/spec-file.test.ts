/**
 * Public-docs findings: `run --spec <run.json>` (the RunSpec as the whole run), the
 * `.agent-arena/<scenario>.run.json` file the SARIF location points at
 * (contracts/sarif-mapping.md §4), `replay --hash` in --help, and the Diplomacy
 * default fill = the contract default (profile security = injector-table).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Report } from 'arena-report';
import { runSpecFlags, specFileLocation } from '../src/commands/run-spec-file.ts';
import { parseDipFlags } from '../src/diplomacy.ts';
import { validateRunSpecSchema } from '../src/report.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import type { RunSpecContract } from '../src/generated/contracts.ts';
import { runCli, scratch } from './helpers.ts';

type Sarif = { runs: { results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] };
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const uris = (s: Sarif) => [...new Set(s.runs[0].results.map((r) => r.locations[0].physicalLocation.artifactLocation.uri))];
const hashes = (dir: string) => readJson<Report>(join(dir, 'report.json')).episodes.map((e) => e.replay_hash);

let srv: ReferenceServer;
before(async () => {
  srv = await startReferenceServer({ port: 0, policy: 'naive', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

describe('flag-driven run: .agent-arena/<scenario>.run.json is written and the SARIF points at it', () => {
  test('the file is the RunSpec as run (schema-valid, = report run.spec), under the working directory; every SARIF result names it', async () => {
    const cwd = scratch('arena-spec-');
    const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720,1', '--target', 'ref:naive', '--out', 'out', '--quiet'], {}, cwd);
    assert.equal(r.code, 1, r.stderr);
    const file = join(cwd, '.agent-arena', 'byzantine.run.json');
    assert.ok(existsSync(file), 'written under the cwd');
    const spec = readJson<RunSpecContract>(file);
    assert.equal(validateRunSpecSchema(spec), true, JSON.stringify(validateRunSpecSchema.errors));
    assert.deepEqual(spec, readJson<Report>(join(cwd, 'out', 'report.json')).run.spec);
    const sarif = readJson<Sarif>(join(cwd, 'out', 'report.sarif'));
    assert.ok(sarif.runs[0].results.length > 0, 'the naive reference has findings');
    assert.deepEqual(uris(sarif), ['.agent-arena/byzantine.run.json']);
  });
});

describe('run --spec <run.json>', () => {
  test('the CLI-written RunSpec runs again as it was (in-process reference): same replay hashes, SARIF points at the spec file, no .agent-arena written', async () => {
    const cwd = scratch('arena-spec-');
    const a = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720,1', '--target', 'ref:naive', '--out', 'a', '--quiet'], {}, cwd);
    assert.equal(a.code, 1, a.stderr);
    mkdirSync(join(cwd, 'specs'));
    writeFileSync(join(cwd, 'specs', 'run.json'), readFileSync(join(cwd, '.agent-arena', 'byzantine.run.json')));
    rmSync(join(cwd, '.agent-arena'), { recursive: true });
    const b = await runCli(['run', '--spec', 'specs/run.json', '--out', 'b', '--json'], {}, cwd);
    assert.equal(b.code, 1, b.stderr);
    assert.deepEqual(hashes(join(cwd, 'b')), hashes(join(cwd, 'a')));
    assert.deepEqual(uris(readJson<Sarif>(join(cwd, 'b', 'report.sarif'))), ['specs/run.json']);
    assert.equal(existsSync(join(cwd, '.agent-arena')), false, 'the spec file is the location; nothing else is written');
    assert.deepEqual(readJson<Report>(join(cwd, 'b', 'report.json')).run.spec, readJson<Report>(join(cwd, 'a', 'report.json')).run.spec);
  });

  test('a hand-written RunSpec (the scenario pages\' shape) against a served reference = the same run by flags', async () => {
    const cwd = scratch('arena-spec-');
    const spec = { scenario_id: 'byzantine', seeds: [20260720], episodes: 1, budget_tier: 'core', seat: { mode: 'squad' }, target: { transport: 'rest', url: srv.urls.rest }, labels: { ci_run: '42' } };
    writeFileSync(join(cwd, 'run.json'), JSON.stringify(spec));
    const s = await runCli(['run', '--spec', 'run.json', '--out', 's', '--quiet'], {}, cwd);
    const f = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--seeds', '20260720', '--target', srv.urls.rest, '--out', 'f', '--quiet'], {}, cwd);
    assert.equal(s.code, f.code, s.stderr + f.stderr);
    assert.deepEqual(hashes(join(cwd, 's')), hashes(join(cwd, 'f')));
    const rs = readJson<Report>(join(cwd, 's', 'report.json')).run.spec as RunSpecContract;
    assert.equal(rs.labels?.ci_run, '42', 'the file\'s labels are kept');
    assert.ok(rs.labels?.['arena.network_policy'], 'the CLI labels are added');
    assert.deepEqual(uris(readJson<Sarif>(join(cwd, 's', 'report.sarif'))), ['run.json']);
  });

  test('refusals: another run flag, a schema-invalid file (a literal secret), a missing file, a --auth that differs, a non-loopback target without attestation', async () => {
    const cwd = scratch('arena-spec-');
    const base = { scenario_id: 'byzantine', seeds: [1], episodes: 1, budget_tier: 'core', seat: { mode: 'squad' }, target: { transport: 'rest', url: 'http://127.0.0.1:9/act' } };
    const write = (name: string, doc: unknown) => (writeFileSync(join(cwd, name), JSON.stringify(doc)), name);
    const ok = write('ok.json', base);
    for (const [args, re] of [
      [['--spec', ok, '--seeds', '1,2'], /--spec carries the whole RunSpec; --seeds cannot be combined with it/],
      [['--spec', ok, '--scenario', 'deadlock', '--tier', 'edge'], /--scenario, --tier cannot be combined/],
      [['--spec', write('secret.json', { ...base, target: { ...base.target, auth: { scheme: 'bearer', ref: 'Bearer sk-live-abcdef0123456789' } } })], /is invalid against run_spec\.schema\.json: \/target\/auth\/ref/],
      [['--spec', 'nope.json'], /--spec file not found/],
      [['--spec', write('auth.json', { ...base, target: { ...base.target, auth: { scheme: 'bearer', ref: 'env:A' } } }), '--auth', 'env:B'], /--auth env:B differs from the --spec file's target\.auth\.ref env:A/],
      [['--spec', write('far.json', { ...base, target: { transport: 'rest', url: 'https://agent.example.com/act' } })], /target_ownership_unattested/],
    ] as [string[], RegExp][]) {
      const r = await runCli(['run', ...args, '--out', 'o'], {}, cwd);
      assert.equal(r.code, 3, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, re);
      assert.ok(!r.stderr.includes('sk-live-abcdef0123456789'), 'the literal secret is never echoed');
    }
  });

  test('mapping: ownership_attested is the run_spec attestation; Diplomacy fill comes from diplomacy.fill, else the profile (security/absent = the default, clean = house)', () => {
    const t = { transport: 'rest' as const, url: 'https://agent.example.com/act' };
    const b = { scenario_id: 'byzantine' as const, seeds: [1] as [number], episodes: 1, budget_tier: 'core' as const };
    assert.deepEqual(
      (({ ownTarget, ownershipSource }) => ({ ownTarget, ownershipSource }))(runSpecFlags({ ...b, target: { ...t, ownership_attested: true } } as RunSpecContract).flags),
      { ownTarget: true, ownershipSource: 'run_spec' },
    );
    assert.equal(runSpecFlags({ ...b, target: t } as RunSpecContract, { ownTarget: true }).flags.ownershipSource, undefined, 'the flag is a cli_flag attestation');
    const d = { ...b, scenario_id: 'diplomacy_standard', seat: { mode: 'power', position: 'germany' }, target: t } as unknown as RunSpecContract;
    const fillOf = (diplomacy?: object) => runSpecFlags({ ...d, ...(diplomacy ? { diplomacy } : {}) } as RunSpecContract).flags.fill;
    assert.equal(fillOf(), undefined);
    assert.equal(parseDipFlags({ seat: 'germany' }, [1]).fill, 'injector-table', 'no fill, no profile = security = injector-table');
    assert.equal(fillOf({ profile: 'security' }), undefined);
    assert.equal(fillOf({ profile: 'clean' }), 'house');
    assert.equal(fillOf({ profile: 'clean', fill: 'robust' }), 'robust');
    assert.throws(() => runSpecFlags({ ...d, seats: [{ power: 'austria', target: t }] } as unknown as RunSpecContract), /hosted runner/);
    assert.equal(runSpecFlags({ ...b, target: { transport: 'rest', url: 'http://in-process.invalid/ref:coordinated' } } as RunSpecContract).flags.target, 'ref:coordinated');
  });

  test('specFileLocation: repo-relative under the cwd, else undefined (then .agent-arena/ is written)', () => {
    assert.equal(specFileLocation('specs/run.json', '/repo'), 'specs/run.json');
    assert.equal(specFileLocation('/repo/a/b.json', '/repo'), 'a/b.json');
    assert.equal(specFileLocation('../elsewhere/run.json', '/repo'), undefined);
    assert.equal(specFileLocation('/tmp/run.json', '/repo'), undefined);
    assert.equal(specFileLocation('specs/run file.json', '/repo'), undefined);
  });
});

describe('diplomacy_standard default fill and --help', () => {
  test('no --fill = injector-table (profile security, the RunSpec default), named in one info line; --fill house stays available', async () => {
    const cwd = scratch('arena-dip-');
    const d = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--horizon', '1901', '--seeds', '3', '--target', 'ref:robust', '--out', 'd'], {}, cwd);
    assert.ok(d.code === 0 || d.code === 1, d.stderr);
    assert.match(d.stderr, /^diplomacy_standard: fill injector-table \(profile security, the RunSpec default\); pass --fill house for the clean profile\.$/m);
    const spec = readJson<Report>(join(cwd, 'd', 'report.json')).run.spec as RunSpecContract & { diplomacy?: { fill?: string; profile?: string } };
    assert.deepEqual([spec.diplomacy?.fill, spec.diplomacy?.profile], ['injector-table', 'security']);
    const h = await runCli(['run', '--scenario', 'diplomacy_standard', '--seat', 'germany', '--horizon', '1901', '--seeds', '3', '--fill', 'house', '--target', 'ref:robust', '--out', 'h'], {}, cwd);
    assert.ok(h.code === 0 || h.code === 1, h.stderr);
    assert.match(h.stderr, /^diplomacy_standard: fill house \(profile clean\)\.$/m);
    assert.equal((readJson<Report>(join(cwd, 'h', 'report.json')).run.spec as { diplomacy?: { fill?: string } }).diplomacy?.fill, 'house');
  });

  test('--help documents --spec, replay --hash and the fill default', async () => {
    const r = await runCli(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /agent-arena run --spec <run\.json>/);
    assert.match(r.stdout, /agent-arena replay <report\.json> --episode <n> \| --hash <sha256:…>/);
    assert.match(r.stdout, /--fill <fill>\s+diplomacy_standard: injector-table \(default; profile security/);
  });
});
