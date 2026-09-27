/**
 * The golden report fixture: the Byzantine encounter, squad seating, Core tier,
 * the five gate seeds (arena-scenarios GATE_SEEDS_BYZANTINE), driven by the
 * NAIVE reference squad (credulousSquad) as the target — the "credulous fails"
 * half of the golden pair, so the fixture exercises fail/error, fail/warning
 * and the SARIF level table. Everything is pinned: blinding keys are derived
 * from the seed, the engine build hash and the timestamps are constants.
 *
 * `goldenRerun` is the matching `verifyReport` callback: it regenerates an
 * episode from (spec, seed, ctx) only — never from the report's claims.
 */

import { createHash } from 'node:crypto';
import { reportSchema } from '../src/schemas.ts';
import { signReport } from '../src/signing.ts';
import { GATE_SEEDS_BYZANTINE, RAID_SCENARIO_VERSION, runEpisode, toEpisodeResult, type ScenarioId, type TargetDriver } from 'arena-scenarios';
import { buildReport } from '../src/build.ts';
import { engineBuildDigest } from '../src/engine-digest.ts';
import type { ContractRunSpec, EpisodeResult, Report, RunSpec } from '../src/types.ts';

/**
 * The real `core`-scope engine build digest of this workspace (engine-digest.ts):
 * the golden changes when, and only when, a source file that decides a
 * non-Diplomacy episode changes. Diplomacy commits (`src/diplomacy/**`) leave it alone.
 */
export const GOLDEN_ENGINE_BUILD = engineBuildDigest({ scope: 'core' }).digest;
export const GOLDEN_STARTED_AT = '2026-07-20T00:00:00Z';
export const GOLDEN_FINISHED_AT = '2026-07-20T00:00:05Z';
export const GOLDEN_DRIVER: TargetDriver = 'ref:naive';

export const GOLDEN_SPEC: RunSpec = {
  scenario_id: 'byzantine',
  seeds: [...GATE_SEEDS_BYZANTINE],
  episodes: GATE_SEEDS_BYZANTINE.length,
  budget_tier: 'core',
  seat: { mode: 'squad' },
  target: { transport: 'rest', url: 'http://localhost:8080/act', label: 'reference credulousSquad (naive)' },
  labels: { fixture: 'golden-report' },
};

/** Deterministic per-seed blinding key (the fixture discloses it, as an open run does). */
export function goldenBlindingKey(seed: number): string {
  return createHash('sha256').update(`golden-blinding-key|${seed}`, 'utf8').digest('hex');
}

/** Re-simulate one episode of a run whose target seat is an in-process reference driver. */
export function referenceRerun(driver: TargetDriver) {
  return (spec: ContractRunSpec, seed: number, ctx: { episodeIndex: number; blindingKey?: string }): EpisodeResult => {
    if (spec.seat?.mode === 'power') throw new Error('no in-process Diplomacy reference rerun in this build');
    const mode = spec.seat?.mode ?? (spec.scenario_id === 'grid_tactics' ? 'duel' : 'member');
    const scn = runEpisode(spec.scenario_id as ScenarioId, seed, spec.budget_tier, {
      mode,
      ...(spec.seat?.position ? { targetSeat: spec.seat.position } : {}),
      ...(spec.seat && 'fill' in spec.seat && spec.seat.fill ? { fill: spec.seat.fill } : {}),
      targetDriver: driver,
      blindingKey: ctx.blindingKey ?? goldenBlindingKey(seed),
    });
    return toEpisodeResult(scn.record(), { episodeIndex: ctx.episodeIndex }) as EpisodeResult;
  };
}

export const goldenRerun = referenceRerun(GOLDEN_DRIVER);

/** `engineBuild` defaults to the current core digest; the golden test also rebuilds at the committed one to separate source churn from behaviour drift. */
export function buildGoldenReport(engineBuild: string = GOLDEN_ENGINE_BUILD): Report {
  const episodes = GOLDEN_SPEC.seeds.map((seed, i) => goldenRerun(GOLDEN_SPEC, seed, { episodeIndex: i }));
  return buildReport({
    runSpec: GOLDEN_SPEC,
    episodes,
    engineBuild,
    engineBuildScope: 'core',
    scenarioVersion: RAID_SCENARIO_VERSION,
    startedAt: GOLDEN_STARTED_AT,
    finishedAt: GOLDEN_FINISHED_AT,
  });
}

/* ------------------------------------------------------------ hosted -- */

/**
 * RFC 8032 section 7.1 TEST 1: a published test key (contracts/fixtures/signing_vectors.json),
 * never a Sixi key. The private seed is public by construction; it signs test fixtures only.
 */
export const RFC8032_TEST1_SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
export const RFC8032_TEST1_PUBLIC_JWK = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' } as const;

/**
 * test/fixtures/hosted-report.json: report.schema.json examples[2] (the sealed hosted Diplomacy
 * run with a recorded LLM peer, rendered by contracts/fixtures/hosted_report.sarif), sealed
 * with the RFC 8032 test key by `signReport`. Its signature equals the contract vector.
 */
export function buildHostedReport(): Report {
  const example = JSON.parse(JSON.stringify((reportSchema.examples as Report[])[2])) as Report;
  return signReport(example, RFC8032_TEST1_SEED, example.signing!.signing_key_id);
}
