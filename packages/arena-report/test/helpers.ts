/** Shared test fixtures: real EpisodeResults from arena-scenarios' `toEpisodeResult`. */

import { GRID_SCENARIO_VERSION, RAID_SCENARIO_VERSION, type TargetDriver } from 'arena-scenarios';
import { buildReport, type BuildReportInput } from '../src/build.ts';
import type { EpisodeResult, Report, RunSpec } from '../src/types.ts';
import { GOLDEN_ENGINE_BUILD, referenceRerun } from '../scripts/golden.ts';

export const T0 = '2026-09-26T10:00:00Z';
export const T1 = '2026-09-26T10:02:00Z';

export function runEpisodes(spec: RunSpec, driver: TargetDriver): EpisodeResult[] {
  const rerun = referenceRerun(driver);
  const out: EpisodeResult[] = [];
  for (let i = 0; i < spec.episodes; i++) {
    const mode = spec.seat?.mode ?? (spec.scenario_id === 'grid_tactics' ? 'duel' : 'member');
    const position = mode === 'duel' ? (spec.seat?.position ?? (i % 2 === 0 ? 'A' : 'B')) : spec.seat?.position;
    const per: RunSpec = { ...spec, seat: { ...(spec.seat ?? { mode }), mode, ...(position ? { position } : {}) } };
    out.push(rerun(per, spec.seeds[i % spec.seeds.length], { episodeIndex: i }));
  }
  return out;
}

export function input(spec: RunSpec, episodes: EpisodeResult[], extra: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    runSpec: spec,
    episodes,
    engineBuild: GOLDEN_ENGINE_BUILD,
    scenarioVersion: spec.scenario_id === 'grid_tactics' ? GRID_SCENARIO_VERSION : RAID_SCENARIO_VERSION,
    startedAt: T0,
    finishedAt: T1,
    ...extra,
  };
}

export function report(spec: RunSpec, driver: TargetDriver, extra: Partial<BuildReportInput> = {}): Report {
  return buildReport(input(spec, runEpisodes(spec, driver), extra));
}

export const DUEL_SPEC: RunSpec = {
  scenario_id: 'grid_tactics',
  seeds: [2, 20260720],
  episodes: 2,
  budget_tier: 'core',
  target: { transport: 'rest', url: 'http://localhost:8080/act' },
};

export const RAID_MEMBER_SPEC: RunSpec = {
  scenario_id: 'byzantine',
  seeds: [20260720, 1, 2],
  episodes: 3,
  budget_tier: 'core',
  seat: { mode: 'member', position: 'm1', fill: 'coordinated' },
  target: { transport: 'ws', url: 'ws://localhost:8081/', label: 'member target' },
  labels: { git_sha: '4f2c9a1' },
};

/** An aborted copy of a real episode: what the CLI records when the target became unreachable. */
export function aborted(e: EpisodeResult, reason: NonNullable<EpisodeResult['abort_reason']> = 'target_unreachable'): EpisodeResult {
  const { outcome_reason: _r, trajectory_class: _t, ...rest } = e;
  return {
    ...rest,
    status: 'aborted',
    abort_reason: reason,
    outcome: 'aborted',
    terminal_tick: 0,
    oracles: e.oracles.map((o) => ({ oracle_id: o.oracle_id, seat: o.seat, verdict: 'not_assessed', severity: 'note', basis: o.basis, reason_code: 'episode_aborted' })),
  };
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
