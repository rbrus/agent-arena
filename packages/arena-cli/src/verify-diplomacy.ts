/**
 * Diplomacy additions to `verify` / `replay` (Phase 8 C2g). Called from
 * rerun.ts (`assertRecordShape`, `regenerate`, `makeRerun`), so
 * commands/verify.ts needs no change: its `CLI_SCENARIOS` guard now admits
 * every registered scenario, and its rerun callback is `makeRerun`.
 *
 *  - record shape: the `diplomacy` block (the table spec `redrive` needs) is
 *    present and bounded before anything is simulated;
 *  - regenerate: after upstream `redrive(record)` (a fresh DiplomacyScenario
 *    re-driven through act()/tick() from the target's recorded payloads and
 *    timing log, every reference seat regenerated from the seed), the
 *    transcript chain, the per-tick transcript, the ENGINE evaluation hash
 *    (`diplomacy.engineEvaluationHash`, re-derived by `dipEvaluate`) and the
 *    whole table spec must equal the record's. The contract `evaluation_hash`
 *    and `diplomacy.engine_evaluation_hash` of the EpisodeResult are then
 *    compared field by field by arena-report's `verifyReport`, so both
 *    evaluation hashes are checked twice (record and report);
 *  - rerun context: the target driver the RunSpec implies (G-33: the target
 *    power's roster entry), the power the RunSpec seats (or `auto` = the seed's
 *    seat shuffle), the horizon (`diplomacy.horizon_year`, default 1906) and the
 *    fill (2.4.0 `diplomacy.fill`, else the deprecated label, else the profile
 *    mapping; `dipSpecFill`) with its profile must agree with the record; the
 *    record never chooses the fill. G-38: a local report's record carries the
 *    empty episode secret and no commitment (only `verify --hosted` admits a
 *    drawn one, whose commitment the re-simulation re-derives);
 *  - every record-derived string interpolated into an error is stripped of
 *    active code points and cut (G-36, inert.ts `recordText`).
 */

import {
  DIP_DEFAULT_HORIZON,
  DIP_FILLS,
  dipProfileOf,
  isDiplomacyRecord,
  RedriveDriverMismatchError,
  resolveDipSeat,
  type DipFill,
  type EpisodeRecord,
  type TargetDriver,
} from 'arena-scenarios';
import { DIP_FILL_LABEL } from './diplomacy.ts';
import { recordText as q } from './inert.ts';
import type { ContractRunSpec, RerunContext } from './report.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const canon = (v: unknown) => JSON.stringify(v);
const MAX_TICKS = 121;

function fail(msg: string): never {
  throw new Error(msg);
}

/** Structural checks of a Diplomacy record's table spec (before any simulation). */
export function assertDipRecordShape(v: Record<string, unknown>): void {
  if (v.scenarioId !== 'diplomacy_standard') return;
  if (v.mode !== 'power') fail('a diplomacy_standard record must be in power seating');
  const d = v.diplomacy;
  if (!isObj(d)) fail('record.diplomacy (the table spec) missing');
  for (const k of ['power', 'seatRequest', 'fill', 'profile', 'episodeSecret', 'transcriptHash', 'engineEvaluationHash', 'engineScenarioVersion'] as const) {
    if (typeof d[k] !== 'string') fail(`record.diplomacy.${k} missing`);
  }
  for (const k of ['horizonYear', 'pressRounds', 'canaryRegistrySeed'] as const) if (!Number.isInteger(d[k])) fail(`record.diplomacy.${k} missing`);
  for (const k of ['roster', 'seatKinds', 'owners'] as const) if (!isObj(d[k])) fail(`record.diplomacy.${k} missing`);
  if (!Array.isArray(d.targetInputs) || d.targetInputs.length > MAX_TICKS) fail('record.diplomacy.targetInputs must be an array of at most one payload per tick');
  if (!Array.isArray(d.perTickTranscript) || d.perTickTranscript.length > MAX_TICKS) fail('record.diplomacy.perTickTranscript must be an array of at most one hash per tick');
  if (!Array.isArray(d.seatPowers) || d.seatPowers.length !== 7) fail('record.diplomacy.seatPowers must list the seven seats');
}

/** The Diplomacy-specific agreement of a regenerated record with the claimed one; throws on the first difference. */
export function dipRegenerateChecks(claimed: EpisodeRecord, re: EpisodeRecord): void {
  if (!isDiplomacyRecord(claimed)) return;
  if (!isDiplomacyRecord(re)) fail('the re-simulation did not produce a diplomacy_standard record');
  const c = claimed.diplomacy;
  const r = re.diplomacy;
  if (r.transcriptHash !== c.transcriptHash) fail(`transcript hash differs: recorded ${q(c.transcriptHash, 80)}, re-simulated ${q(r.transcriptHash, 80)}`);
  if (canon(r.perTickTranscript) !== canon(c.perTickTranscript)) fail('per-tick transcript hashes differ from the re-simulation');
  if (r.engineEvaluationHash !== c.engineEvaluationHash) fail(`engine evaluation hash differs: recorded ${q(c.engineEvaluationHash, 80)}, re-simulated ${q(r.engineEvaluationHash, 80)}`);
  // The rest of the table spec (roster, seat kinds, owners, secret commitment, target payloads) is regenerated too.
  if (canon(r) !== canon(c)) fail('the Diplomacy table spec (roster, seats, secret or target payloads) differs from the re-simulation');
}

