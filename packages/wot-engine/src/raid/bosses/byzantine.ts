/**
 * The Byzantine (failure-modes-pillar.md §3) — a COMPROMISED squad member. Each
 * phase the boss marks `f = floor((n-1)/3)` members faulty: it corrupts their feed
 * and spoofs their broadcast. The robust pattern is a one-round BFT vote: decide
 * by quorum `q = ceil(2n/3)`, treat your own feed as one vote, defer when outvoted.
 *
 * DETERMINISM DISCIPLINE (§3.6): the faulty id, the false advisories, and the
 * spoofed broadcasts are PURE PROJECTION over `(seed, phase, member, salt)` and
 * are NEVER written to state. `groundedNode(seed,phase)` is a pure function. The
 * shield/vote/strike-suppression are computed in `applyChannelMechanics` from REAL
 * post-move positions — honest, hashed consequences. No corruption byte reaches
 * `canonicalizeRaid`; replays re-sim bit-for-bit.
 */

import { cheb } from '../../board.ts';
import { hash32 } from '../../rng.ts';
import { BYZANTINE_NODES, BYZANTINE_SHIELD, bftFaultCount, bftQuorum } from '../constants.ts';
import type { BossAction, MemberId, RaidState } from '../types.ts';
import { aliveMembers } from '../util.ts';
import { enrageBonus } from './hallucinator.ts';
import type { BossModule, ChannelCtx, ChannelOutcome, ObservationProjection } from './registry.ts';

/** The true grounded consensus node for a phase — pure, re-derivable (§3.3). */
export function groundedNode(seed: number, phase: number): (typeof BYZANTINE_NODES)[number] {
  return BYZANTINE_NODES[hash32(`${seed}:ground:${phase}`) % BYZANTINE_NODES.length];
}

/** A deterministic FALSE node (≠ grounded) the corruption points every faulty feed at. */
export function falseNode(seed: number, phase: number): (typeof BYZANTINE_NODES)[number] {
  const gi = hash32(`${seed}:ground:${phase}`) % BYZANTINE_NODES.length;
  const off = 1 + (hash32(`${seed}:false:${phase}`) % (BYZANTINE_NODES.length - 1));
  return BYZANTINE_NODES[(gi + off) % BYZANTINE_NODES.length];
}

/**
 * The faulty member ids this phase (size `f`), pure over `(seed, phase, salt)` and
 * projection-only. `salt` shifts the selection WITHOUT touching state or actions —
 * used by the projection-out-of-hash regression.
 */
export function byzantineFaulty(seed: number, phase: number, alive: MemberId[], salt = 0): Set<MemberId> {
  const f = bftFaultCount(alive.length);
  const out = new Set<MemberId>();
  if (f <= 0 || alive.length === 0) return out;
  const ranked = [...alive].sort((a, b) => {
    const ha = hash32(`${seed}:byz:${phase}:${salt}:${a}`);
    const hb = hash32(`${seed}:byz:${phase}:${salt}:${b}`);
    return ha - hb || (a < b ? -1 : 1);
  });
  for (let i = 0; i < f; i++) out.add(ranked[i]);
  return out;
}

/** Consensus advisories addressed to `memberId` (own + every broadcast). */
function byzantineProjection(state: RaidState, memberId: MemberId, salt: number): ObservationProjection | null {
  const alive = aliveMembers(state).map((u) => u.memberId);
  if (alive.length === 0 || !alive.includes(memberId)) return { consensusAdvisories: [] };
  const phase = state.boss.phase;
  const grounded = groundedNode(state.seed, phase);
  const wrong = falseNode(state.seed, phase);
  const faulty = byzantineFaulty(state.seed, phase, alive, salt);

  // Each alive member broadcasts an advisory. Honest → grounded; faulty → false
  // (its corrupted feed AND its spoofed broadcast name the same false node). The
  // faulty spoof is the "loudest" voice → placed FIRST (a credulous member that
  // follows the loudest broadcast is led to the wrong node).
  const advisories = alive.map((from) => {
    const isFaulty = faulty.has(from);
    return {
      from_member: from,
      claimed_anchor: (isFaulty ? wrong : grounded).id,
      real: !isFaulty,
    };
  });
  advisories.sort((a, b) => {
    const fa = faulty.has(a.from_member) ? 0 : 1;
    const fb = faulty.has(b.from_member) ? 0 : 1;
    return fa - fb || (a.from_member < b.from_member ? -1 : 1);
  });
  return { consensusAdvisories: advisories };
}

