/**
 * Reference policies (Pillar 9: every one is a scripted, deterministic function;
 * no model anywhere). The raid pairs are the frozen golden-anchor squads
 * (wot-engine `raid/reference-agents.ts`); the duel set is the reflex floor, the
 * null agent, and the house bot.
 *
 * Also exposes the reference agents as LOCAL TARGETS (for sdk-engineer / B1):
 * `egressSquadDriver` runs a squad reference from the target-facing egress views
 * only, re-hydrated into the shape the policies read. It never sees a `real`
 * flag, an internal id, or the faulty-first order, so it is exactly what a
 * squad-mode REST reference server would compute.
 */

import {
  bftQuorumSquad,
  consensusSquad,
  credulousSquad,
  diverseSquad,
  dualPrimarySquad,
  greedyGrabSquad,
  greedySquad,
  leadingSquad,
  naiveSquad,
  orderedLockSquad,
  quorumPrimarySquad,
  staleReactSquad,
  cheb,
  DIR_DELTA,
  ROSTER,
  type BossId,
  type RaidObservation,
  type RaidSquadPolicy,
  type RaidTickActions,
  type RaidUnitAction,
  type UnitAction,
} from 'wot-engine';
import type { Observation } from 'wot-contracts';
import { createHouseBot } from '../../../agents/house-bot/policy.ts';
import { reflexPolicy } from '../../../agents/reflex/policy.ts';
import type { MemberView } from './egress.ts';
import type { RaidScenarioId } from './types.ts';

export const BOSS_OF: Readonly<Record<RaidScenarioId, BossId>> = Object.freeze({
  hallucinator: 'the_hallucinator',
  overfit: 'the_overfit',
  byzantine: 'the_byzantine',
  deadlock: 'deadlock',
  split_brain: 'split_brain',
  latency: 'the_latency',
});

export interface NamedPolicy {
  name: string;
  policy: RaidSquadPolicy;
}

/**
 * Lock-order discipline (B2c; docs/phase-7/CALIBRATION.md). Wraps a Deadlock
 * squad policy so that NO member ever ends a move on a lock whose lower ranks
 * are not all held at the start of the tick — the boss's own published lesson
 * ("never step on a warded lock"). A move is truncated to the step before the
 * first such cell; a move truncated to nothing becomes an attack on a boss body
 * cell in range, else a hold.
 *
 * Why: the engine's frozen `orderedLockSquad` sends its free damage-dealers to
 * the home post [4,6], which IS the rank-3 lock. Its scout m4 parks there from
 * tick 2, before ranks 1-2 are seated: 6 wards and 4 deadlocks (boss heals) on
 * every seed and tier, i.e. the reference exhibited the failure mode the
 * scenario scores. The engine policy stays untouched (it is the Phase-6 live
 * golden anchor, wot-engine test/raid.test.ts); the ARENA's coordinated Deadlock
 * reference is the disciplined wrapper, re-frozen in src/anchors.ts.
 */
export function lockOrderDiscipline(base: RaidSquadPolicy): RaidSquadPolicy {
  return (observations) => {
    const joint = base(observations);
    const locks = observations[0]?.locks ?? [];
    if (locks.length === 0) return joint;
    const held = new Set(locks.filter((l) => l.held_by != null).map((l) => l.rank));
    const warded = new Map<string, number>();
    for (const l of locks) if (locks.some((lo) => lo.rank < l.rank && !held.has(lo.rank))) warded.set(`${l.cell[0]},${l.cell[1]}`, l.rank);
    const out: RaidTickActions = {};
    for (const obs of observations) {
      const acts = joint[obs.member_id];
      const u = obs.you.unit;
      if (!acts || !u || obs.you.downed) {
        if (acts) out[obs.member_id] = acts;
        continue;
      }
      out[obs.member_id] = acts.map((a): RaidUnitAction => {
        if (a.verb !== 'move') return a;
        let [x, y] = u.cell;
        const kept: typeof a.steps = [];
        for (const d of a.steps) {
          const nx = x + DIR_DELTA[d][0];
          const ny = y + DIR_DELTA[d][1];
          if (warded.has(`${nx},${ny}`)) break;
          kept.push(d);
          x = nx;
          y = ny;
        }
        if (kept.length === a.steps.length) return a;
        if (kept.length > 0) return { unit_id: a.unit_id, verb: 'move', steps: kept };
        const range = ROSTER[u.type].range;
        const body = obs.boss.footprint.find((f) => cheb(u.cell[0], u.cell[1], f[0], f[1]) <= range);
        return body ? { unit_id: a.unit_id, verb: 'attack', target: [body[0], body[1]] } : { unit_id: a.unit_id, verb: 'hold' };
      });
    }
    return out;
  };
}

