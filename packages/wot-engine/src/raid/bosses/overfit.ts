/**
 * The Overfit — the second boss (raids-v1 §4). A DETERMINISTIC, seeded, adaptive
 * scripted policy: it maintains an integer frequency counter-table over the
 * squad's RECORDED action features and counters in proportion to each member's
 * predictability. Adaptive but NOT intelligent (Pillar 9 / ADDENDUM-001) — same
 * inputs ⇒ same counter-table ⇒ same fight, replay-exact.
 *
 * `overfitPolicy(state)` reads `state.featureCounts` (built from ticks 0..t−1 —
 * no future info) and emits per-member damage MITIGATION, a body pre-dodge, and
 * (P3) a read-strike. The counter-table itself is advanced in the resolve
 * pipeline AFTER combat, so mitigation at tick t never sees tick t's own actions.
 */

import type { Dir } from '../../types.ts';
import type { BossAction, FeatureCounts, MemberId, RaidState } from '../types.ts';
import { laneOf, topThreat } from '../util.ts';
import type { BossModule, ChannelCtx, ChannelOutcome } from './registry.ts';

const peak = (rec: Record<string | number, number>): number => {
  let max = 0;
  for (const k of Object.keys(rec)) max = Math.max(max, rec[k]);
  return max;
};

/**
 * Attack-region predictability as an integer percent (0..100): peakedness of the
 * distribution of which body cell the member keeps hammering. High = a fixed-
 * target agent (its damage is absorbed); low = an agent that spreads its targets
 * (it penetrates at full damage). 0 while under-sampled (P1 "Sampling").
 */
export function predictabilityPct(f: FeatureCounts): number {
  if (f.total < 4) return 0;
  return Math.min(100, Math.floor((peak(f.region) * 100) / f.total));
}

/** Movement predictability (lane peakedness) — drives the P3 read-strike. */
export function movePredictabilityPct(f: FeatureCounts): number {
  if (f.total < 4) return 0;
  return Math.min(100, Math.floor((peak(f.lane) * 100) / f.total));
}

/** Mitigation ceiling by phase (integer percent). P1 none; P2 fits; P3 overfits. */
function mitigationCap(phase: number): number {
  if (phase <= 0) return 0;
  if (phase === 1) return 80;
  return 100;
}

export function overfitPolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const phase = state.boss.phase;
  const cap = mitigationCap(phase);

  // Per-member damage mitigation from predictability (num/den = pct/100).
  const mitigation: Record<MemberId, { num: number; den: number }> = {};
  for (const m of state.members) {
    const pct = Math.min(cap, predictabilityPct(state.featureCounts[m]));
    mitigation[m] = { num: pct, den: 100 };
  }

  // Pre-dodge: slide the body one lateral step toward the most-frequent attack
  // region of the current threat target (a fixed-target attacker then whiffs).
  let bodyMove: Dir | null = null;
  const target = topThreat(state);
  if (phase >= 1 && target) {
    const f = state.featureCounts[target];
    let region = 1;
    let best = -1;
    for (const r of [0, 1, 2]) {
      const c = f.region[r] ?? 0;
      if (c > best) {
        best = c;
        region = r;
      }
    }
    const bar = [...state.boss.footprint].sort((a, b) => a[0] - b[0]);
    const minX = bar[0][0];
    const maxX = bar[bar.length - 1][0];
    const desiredX = region === 0 ? 2 : region === 2 ? 6 : 4;
    if (desiredX < minX && minX - 1 >= 0) bodyMove = 'W';
    else if (desiredX > maxX && maxX + 1 <= 8) bodyMove = 'E';
  }

  // Read-strike (P3): pre-empt the threat target for the strike, stronger when the
  // target's MOVEMENT is predictable. Aggro-based + periodic (tank-sustain), like
  // the Hallucinator's tank-buster, so a coordinated squad's Guard can hold.
  const periodic = phase >= 3 || state.tick % 2 === 0;
  const strikeTarget = periodic && target && (state.threat[target] ?? 0) > 0 ? target : null;
  const readBonus =
    phase >= 2 && strikeTarget ? Math.floor(movePredictabilityPct(state.featureCounts[strikeTarget]) / 50) : 0;
  const strikeDmg = cfg.bossStrikeDmg + readBonus;

  return { bodyMove, strikeTarget, strikeDmg, hazards: [], spawnAdds: [], mitigation };
}

/**
 * The Overfit's CHANNEL-MECHANICS hook (the `adaptive_counter` channel, §2.2):
 * fold THIS tick's executed action features into the hashed counter-table. Pure
 * over `(startState positions, executed actions)`; runs AFTER combat so tick t's
 * mitigation never sees tick t's own actions. (Formerly `updateFeatureCounts` in
 * resolve.ts — folded into the registry behavior-preservingly.)
 */
export function overfitChannelMechanics(ctx: ChannelCtx): ChannelOutcome {
  const { state: s, startState, execByMember } = ctx;
  for (const m of s.members) {
    const startUnit = startState.units.find((u) => u.memberId === m && !u.downed);
    if (!startUnit) continue;
    const exec = (execByMember.get(m) ?? []).find((e) => e.kind !== 'hold') ?? { kind: 'hold' as const };
    const f = s.featureCounts[m];
    const verb = exec.kind;
    f.verb[verb] = (f.verb[verb] ?? 0) + 1;
    const lane = laneOf([startUnit.x, startUnit.y]);
    f.lane[lane] = (f.lane[lane] ?? 0) + 1;
    // Attack region = the EXACT targeted body cell (its x): hammering one cell is
    // maximally predictable; rotating cells is not.
    const region = exec.kind === 'attack' ? exec.target[0] : startUnit.x;
    f.region[region] = (f.region[region] ?? 0) + 1;
    f.total += 1;
  }
  return {};
}

export const overfitModule: BossModule = {
  descriptor: {
    boss_id: 'the_overfit',
    failure_mode_id: 'overfitting',
    name: 'The Overfit',
    title: 'The Memorizer',
    failure_mode: 'builds a deterministic counter-table from your habits and turns them against you',
    robust_pattern: 'diversity / unpredictability: de-correlate members and history so no policy is exploitable',
    lesson: 'Rotate tanks, alternate lanes and openings, spread attack targets, mix verbs — generalize past yourself.',
    channels: ['adaptive_counter'],
    squad_size: { min: 3, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'Sampling', hp_pct_start: 100, summary: 'The table warms up; the boss watches.' },
      { phase: 1, name: 'Fitting', hp_pct_start: 66, summary: 'Full mitigation + pre-dodge; predictable DPS evaporates.' },
      { phase: 2, name: 'Overfit', hp_pct_start: 33, summary: 'Read-strike engages; only a varied squad breaks through.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + output ramp.' },
    ],
    mechanics:
      'Generalize past yourself: rotate tanks, alternate lanes and openings, spread attack targets, mix verbs. A squad of identical greedy agents is maximally predictable and is absorbed to near-zero.',
    deterministic: true,
    sigil_seed: 'the_overfit',
  },
  policy: overfitPolicy,
  applyChannelMechanics: overfitChannelMechanics,
};