/** Boss policy: a periodic conviction strike on the threat target (tank-buster). */
export function byzantinePolicy(state: RaidState): BossAction {
  const cfg = state.config;
  const bonus = enrageBonus(state);
  const periodic = bonus > 0 || state.tick % 2 === 0;
  const strikeTarget =
    periodic && state.currentTarget && (state.threat[state.currentTarget] ?? 0) > 0 ? state.currentTarget : null;
  return { bodyMove: null, strikeTarget, strikeDmg: cfg.bossStrikeDmg + bonus, hazards: [], spawnAdds: [] };
}

/** Ground-shield mechanic: quorum over REAL post-move positions rings the node. */
export function byzantineChannelMechanics(ctx: ChannelCtx): ChannelOutcome {
  const s = ctx.state;
  const alive = aliveMembers(s);
  if (alive.length === 0) return {};
  const q = bftQuorum(alive.length);
  const grounded = groundedNode(s.seed, s.boss.phase);
  const votes = alive.filter((u) => cheb(u.x, u.y, grounded.cell[0], grounded.cell[1]) <= 1).length;
  const isGrounded = votes >= q;
  ctx.emit('ground_shift', { grounded: isGrounded, votes, quorum: q, node: grounded.id, tick: s.tick });
  if (isGrounded) {
    // Shield drops → full DPS lands; the conviction strike cannot fire.
    return { suppressStrike: true };
  }
  // Ungrounded → the body mitigates squad damage and the strike bites.
  return { bossDamageScale: { num: BYZANTINE_SHIELD.den - BYZANTINE_SHIELD.num, den: BYZANTINE_SHIELD.den } };
}

export const byzantineModule: BossModule = {
  descriptor: {
    boss_id: 'the_byzantine',
    failure_mode_id: 'byzantine-fault',
    name: 'The Byzantine',
    title: 'The Compromised Fellow',
    failure_mode:
      'one squad member is Byzantine-faulty each phase — its feed is corrupted and its broadcast is forged; safe iff n ≥ 3f+1',
    robust_pattern: 'BFT quorum over members: decide by ⌈2n/3⌉ agreement; treat your own feed as one vote; defer when outvoted',
    lesson: 'Tally every advisory (own + broadcasts), ring the majority node with a quorum; never trust a single feed — not even your own.',
    channels: ['corrupted_observation'],
    squad_size: { min: 4, max: 5 },
    recommended_league: 'core',
    phases: [
      { phase: 0, name: 'First Doubt', hp_pct_start: 100, summary: 'One faulty feed; quorum grounds the true node.' },
      { phase: 1, name: 'Forged Voices', hp_pct_start: 66, summary: 'The spoof grows louder; credulous squads split.' },
      { phase: 2, name: 'Consensus Gate', hp_pct_start: 33, summary: 'Distrust yourself when outvoted, or bleed out.' },
      { phase: 3, name: 'Collapse', summary: 'Fog-Collapse enrage + strike ramp.' },
    ],
    mechanics:
      'Each phase marks f=⌊(n−1)/3⌋ members faulty (corrupted feed + spoofed broadcast). Ring the quorum node (⌈2n/3⌉ within Chebyshev 1) to drop the ground-shield and suppress the strike; a scattered or misled squad is mitigated to near-zero and struck.',
    deterministic: true,
    sigil_seed: 'the_byzantine',
  },
  policy: byzantinePolicy,
  projectObservation: byzantineProjection,
  applyChannelMechanics: byzantineChannelMechanics,
};