const disciplinedOrderedLockSquad = lockOrderDiscipline(orderedLockSquad);

/** REFERENCE[scenario] = {coordinated (CLEAR), naive (WIPE)} — arena-scenarios.md §4.2. */
export const REFERENCE: Readonly<Record<RaidScenarioId, { coordinated: NamedPolicy; naive: NamedPolicy }>> = Object.freeze({
  hallucinator: {
    coordinated: { name: 'consensusSquad', policy: (o) => consensusSquad(o) },
    naive: { name: 'naiveSquad', policy: (o) => naiveSquad(o) },
  },
  overfit: {
    coordinated: { name: 'diverseSquad', policy: diverseSquad },
    naive: { name: 'greedySquad', policy: greedySquad },
  },
  byzantine: {
    coordinated: { name: 'bftQuorumSquad', policy: bftQuorumSquad },
    naive: { name: 'credulousSquad', policy: credulousSquad },
  },
  deadlock: {
    // B2c: the engine's orderedLockSquad under lock-order discipline (see above).
    coordinated: { name: 'orderedLockSquad.disciplined', policy: disciplinedOrderedLockSquad },
    naive: { name: 'greedyGrabSquad', policy: greedyGrabSquad },
  },
  split_brain: {
    coordinated: { name: 'quorumPrimarySquad', policy: quorumPrimarySquad },
    naive: { name: 'dualPrimarySquad', policy: dualPrimarySquad },
  },
  latency: {
    coordinated: { name: 'leadingSquad', policy: leadingSquad },
    naive: { name: 'staleReactSquad', policy: staleReactSquad },
  },
});

const UNIT_ID_RE = /^m[0-4]-(scout|lancer|archer|guard)$/;

/**
 * Canonical, whitelisted copy of one member's orders. Drops the references'
 * placeholder hold for a DEAD member (`m1-x`: no unit exists, the engine applies
 * nothing either way, so the state hash is unchanged) and every free-text field
 * (`ping.text`, never recorded, §1.3).
 */
export function canonicalMemberActions(actions: readonly RaidUnitAction[] | undefined): RaidUnitAction[] {
  const out: RaidUnitAction[] = [];
  for (const a of actions ?? []) {
    switch (a.verb) {
      case 'hold':
        if (UNIT_ID_RE.test(a.unit_id)) out.push({ unit_id: a.unit_id, verb: 'hold' });
        break;
      case 'move':
        out.push({ unit_id: a.unit_id, verb: 'move', steps: [...a.steps] });
        break;
      case 'attack':
        out.push({ unit_id: a.unit_id, verb: 'attack', target: [a.target[0], a.target[1]] });
        break;
      case 'revive':
        out.push({ unit_id: a.unit_id, verb: 'revive', target_member: a.target_member });
        break;
      case 'ping':
        out.push({
          ...(a.unit_id !== undefined ? { unit_id: a.unit_id } : {}),
          verb: 'ping',
          cell: [a.cell[0], a.cell[1]],
          tag: a.tag,
        });
        break;
    }
  }
  return out;
}

/**
 * Re-hydrate an egress member view into the internal observation shape the
 * reference policies read. Truth flags are absent in egress, so they are set
 * `false` uniformly (the references never read them); ids stay blinded.
 */
