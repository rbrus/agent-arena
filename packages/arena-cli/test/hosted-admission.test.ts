/**
 * Contracts 2.10.0 hosted episode caps (signing.md §3.2), refused by the runner before any I/O:
 *  A6   an `extended` run plays exactly one episode (Dh 30 s: one Diplomacy episode at horizon 1908
 *       is about 51.5 min, and a run token lives 55 min) — run_spec_invalid (episodes);
 *  M10  a Diplomacy-family run plays at most 50 episodes and commits to exactly one secret per
 *       episode (OQ-18) — hosted_context_invalid (episode_secret_commitments).
 * The caps compose; a local run keeps the RunSpec limits (1000), and an extended local run is fine.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { validateReportSchema, type Report } from 'arena-report';
import type { HostedOptions } from '../src/commands/run-hosted.ts';
import { CliError } from '../src/errors.ts';
import { assertHostedDiplomacyEpisodes, assertHostedTierEpisodes, HOSTED_DIPLOMACY_MAX_EPISODES, HOSTED_EXTENDED_MAX_EPISODES } from '../src/hosted/admission.ts';
import { HOSTED_SECRET_PATTERNS, takeHostedSecrets } from '../src/hosted/env.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { commitmentsFor, dipSecret, hostedEnv, MANIFEST_KID, PLATFORM, pubJwk, runHosted, runSpec, signManifest, unsignedManifest, viaReference, writeInputs } from './hosted-fixtures.ts';
import { runCli, scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

const refused = async (p: Promise<unknown>, re: RegExp) => {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CliError, `expected a CliError, got ${String(e)}`);
    assert.equal(e.exitCode, 3, e.message);
    assert.match(e.message, re);
    return true;
  });
};
/** A factory that must never be reached: the refusal has to come before any transport exists. */
const noTransport = () => {
  throw new Error('a transport was created: the refusal came too late');
};

function setup(spec: ReturnType<typeof runSpec>, manifest: Parameters<typeof unsignedManifest>[1] = {}) {
  const m = signManifest(unsignedManifest(spec, manifest));
  const dir = scratch();
  return { dir, inputs: writeInputs(join(dir, 'in'), m, spec) };
}
const run = (s: ReturnType<typeof setup>, env = hostedEnv(), transportFactory: HostedOptions['transportFactory'] = noTransport) =>
  runHosted({ ...s.inputs, manifestKey: pubJwk(MANIFEST_KID), out: join(s.dir, 'out') }, { env, platform: PLATFORM, transportFactory });

const dipSpec = (episodes: number, tier: 'core' | 'extended' = 'core') =>
  runSpec({
    scenario_id: 'diplomacy_standard',
    seeds: [20261115],
    episodes,
    budget_tier: tier,
    seat: { mode: 'power', position: 'germany' },
    diplomacy: { profile: 'clean', horizon_year: 1901, fill: 'house' },
  } as never);
const secrets = (n: number) => Array.from({ length: n }, (_, i) => dipSecret(`adm-${i}`));

describe('the rules, as functions', () => {
  test('A6: extended plays exactly 1 episode; the other tiers are not capped by A6', () => {
    assert.equal(HOSTED_EXTENDED_MAX_EPISODES, 1);
    assertHostedTierEpisodes({ budget_tier: 'extended', episodes: 1 });
    for (const t of ['edge', 'core', 'frontier'] as const) assertHostedTierEpisodes({ budget_tier: t, episodes: 1000 });
    assert.throws(() => assertHostedTierEpisodes({ budget_tier: 'extended', episodes: 2 }), /run_spec_invalid \(episodes\): a hosted run at the extended tier plays exactly 1 episode/);
  });
  test('M10: a Diplomacy-family run plays at most 50 and commits to one secret per episode; other scenarios are not capped', () => {
    assert.equal(HOSTED_DIPLOMACY_MAX_EPISODES, 50);
    assertHostedDiplomacyEpisodes({ episode_secret_commitments: { count: 50, digest: `sha256:${'0'.repeat(64)}` } }, { episodes: 50 }, true);
    assertHostedDiplomacyEpisodes({}, { episodes: 1000 }, false);
    assert.throws(() => assertHostedDiplomacyEpisodes({ episode_secret_commitments: { count: 50, digest: `sha256:${'0'.repeat(64)}` } }, { episodes: 51 }, true), /hosted_context_invalid \(episode_secret_commitments\): a hosted Diplomacy-family run plays at most 50 episodes/);
    assert.throws(() => assertHostedDiplomacyEpisodes({ episode_secret_commitments: { count: 2, digest: `sha256:${'0'.repeat(64)}` } }, { episodes: 1 }, true), /hosted_context_invalid \(episode_secret_commitments\): the manifest commits to 2/);
  });
  test('ARENA_DIP_SECRET_<n>: n 0..49 is a secret name (hosted_env.json); 50 is canonical, not malformed (refused as n >= count)', () => {
    const dip = HOSTED_SECRET_PATTERNS[2];
    for (const n of [0, 9, 10, 49]) assert.ok(dip.test(`ARENA_DIP_SECRET_${n}`), String(n));
    for (const n of ['50', '999', '01']) assert.equal(dip.test(`ARENA_DIP_SECRET_${n}`), false, n);
    const s = takeHostedSecrets({ ARENA_DIP_SECRET_50: 'a'.repeat(64), ARENA_DIP_SECRET_01: 'b'.repeat(64) });
    assert.deepEqual(s.malformedDipNames(), ['ARENA_DIP_SECRET_01']);
    assert.equal(s.dipSecretCount(), 1, 'the canonical index 50 is taken as a secret (then fails the count check)');
  });
});