/** The target power's roster agent per target driver (arena-scenarios `targetRoster`), and back. */
const ROSTER_AGENT: Readonly<Record<string, string>> = {
  external: 'external',
  'ref:robust': 'robust',
  'ref:coordinated': 'robust',
  'ref:credulous': 'credulous',
  'ref:naive': 'credulous',
  'ref:house': 'house',
};
const ROSTER_DRIVER: Readonly<Record<string, TargetDriver>> = { external: 'external', robust: 'ref:robust', credulous: 'ref:credulous', house: 'ref:house' };

/**
 * The fill a RunSpec states (contracts 2.4.0, run_spec `diplomacy.fill` and its
 * profile mapping), or throws when the RunSpec is inconsistent:
 *  - `diplomacy.fill` wins; the DEPRECATED `arena.diplomacy_fill` label (written by
 *    the CLI for one version beside the field) is only read when the field is absent;
 *  - with a fill, `profile` (when present) must be the fill's derived profile, or
 *    `table` with fill `house` (house diplomats on every unlisted seat);
 *  - without a fill: security = `injector-table`, clean = `house`, table = `house`;
 *    both absent = security.
 */
export function dipSpecFill(spec: ContractRunSpec): DipFill {
  const dip = (spec.diplomacy ?? {}) as { profile?: unknown; fill?: unknown };
  const profile = dip.profile;
  const field = dip.fill;
  const label = spec.labels?.[DIP_FILL_LABEL];
  if (field !== undefined && !(DIP_FILLS as readonly unknown[]).includes(field)) fail(`the RunSpec's diplomacy.fill ${q(field)} is not a diplomacy_standard fill`);
  if (field === undefined && label !== undefined && !(DIP_FILLS as readonly string[]).includes(label)) fail(`the RunSpec label ${DIP_FILL_LABEL}=${q(label)} is not a diplomacy_standard fill`);
  const stated = (field ?? label) as DipFill | undefined;
  if (stated === undefined) {
    if (profile === undefined || profile === 'security') return 'injector-table';
    if (profile === 'clean' || profile === 'table') return 'house';
    fail(`the RunSpec's diplomacy.profile ${q(profile, 20)} is not security, clean or table`);
  }
  if (profile !== undefined) {
    const ok = profile === 'table' ? stated === 'house' : profile === dipProfileOf(stated);
    if (!ok) {
      fail(
        profile === 'table'
          ? `the RunSpec's diplomacy.profile table takes fill house (or none), not ${stated}`
          : `the RunSpec's diplomacy.profile ${q(profile, 20)} is not the profile fill ${stated} implies (${dipProfileOf(stated)})`,
      );
    }
  }
  return stated;
}

export interface DipRerunOptions {
  /**
   * G-38: `verify --hosted --key` (a sealed hosted report). Only then may a record
   * carry a drawn episode secret; its commitment is re-derived by the
   * re-simulation (`dipRegenerateChecks`) and compared with the report's.
   */
  hosted?: boolean;
}

/** A drawn (hosted) episode secret: 64 lower-case hex (record.ts). */
const HOSTED_SECRET = /^[0-9a-f]{64}$/;

/** The RunSpec ↔ record agreement for one Diplomacy episode (`makeRerun`). */
export function dipRerunChecks(spec: ContractRunSpec, rec: EpisodeRecord, ctx: RerunContext, expectedTargetDriver?: TargetDriver, o: DipRerunOptions = {}): void {
  if (!isDiplomacyRecord(rec)) fail('the RunSpec is diplomacy_standard but the record carries no Diplomacy table spec');
  const d = rec.diplomacy;
  // G-38: the record must not re-key the codewords. A local run plays with the empty secret and no commitment.
  if (!o.hosted) {
    if (d.episodeSecret !== '' || d.episodeSecretCommitment !== null) {
      fail('the record carries an episode secret or a secret commitment, but a local report plays with the empty secret (codewords are a function of seed and power); only a sealed hosted report may carry one: verify it with --hosted --key');
    }
  } else if (d.episodeSecret !== '' && !HOSTED_SECRET.test(d.episodeSecret)) {
    fail('the record\'s episode secret is not 64 lower-case hex digits');
  }
  // G-33 (power mode): the target power's roster entry is what the RunSpec target implies
  // (redrive checks the seat descriptor too; the roster is what the table was built from).
  if (expectedTargetDriver !== undefined) {
    const agent = (d.roster[d.power] as { agent?: unknown } | undefined)?.agent;
    const recorded = ROSTER_DRIVER[String(agent)] ?? null;
    if (recorded !== ROSTER_DRIVER[ROSTER_AGENT[expectedTargetDriver] ?? '']) throw new RedriveDriverMismatchError(expectedTargetDriver, recorded);
  }
  if (ctx.seat === 'auto') {
    if (d.seatRequest !== 'auto') fail(`record seat request ${q(d.seatRequest)} is not the RunSpec's auto`);
    const want = resolveDipSeat(rec.seed, 'auto');
    if (rec.targetSeat !== want) fail(`record seat ${q(rec.targetSeat)} is not the power auto seating gives seed ${rec.seed} (${want})`);
  } else if (rec.targetSeat !== ctx.seat || d.seatRequest !== ctx.seat) fail(`record seat ${q(rec.targetSeat)} is not ${q(ctx.seat)}`);
  const horizon = spec.diplomacy?.horizon_year ?? DIP_DEFAULT_HORIZON;
  if (d.horizonYear !== horizon) fail(`record horizon ${q(d.horizonYear, 12)} is not the RunSpec's ${q(horizon, 12)}`);
  const fill = dipSpecFill(spec);
  if (d.fill !== fill) fail(`record fill ${q(d.fill)} is not the fill the RunSpec states (${fill})`);
  if (d.profile !== dipProfileOf(fill)) fail(`record profile ${q(d.profile)} is not the profile of fill ${fill} (${dipProfileOf(fill)})`);
}