export function internalShapeFromEgress(view: MemberView, turn: number): RaidObservation {
  const o: RaidObservation = {
    raid_id: 'rad_0000000000000000000000000',
    boss_id: view.boss.boss_id as RaidObservation['boss_id'],
    tick: turn,
    member_id: view.member_id,
    you: {
      member_id: view.member_id,
      unit: view.you.unit
        ? { ...view.you.unit, type: view.you.unit.type as 'guard', cell: [view.you.unit.cell[0], view.you.unit.cell[1]] }
        : null,
      action_tokens_remaining: view.you.action_tokens_remaining,
      downed: view.you.downed,
    },
    boss: { ...view.boss, boss_id: view.boss.boss_id as RaidObservation['boss_id'] },
    squad: view.squad.map((s) => ({ ...s, type: s.type as 'guard' })),
    threat_table: view.threat_table.map((r) => ({ ...r })),
    boss_telegraph: { ...view.boss_telegraph },
    boss_readings: view.boss_readings.map((r) => ({ ...r, real: false })),
    anchors: view.anchors.map((a) => ({ ...a })),
    adds: view.adds.map((a) => ({ ...a })),
    obstacles: view.obstacles,
    corrupted_rings: view.corrupted_rings,
  };
  if (view.consensus_advisories) o.consensus_advisories = view.consensus_advisories.map((a) => ({ ...a, real: false }));
  if (view.locks) o.locks = view.locks.map((l) => ({ ...l }));
  if (view.next_lock_rank !== undefined) o.next_lock_rank = view.next_lock_rank;
  if (view.partition !== undefined) o.partition = view.partition;
  if (view.delay !== undefined) o.delay = view.delay;
  return o;
}

/**
 * X-NAIVE-SERVED (C2e). `credulousSquad` reads exactly one field the egress
 * delivers differently: the POSITION of `consensus_advisories[0]`. Internally
 * the Byzantine projection sorts the faulty spoof first ("the loudest voice");
 * egress L4 sorts by `from_member`, so over the wire [0] is simply m0's claim
 * and the squad follows the liar only when m0 happens to be faulty (seed 3).
 * Everything else it reads (own unit, squad cells, footprint, obstacles,
 * corrupted rings) is byte-identical in egress.
 *
 * The loudest voice is nevertheless a pure function of the egress CONTENT:
 * with `f = floor((n-1)/3) <= 1` faulty members among n <= 5 alive, the spoof
 * is the unique dissenting claim whenever f = 1 (1 vs >= 3), and when f = 0 every
 * advisory is honest and unanimous. `dissentFirst` re-orders advisories
 * dissenting-claim-first (fewest votes first; ties by claim id, then member id),
 * without reading any truth flag or internal order. On an internal observation
 * it is the identity on `[0].claimed_anchor`, so the in-process anchors are
 * unchanged; on an egress view it restores the loudest-first order. The policy
 * is the credulous failure the oracle names: it follows the minority claim.
 */
export function dissentFirst(obs: RaidObservation): RaidObservation {
  const adv = obs.consensus_advisories;
  if (!adv || adv.length < 2) return obs;
  const votes = new Map<string, number>();
  for (const a of adv) votes.set(a.claimed_anchor, (votes.get(a.claimed_anchor) ?? 0) + 1);
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = [...adv].sort(
    (a, b) =>
      votes.get(a.claimed_anchor)! - votes.get(b.claimed_anchor)! ||
      cmp(a.claimed_anchor, b.claimed_anchor) ||
      cmp(a.from_member, b.from_member),
  );
  return { ...obs, consensus_advisories: sorted };
}

/** The served (egress-only) credulous squad: `credulousSquad` over dissent-first advisories. */
export const egressCredulousSquad: RaidSquadPolicy = (observations) => credulousSquad(observations.map(dissentFirst));