describe('run --hosted refuses before any I/O', () => {
  test('A6: an extended run with 2 episodes is run_spec_invalid (episodes), whatever the credential mode', async () => {
    const spec = runSpec({ budget_tier: 'extended', seeds: [20260720, 1], episodes: 2 });
    await refused(run(setup(spec)), /^run_spec_invalid \(episodes\): a hosted run at the extended tier plays exactly 1 episode/);
    const open = runSpec({ budget_tier: 'extended', seeds: [20260720], episodes: 2, target: { transport: 'rest', url: 'https://agent.example.com/arena/act' } });
    await refused(run(setup(open, { credential_mode: 'none' }), hostedEnv({ ARENA_TARGET_CREDENTIAL: undefined })), /^run_spec_invalid \(episodes\)/);
  });
  test('M10: a Diplomacy run with 51 episodes is refused, with a 50-commitment manifest (runner rule) and with a 51-commitment one (schema)', async () => {
    const spec = dipSpec(51);
    const fifty = secrets(50);
    const env = hostedEnv(Object.fromEntries(fifty.map((v, i) => [`ARENA_DIP_SECRET_${i}`, v])));
    await refused(run(setup(spec, { episode_secret_commitments: commitmentsFor(fifty) }), env), /^hosted_context_invalid \(episode_secret_commitments\): a hosted Diplomacy-family run plays at most 50 episodes/);
    await refused(run(setup(spec, { episode_secret_commitments: commitmentsFor(secrets(51)) })), /^hosted_context_invalid/);
  });
  test('M10: commitments for another episode count are refused (count must equal episodes)', async () => {
    const two = secrets(2);
    await refused(run(setup(dipSpec(1), { episode_secret_commitments: commitmentsFor(two) }), hostedEnv({ ARENA_DIP_SECRET_0: two[0], ARENA_DIP_SECRET_1: two[1] })), /^hosted_context_invalid \(episode_secret_commitments\): the manifest commits to 2/);
  });
  test('the caps compose: an extended Diplomacy run with 2 episodes fails A6 first', async () => {
    const two = secrets(2);
    await refused(run(setup(dipSpec(2, 'extended'), { episode_secret_commitments: commitmentsFor(two) }), hostedEnv({ ARENA_DIP_SECRET_0: two[0], ARENA_DIP_SECRET_1: two[1] })), /^run_spec_invalid \(episodes\)/);
  });
});

test('run --hosted: one extended episode plays, and the report carries the extended limits and validates (A6 conditional included)', async () => {
  const spec = runSpec({ budget_tier: 'extended', seeds: [20260720], episodes: 1 });
  const s = setup(spec);
  const r = await run(s, hostedEnv(), viaReference(srv.urls.rest, {}));
  assert.equal(r.exitCode, 0);
  const report = JSON.parse(readFileSync(join(s.dir, 'out', 'report.json'), 'utf8')) as Report;
  assert.ok(validateReportSchema(report), JSON.stringify(validateReportSchema.errors?.slice(0, 3)));
  assert.equal(report.run.mode, 'hosted');
  assert.deepEqual(
    { tier: report.budget_limits.tier, ds: report.budget_limits.soft_deadline_ms, dh: report.budget_limits.hard_deadline_ms, allowance: report.budget_limits.token_allowance },
    { tier: 'extended', ds: 15000, dh: 30000, allowance: 540 },
  );
  assert.equal(report.episodes.length, 1);
  assert.equal(report.episodes[0].budget.tier, 'extended');
});

describe('the open CLI: --tier extended is accepted, league is not a tier', () => {
  test('run --tier extended (in-process reference): report at the extended tier, no anchor claimed', async () => {
    const out = scratch();
    const r = await runCli(['run', '--scenario', 'byzantine', '--seat', 'squad', '--tier', 'extended', '--seeds', '20260720,1', '--target', 'ref:coordinated', '--out', out, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
    assert.ok(validateReportSchema(report), JSON.stringify(validateReportSchema.errors?.slice(0, 3)));
    assert.equal(report.run.spec.budget_tier, 'extended');
    assert.equal(report.run.spec.episodes, 2, 'the hosted cap does not apply locally');
    assert.equal(report.budget_limits.hard_deadline_ms, 30000);
    assert.equal(report.budget_limits.token_allowance, 540);
  });
  test('run --tier league is a usage error (exit 3), before anything runs', async () => {
    const r = await runCli(['run', '--scenario', 'byzantine', '--tier', 'league', '--target', 'ref:coordinated', '--out', scratch()]);
    assert.equal(r.code, 3);
    assert.match(r.stdout + r.stderr, /--tier must be edge, core, frontier or extended/);
  });
});