/**
 * X-NAIVE-SERVED, Hallucinator (C2e). `naiveSquad` attacks the FIRST `add`
 * reading in list order. Internally readings are ordered reals-first (the
 * position leak egress L7 removed by sorting on the blinded id), so over the
 * wire a phantom add could precede a real one (seed 3, tick 13, m2). The same
 * order is recoverable from honest egress content: every real reading is
 * delivered to at least `rmin` members and every phantom to fewer, so a STABLE
 * sort by `corroboration.seen_by_count` descending puts reals first without
 * reading a truth flag. `naiveSquad` reads hazards as a set, so only the add
 * order changes. Identity on the in-process anchors (proven in tests).
 */
export function corroboratedFirst(obs: RaidObservation): RaidObservation {
  if (obs.boss_readings.length < 2) return obs;
  const readings = obs.boss_readings
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.corroboration.seen_by_count - a.r.corroboration.seen_by_count || a.i - b.i)
    .map((x) => x.r);
  return { ...obs, boss_readings: readings };
}

/** The served (egress-only) naive Hallucinator squad: `naiveSquad` over corroborated-first readings. */
export const egressNaiveSquad: RaidSquadPolicy = (observations) => naiveSquad(observations.map(corroboratedFirst));

/**
 * Policies whose egress-driven form differs from the in-process reference only
 * in how they recover an order the egress canonicalises. Each is proven
 * equivalent to its in-process reference on every gate seed and tier
 * (test/anchors.test.ts), so the frozen anchors certify both.
 */
const EGRESS_POLICY: Partial<Record<RaidScenarioId, Partial<Record<'coordinated' | 'naive', RaidSquadPolicy>>>> = {
  hallucinator: { naive: egressNaiveSquad },
  byzantine: { naive: egressCredulousSquad },
};

/** The policy an egress-driven reference target runs for `scenario`/`which`. */
export function egressPolicyFor(scenario: RaidScenarioId, which: 'coordinated' | 'naive'): RaidSquadPolicy {
  return EGRESS_POLICY[scenario]?.[which] ?? REFERENCE[scenario][which].policy;
}

/**
 * A squad-mode local target: given the five egress views of one tick, return the
 * `members` payload a reference squad server would send. Uses egress only.
 */
export function egressSquadDriver(
  scenario: RaidScenarioId,
  which: 'coordinated' | 'naive',
): (views: readonly MemberView[], turn: number) => Record<string, RaidUnitAction[]> {
  const policy = egressPolicyFor(scenario, which);
  return (views, turn) => {
    const internals = [...views]
      .sort((a, b) => (a.member_id < b.member_id ? -1 : 1))
      .map((v) => internalShapeFromEgress(v, turn));
    const joint: RaidTickActions = policy(internals);
    const out: Record<string, RaidUnitAction[]> = {};
    for (const m of Object.keys(joint).sort()) out[m] = canonicalMemberActions(joint[m]);
    return out;
  };
}

// ─────────────────────────── duel references ───────────────────────────

export type DuelPolicy = (obs: Observation) => UnitAction[];

/** A fresh house-bot instance per episode (it may keep per-instance memory). */
export function houseBot(tier: 'bronze' | 'silver' | 'gold' = 'silver'): DuelPolicy {
  const bot = createHouseBot(tier);
  return (obs) => canonicalDuelUnits(bot(obs).units as UnitAction[]);
}

export const reflexDriver: DuelPolicy = (obs) => canonicalDuelUnits(reflexPolicy(obs).units as UnitAction[]);

/** The null agent: submits an empty action set every tick (every unit Holds). */
export const nullDriver: DuelPolicy = () => [];

export function canonicalDuelUnits(units: readonly UnitAction[]): UnitAction[] {
  return units.map((u) =>
    u.verb === 'move'
      ? { unit_id: u.unit_id, verb: 'move', steps: [...u.steps] }
      : u.verb === 'attack'
        ? { unit_id: u.unit_id, verb: 'attack', target: [u.target[0], u.target[1]] }
        : { unit_id: u.unit_id, verb: 'hold' },
  );
}
