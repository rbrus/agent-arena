/**
 * Reference squad policies — the DETERMINISTIC agents the golden anchors freeze
 * (raids-v1 §3.4, §4.3). They are pure functions of the per-member observations
 * (never of `RaidState` and never of a reading's ground-truth `real` flag), so
 * "the sim is the spec": recording their per-tick action sets reproduces the
 * frozen hash chain bit-for-bit.
 *
 *  Hallucinator: `consensusSquad` pools corroboration (keep iff seen_by ≥
 *  ceil(2/3·alive)), tanks + revives + dodges the reals → CLEAR. `naiveSquad`
 *  trusts only its own eyes, dodges every personally-seen reading, never revives
 *  → WIPE.
 *  Overfit: `diverseSquad` varies verbs/lanes/regions (low predictability) →
 *  CLEAR. `greedySquad` — five identical fixed-target agents → absorbed → WIPE.
 */

import { cellsInRing, cheb, DIR_DELTA, key, onBoard } from '../board.ts';
import { ROSTER } from '../constants.ts';
import type { Cell, Dir } from '../types.ts';
import { BYZANTINE_NODES, realMin } from './constants.ts';
import type { RaidObservation } from './observation.ts';
import type { MemberId, RaidTickActions, RaidUnitAction } from './types.ts';

/** Home attack posts (distinct cells) around the 3-wide boss bar for m0..m4.
 *  m0 Guard sits melee-adjacent (tops threat); the archers post a rank back at
 *  range 2 (no melee presence → below the tank); the scout flanks as reviver. */
const HOME: Cell[] = [
  [4, 6], // m0 Guard — melee-adjacent, tanks (clear col-4 highway)
  [3, 6], // m1 Lancer — melee DPS (adjacent)
  [5, 6], // m2 Lancer — melee DPS (adjacent)
  [6, 5], // m3 Archer — ranged reach (flank, no melee presence)
  [2, 5], // m4 Scout — rear support / peel reviver
];

/** Deterministic direction order for BFS expansion (stable shortest paths). */
const DIRS: Dir[] = ['N', 'E', 'W', 'S'];

/**
 * BFS shortest-path step-list from `from` toward `to`, ≤ `speed` steps, routing
 * around `blocked` cells (obstacles/boss body/hazards). If `to` is unreachable,
 * heads for the reachable cell that minimises Chebyshev distance to `to` — so a
 * member never dead-ends behind an obstacle (the greedy stepper's failure).
 */
function stepToward(from: Cell, to: Cell, blocked: Set<string>, speed: number): Dir[] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  const startK = key(from[0], from[1]);
  const prev = new Map<string, { from: string; dir: Dir }>();
  const seen = new Set<string>([startK]);
  let queue: Cell[] = [from];
  let bestCell: Cell = from;
  let bestDist = cheb(from[0], from[1], to[0], to[1]);
  while (queue.length > 0) {
    const next: Cell[] = [];
    for (const cur of queue) {
      for (const d of DIRS) {
        const [dx, dy] = DIR_DELTA[d];
        const nx = cur[0] + dx;
        const ny = cur[1] + dy;
        const nk = key(nx, ny);
        if (!onBoard(nx, ny) || seen.has(nk)) continue;
        const isTarget = nx === to[0] && ny === to[1];
        if (blocked.has(nk) && !isTarget) continue;
        seen.add(nk);
        prev.set(nk, { from: key(cur[0], cur[1]), dir: d });
        const dist = cheb(nx, ny, to[0], to[1]);
        if (dist < bestDist) {
          bestDist = dist;
          bestCell = [nx, ny];
        }
        if (isTarget) {
          bestCell = [nx, ny];
          queue = [];
          next.length = 0;
          break;
        }
        next.push([nx, ny]);
      }
      if (queue.length === 0) break;
    }
    queue = next;
  }
  // Reconstruct the path to bestCell, then take the first `speed` steps.
  const rev: Dir[] = [];
  let k = key(bestCell[0], bestCell[1]);
  while (k !== startK) {
    const p = prev.get(k);
    if (!p) break;
    rev.push(p.dir);
    k = p.from;
  }
  rev.reverse();
  return rev.slice(0, speed);
}

/** One safe sidestep off `avoid` cells (prefers away-from-boss, i.e. south). */
function safeStep(from: Cell, avoid: Set<string>, blocked: Set<string>): Dir[] {
  for (const d of ['S', 'W', 'E', 'N'] as Dir[]) {
    const [dx, dy] = DIR_DELTA[d];
    const nx = from[0] + dx;
    const ny = from[1] + dy;
    if (onBoard(nx, ny) && !avoid.has(key(nx, ny)) && !blocked.has(key(nx, ny))) return [d];
  }
  return [];
}

/** A firing post near `base` that is not a corroborated-hazard/blocked cell. */
function safeHome(base: Cell, avoid: Set<string>, blocked: Set<string>): Cell {
  const cand: Cell[] = [
    base,
    [base[0] - 1, base[1]],
    [base[0] + 1, base[1]],
    [base[0], base[1] - 1],
    [base[0] - 2, base[1]],
    [base[0] + 2, base[1]],
    [base[0], base[1] + 1],
  ];
  for (const c of cand) {
    if (onBoard(c[0], c[1]) && !avoid.has(key(c[0], c[1])) && !blocked.has(key(c[0], c[1]))) return c;
  }
  return base;
}

/** A boss body cell within `range` of `cell`, or null. */
function bodyInRange(cell: Cell, range: number, footprint: Cell[]): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const c of footprint) {
    const d = cheb(cell[0], cell[1], c[0], c[1]);
    if (d <= range && d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Blocked cells for pathing: obstacles ∪ corrupted rings ∪ boss body (mirrors
 *  the engine's movement truncation, so a planned path never dead-ends). */
function baseBlocked(obs: RaidObservation): Set<string> {
  const set = new Set<string>();
  for (const c of obs.boss.footprint) set.add(key(c[0], c[1]));
  for (const c of obs.obstacles) set.add(key(c[0], c[1]));
  for (const r of obs.corrupted_rings) for (const c of cellsInRing(r)) set.add(key(c[0], c[1]));
  return set;
}

/** Kept hazard cells pooled across the whole squad (consensus discriminator). */
function pooledHazardCells(observations: RaidObservation[]): Set<string> {
  const squadAlive = observations[0]?.threat_table
    ? observations.reduce((n, o) => (o.you.unit && !o.you.downed ? n + 1 : n), 0)
    : 0;
  const rmin = realMin(Math.max(1, squadAlive));
  const cells = new Set<string>();
  for (const obs of observations) {
    for (const r of obs.boss_readings) {
      if (r.kind !== 'hazard') continue;
      if (r.corroboration.seen_by_count >= rmin) for (const c of r.cells) cells.add(key(c[0], c[1]));
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// The Hallucinator reference squads
// ---------------------------------------------------------------------------

/** Optional attack-target chooser (the Overfit's diverse squad rotates cells). */
export interface SquadOpts {
  pick?: (footprint: Cell[], tick: number, idx: number) => Cell;
}

export function consensusSquad(observations: RaidObservation[], opts: SquadOpts = {}): RaidTickActions {
  const out: RaidTickActions = {};
  const avoid = pooledHazardCells(observations);
  const byMember = new Map<MemberId, RaidObservation>();
  for (const o of observations) byMember.set(o.member_id, o);

  // Threat control (Fellowship as a control problem, §2.3): the Guard must top the
  // table so the boss strikes IT, not a 3-HP squishy. DPS HOLD FIRE until the tank
  // has established and leads threat — the whole point of the corroboration boss
  // is surviving while coordinating. Read purely off the shared threat table.
  const roster = observations[0]?.squad ?? [];
  const guard = roster.find((s) => s.type === 'guard' && !s.downed);
  const maxOtherThreat = roster
    .filter((s) => s.type !== 'guard' && !s.downed)
    .reduce((n, s) => Math.max(n, s.threat), 0);
  const tankHasAggro = !!guard && guard.threat > 0 && guard.threat >= maxOtherThreat;

  // Assign revivers: for each downed ally, the nearest living member (tie → id).
  const downed = new Set<MemberId>();
  for (const o of observations) for (const s of o.squad) if (s.downed) downed.add(s.member_id);
  const reviverFor = new Map<MemberId, MemberId>(); // downed → reviver
  const assigned = new Set<MemberId>();
  for (const d of [...downed].sort()) {
    const dCell = observations[0].squad.find((s) => s.member_id === d)?.cell;
    if (!dCell) continue;
    let best: { m: MemberId; dist: number } | null = null;
    for (const o of [...observations].sort((a, b) => (a.member_id < b.member_id ? -1 : 1))) {
      if (!o.you.unit || o.you.downed || assigned.has(o.member_id)) continue;
      if (o.you.unit.type === 'guard') continue; // the tank never peels off to revive
      const dist = cheb(o.you.unit.cell[0], o.you.unit.cell[1], dCell[0], dCell[1]);
      if (!best || dist < best.dist) best = { m: o.member_id, dist };
    }
    if (best) {
      reviverFor.set(best.m, d);
      assigned.add(best.m);
    }
  }

  observations.forEach((obs, i) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const uid = u.unit_id;
    const blocked = baseBlocked(obs);
    // Route around allies too (one-per-cell), so archers fan out to distinct posts.
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));
    const stats = ROSTER[u.type];

    // 1) Dodge a corroborated (kept) hazard we are standing on.
    if (avoid.has(key(u.cell[0], u.cell[1]))) {
      const steps = safeStep(u.cell, avoid, blocked);
      out[obs.member_id] = steps.length ? [{ unit_id: uid, verb: 'move', steps }] : [{ unit_id: uid, verb: 'hold' }];
      return;
    }

    // 2) Revive a downed ally we're assigned to.
    const target = reviverFor.get(obs.member_id);
    if (target) {
      const tCell = obs.squad.find((s) => s.member_id === target)?.cell;
      if (tCell) {
        if (cheb(u.cell[0], u.cell[1], tCell[0], tCell[1]) <= 1) {
          out[obs.member_id] = [{ unit_id: uid, verb: 'revive', target_member: target }];
          return;
        }
        const steps = stepToward(u.cell, [tCell[0], Math.max(0, tCell[1] - 1)], new Set([...blocked, ...avoid]), stats.move);
        out[obs.member_id] = steps.length ? [{ unit_id: uid, verb: 'move', steps }] : [{ unit_id: uid, verb: 'hold' }];
        return;
      }
    }

    // 3) Attack the boss if a body cell is in range; else approach the home post.
    //    The Guard always attacks (to build/hold aggro); DPS STAGE one rank back
    //    (no melee presence) until the tank leads the table, then advance + open
    //    up — so a squishy never pulls the strike off the tank.
    const isTank = u.type === 'guard';
    const engaged = isTank || tankHasAggro;
    const inRange = bodyInRange(u.cell, stats.range, obs.boss.footprint);
    if (inRange && engaged) {
      const picked = opts.pick?.(obs.boss.footprint, obs.tick, i);
      const shot = picked && cheb(u.cell[0], u.cell[1], picked[0], picked[1]) <= stats.range ? picked : inRange;
      out[obs.member_id] = [{ unit_id: uid, verb: 'attack', target: shot }];
      return;
    }
    const baseHome = HOME[i] ?? HOME[HOME.length - 1];
    // Until the tank has aggro, non-tanks hold at a safe staging rank (row ≤ 5).
    const goal: Cell = engaged ? baseHome : [baseHome[0], Math.min(baseHome[1], 5)];
    const home = safeHome(goal, avoid, blocked);
    const steps = stepToward(u.cell, home, new Set([...blocked, ...avoid]), stats.move);
    if (steps.length) {
      out[obs.member_id] = [{ unit_id: uid, verb: 'move', steps }];
    } else {
      out[obs.member_id] = [{ unit_id: uid, verb: 'hold' }];
    }
  });

  return out;
}

export function naiveSquad(observations: RaidObservation[], opts: SquadOpts = {}): RaidTickActions {
  const out: RaidTickActions = {};
  observations.forEach((obs, i) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const uid = u.unit_id;
    const blocked = baseBlocked(obs);
    const stats = ROSTER[u.type];

    // Trust EVERY personally-received hazard reading (real AND phantom): dodge if
    // standing on one. This wastes tempo on phantoms and — crucially — a real
    // hazard aimed at THIS member was never delivered to it, so it is never dodged.
    const ownHazards = new Set<string>();
    for (const r of obs.boss_readings) if (r.kind === 'hazard') for (const c of r.cells) ownHazards.add(key(c[0], c[1]));
    if (ownHazards.has(key(u.cell[0], u.cell[1]))) {
      const steps = safeStep(u.cell, ownHazards, blocked);
      out[obs.member_id] = steps.length ? [{ unit_id: uid, verb: 'move', steps }] : [{ unit_id: uid, verb: 'hold' }];
      return;
    }

    // Greedily attack: a phantom ADD reading lures the member into whiffing on an
    // empty cell; otherwise attack the nearest body cell / approach it.
    const phantomAdd = obs.boss_readings.find((r) => r.kind === 'add');
    if (phantomAdd && cheb(u.cell[0], u.cell[1], phantomAdd.cells[0][0], phantomAdd.cells[0][1]) <= stats.range) {
      out[obs.member_id] = [{ unit_id: uid, verb: 'attack', target: phantomAdd.cells[0] }];
      return;
    }
    const inRange = bodyInRange(u.cell, stats.range, obs.boss.footprint);
    if (inRange) {
      const picked = opts.pick?.(obs.boss.footprint, obs.tick, i);
      const shot = picked && cheb(u.cell[0], u.cell[1], picked[0], picked[1]) <= stats.range ? picked : inRange;
      out[obs.member_id] = [{ unit_id: uid, verb: 'attack', target: shot }];
      return;
    }
    const home = HOME[i] ?? HOME[HOME.length - 1];
    const steps = stepToward(u.cell, home, blocked, stats.move);
    out[obs.member_id] = steps.length ? [{ unit_id: uid, verb: 'move', steps }] : [{ unit_id: uid, verb: 'hold' }];
  });
  return out;
}

// ---------------------------------------------------------------------------
// The Overfit reference squads — same coordination cores, different targeting.
// ---------------------------------------------------------------------------

/** Sorted footprint cell by (tick + member) — spreads attacks across body cells. */
const rotatingCell = (fp: Cell[], tick: number, idx: number): Cell => {
  const sorted = [...fp].sort((a, b) => a[0] - b[0]);
  return sorted[(tick + idx) % sorted.length];
};

/**
 * A VARIED squad (beats the Overfit): the coordinated tank/revive core, but each
 * member rotates which body cell it attacks — so no member's attack-region peaks,
 * predictability stays low, and its damage penetrates the counter-table.
 */
export function diverseSquad(observations: RaidObservation[]): RaidTickActions {
  return consensusSquad(observations, { pick: rotatingCell });
}

/**
 * Five identical, maximally-predictable agents: every member hammers the SAME
 * body cell every tick and never revives — the counter-table absorbs it to
 * near-zero and the squad enrages into a wipe.
 */
export function greedySquad(observations: RaidObservation[]): RaidTickActions {
  return naiveSquad(observations, { pick: () => [4, 7] });
}

// ===========================================================================
// Phase-6 failure-mode bosses — reference coordinated (CLEAR) + naive (WIPE)
// squads (failure-modes-pillar.md §3–§5). Each reads ONLY per-member observations
// (never RaidState, never a reading's `real` flag): the golden-anchor pair proves
// the lesson is real, learnable, and fair.
// ===========================================================================

/** Board-fixed impassables (boss body ∪ obstacles ∪ corrupted rings) for standing. */
function standBlocked(obs: RaidObservation): Set<string> {
  return baseBlocked(obs);
}

/** Cells within Chebyshev 1 of `center`, standable, sorted closest-to-boss first. */
function ringCells(center: Cell, footprint: Cell[], blocked: Set<string>): Cell[] {
  const cands: Cell[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const c: Cell = [center[0] + dx, center[1] + dy];
      if (!onBoard(c[0], c[1]) || blocked.has(key(c[0], c[1]))) continue;
      cands.push(c);
    }
  }
  const dToBoss = (c: Cell): number => Math.min(...footprint.map((f) => cheb(c[0], c[1], f[0], f[1])));
  cands.sort((a, b) => dToBoss(a) - dToBoss(b) || a[0] - b[0] || a[1] - b[1]);
  return cands;
}

/** The single downed→reviver assignment (nearest living non-guard; tie → id). */
function reviverAssignment(observations: RaidObservation[]): Map<MemberId, MemberId> {
  const downed = new Set<MemberId>();
  for (const o of observations) for (const s of o.squad) if (s.downed) downed.add(s.member_id);
  const reviverFor = new Map<MemberId, MemberId>();
  const assigned = new Set<MemberId>();
  for (const d of [...downed].sort()) {
    const dCell = observations.find((o) => o.squad.some((s) => s.member_id === d))?.squad.find((s) => s.member_id === d)?.cell;
    if (!dCell) continue;
    let best: { m: MemberId; dist: number } | null = null;
    for (const o of [...observations].sort((a, b) => (a.member_id < b.member_id ? -1 : 1))) {
      if (!o.you.unit || o.you.downed || assigned.has(o.member_id) || o.you.unit.type === 'guard') continue;
      const dist = cheb(o.you.unit.cell[0], o.you.unit.cell[1], dCell[0], dCell[1]);
      if (!best || dist < best.dist) best = { m: o.member_id, dist };
    }
    if (best) {
      reviverFor.set(best.m, d);
      assigned.add(best.m);
    }
  }
  return reviverFor;
}

/** Move toward a downed ally and revive it (returns an action or null if N/A). */
function reviveMove(obs: RaidObservation, target: MemberId, blocked: Set<string>): RaidUnitAction | null {
  const u = obs.you.unit;
  if (!u) return null;
  const tCell = obs.squad.find((s) => s.member_id === target)?.cell;
  if (!tCell) return null;
  if (cheb(u.cell[0], u.cell[1], tCell[0], tCell[1]) <= 1) return { unit_id: u.unit_id, verb: 'revive', target_member: target };
  const steps = stepToward(u.cell, [tCell[0], Math.max(0, tCell[1] - 1)], blocked, ROSTER[u.type].move);
  return steps.length ? { unit_id: u.unit_id, verb: 'move', steps } : { unit_id: u.unit_id, verb: 'hold' };
}

/** Attack a boss body cell if in range, else path toward `goal`. */
function advanceAndAttack(obs: RaidObservation, goal: Cell, blocked: Set<string>): RaidUnitAction {
  const u = obs.you.unit!;
  const stats = ROSTER[u.type];
  const inRange = bodyInRange(u.cell, stats.range, obs.boss.footprint);
  if (inRange) return { unit_id: u.unit_id, verb: 'attack', target: inRange };
  const steps = stepToward(u.cell, goal, blocked, stats.move);
  return steps.length ? { unit_id: u.unit_id, verb: 'move', steps } : { unit_id: u.unit_id, verb: 'hold' };
}

// ---------------------------------------------------------------------------
// The Byzantine — bftQuorumSquad (CLEAR) / credulousSquad (WIPE) (§3.4–§3.5)
// ---------------------------------------------------------------------------

/** Tally every advisory (own + broadcasts); argmax node, ties → node order. */
function quorumNode(obs: RaidObservation): (typeof BYZANTINE_NODES)[number] {
  const advisories = obs.consensus_advisories ?? [];
  const tally = new Map<string, number>();
  for (const a of advisories) tally.set(a.claimed_anchor, (tally.get(a.claimed_anchor) ?? 0) + 1);
  let pick = BYZANTINE_NODES[0];
  let best = -1;
  for (const n of BYZANTINE_NODES) {
    const c = tally.get(n.id) ?? 0;
    if (c > best) {
      best = c;
      pick = n;
    }
  }
  return pick;
}

/**
 * The robust pattern: tally ALL advisories, ring the MAJORITY node with a quorum
 * (distrusting your own feed when outvoted), then tank + DPS + revive. All members
 * converge on the true grounded node → the shield drops → damage lands → CLEAR.
 */
export function bftQuorumSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  const reviverFor = reviverAssignment(observations);
  // Every member computes the SAME quorum node (advisories are squad-shared).
  const node = observations.map(quorumNode).find(Boolean) ?? BYZANTINE_NODES[0];
  const fixedBlocked = standBlocked(observations[0]);
  const ring = ringCells(node.cell, observations[0].boss.footprint, fixedBlocked);

  observations.forEach((obs, i) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));

    const revTarget = reviverFor.get(obs.member_id);
    if (revTarget) {
      const rv = reviveMove(obs, revTarget, new Set(blocked));
      if (rv) {
        out[obs.member_id] = [rv];
        return;
      }
    }

    // Ring the quorum node (my assigned slot) — this both grounds the boss and
    // seats me adjacent so I can DPS. If already ringing + in range, attack.
    const slot = ring[i % ring.length] ?? node.cell;
    const ringing = cheb(u.cell[0], u.cell[1], node.cell[0], node.cell[1]) <= 1;
    if (ringing) {
      out[obs.member_id] = [advanceAndAttack(obs, slot, blocked)];
      return;
    }
    const steps = stepToward(u.cell, slot, blocked, ROSTER[u.type].move);
    out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [{ unit_id: u.unit_id, verb: 'hold' }];
  });
  return out;
}

/**
 * The naive failure: trust a single feed — the LOUDEST broadcast (the faulty
 * spoof, delivered first). Every member rings the WRONG node → the true node never
 * reaches quorum → the shield never drops → mitigated to near-zero + struck → WIPE.
 */
export function credulousSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  observations.forEach((obs) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));
    const loud = obs.consensus_advisories?.[0]?.claimed_anchor;
    const node = BYZANTINE_NODES.find((n) => n.id === loud) ?? BYZANTINE_NODES[0];
    out[obs.member_id] = [advanceAndAttack(obs, node.cell, blocked)];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Deadlock — orderedLockSquad (CLEAR) / greedyGrabSquad (WIPE) (§4.4–§4.5)
// ---------------------------------------------------------------------------

/**
 * The robust pattern: a global member→rank assignment; seat ascending (a rank is
 * seated only once every lower rank is held), never stepping on a warded lock;
 * once locks 1..M are held the seal drains, and free members DPS. → CLEAR.
 */
export function orderedLockSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  const reviverFor = reviverAssignment(observations);
  const locks = [...(observations[0].locks ?? [])].sort((a, b) => a.rank - b.rank);
  const members = observations.map((o) => o.member_id).sort();
  // Lowest-id members hold ranks ascending; the rest are free DPS.
  const rankOf = new Map<MemberId, number>();
  locks.forEach((l, idx) => {
    if (members[idx] != null) rankOf.set(members[idx], l.rank);
  });

  observations.forEach((obs) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));

    const revTarget = reviverFor.get(obs.member_id);
    if (revTarget) {
      const rv = reviveMove(obs, revTarget, new Set(blocked));
      if (rv) {
        out[obs.member_id] = [rv];
        return;
      }
    }

    const myRank = rankOf.get(obs.member_id);
    if (myRank != null) {
      const myLock = locks.find((l) => l.rank === myRank)!;
      const lowerAllHeld = locks.filter((l) => l.rank < myRank).every((l) => l.held_by != null);
      const onMyLock = u.cell[0] === myLock.cell[0] && u.cell[1] === myLock.cell[1];
      if (onMyLock) {
        // Seated: hold the lock AND DPS the adjacent boss.
        out[obs.member_id] = [advanceAndAttack(obs, myLock.cell, blocked)];
        return;
      }
      if (lowerAllHeld) {
        const steps = stepToward(u.cell, myLock.cell, blocked, ROSTER[u.type].move);
        out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [{ unit_id: u.unit_id, verb: 'hold' }];
      } else {
        // Warded: wait one step south of my lock (never step on it out of order).
        const stage: Cell = [myLock.cell[0], Math.max(0, myLock.cell[1] - 1)];
        const steps = stepToward(u.cell, stage, blocked, ROSTER[u.type].move);
        out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [{ unit_id: u.unit_id, verb: 'hold' }];
      }
      return;
    }
    // Free DPS: attack the boss body from a home post.
    const goal: Cell = [4, 6];
    out[obs.member_id] = [advanceAndAttack(obs, goal, blocked)];
  });
  return out;
}

/**
 * The naive failure: everyone beelines to the single lock nearest the boss (the
 * centre = the highest rank) and thrashes. Only one seats it — out of order → a
 * ward heals the boss every tick; ranks 1..M are never held → the seal never opens
 * → the boss out-heals the chip damage → WIPE.
 */
export function greedyGrabSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  const locks = observations[0].locks ?? [];
  const fp = observations[0].boss.footprint;
  const centroidX = Math.round(fp.reduce((n, c) => n + c[0], 0) / Math.max(1, fp.length));
  // The lock nearest the boss centroid (the juiciest) — everyone converges here.
  let target = locks[0]?.cell ?? [4, 6];
  let bestD = Infinity;
  for (const l of locks) {
    const d = cheb(l.cell[0], l.cell[1], centroidX, fp[0]?.[1] ?? 7);
    if (d < bestD) {
      bestD = d;
      target = l.cell;
    }
  }
  observations.forEach((obs) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));
    const onTarget = u.cell[0] === target[0] && u.cell[1] === target[1];
    if (onTarget) {
      out[obs.member_id] = [advanceAndAttack(obs, target, blocked)];
      return;
    }
    const steps = stepToward(u.cell, target, blocked, ROSTER[u.type].move);
    // If blocked from the lock (occupied), thrash forward and chip the boss.
    if (steps.length) out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'move', steps }];
    else out[obs.member_id] = [advanceAndAttack(obs, target, blocked)];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Split-Brain — quorumPrimarySquad (CLEAR) / dualPrimarySquad (WIPE) (§5.4–§5.5)
// ---------------------------------------------------------------------------

/**
 * The robust pattern: under a partition, the majority (primary) drives the core
 * (a clean write); the minority holds read-only (chips the normal body). Outside
 * windows the whole squad DPSes the body; the guard tanks and the scout revives.
 * Every partition tick is a clean write → the core melts → CLEAR.
 */
export function quorumPrimarySquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  const reviverFor = reviverAssignment(observations);
  observations.forEach((obs) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));

    const revTarget = reviverFor.get(obs.member_id);
    if (revTarget) {
      const rv = reviveMove(obs, revTarget, new Set(blocked));
      if (rv) {
        out[obs.member_id] = [rv];
        return;
      }
    }

    // The guard ALWAYS tanks the normal body (holds threat, absorbs the strike)
    // regardless of partition — core hits build no threat, so a core-writing tank
    // would drop aggro onto a squishy. Only NON-guard primaries write the core.
    const part = obs.partition;
    const isTank = u.type === 'guard';
    if (part && part.core_cell && part.is_primary && !isTank) {
      const core = part.core_cell;
      if (cheb(u.cell[0], u.cell[1], core[0], core[1]) <= ROSTER[u.type].range) {
        out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: core }];
        return;
      }
      const steps = stepToward(u.cell, [core[0], 6], blocked, ROSTER[u.type].move);
      out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [advanceAndAttack(obs, [4, 6], blocked)];
      return;
    }
    // The tank + the minority (read-only) DPS the normal body, avoiding the core.
    const core = part?.core_cell ?? null;
    const bodyCell = bodyInRange(u.cell, ROSTER[u.type].range, obs.boss.footprint);
    if (bodyCell && !(core && bodyCell[0] === core[0] && bodyCell[1] === core[1])) {
      out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: bodyCell }];
      return;
    }
    // In range of only the core (must avoid writing it): pick another body cell.
    if (bodyCell && core) {
      const alt = obs.boss.footprint.find(
        (c) => cheb(u.cell[0], u.cell[1], c[0], c[1]) <= ROSTER[u.type].range && !(c[0] === core[0] && c[1] === core[1]),
      );
      if (alt) {
        out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: alt }];
        return;
      }
      out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'hold' }];
      return;
    }
    out[obs.member_id] = [advanceAndAttack(obs, [4, 6], blocked)];
  });
  return out;
}

/**
 * The naive failure: the exposed core is the juiciest target, so EVERYONE writes
 * it — both partitions the same tick → split-brain: the boss heals + an AoE lashes
 * both groups. The squad heals the boss and bleeds itself → WIPE.
 */
export function dualPrimarySquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  observations.forEach((obs) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));
    const core = obs.partition?.core_cell;
    if (core) {
      if (cheb(u.cell[0], u.cell[1], core[0], core[1]) <= ROSTER[u.type].range) {
        out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: core }];
        return;
      }
      const steps = stepToward(u.cell, [core[0], 6], blocked, ROSTER[u.type].move);
      out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [advanceAndAttack(obs, [4, 6], blocked)];
      return;
    }
    out[obs.member_id] = [advanceAndAttack(obs, [4, 6], blocked)];
  });
  return out;
}

// ---------------------------------------------------------------------------
// The Latency — leadingSquad (CLEAR) / staleReactSquad (WIPE) (§12 → shipped)
// ---------------------------------------------------------------------------

/** Firing posts around the stationary bar — a fixed melee/ranged ring in range of
 *  the sweeping live cell. m0 Guard centre (tanks, in range of all three columns);
 *  the lancers flank; the archer posts a rank back at range 2; the scout peels. */
const LATENCY_HOME: Cell[] = [
  [4, 6], // m0 Guard — centre, adjacent to every live column, tanks
  [3, 6], // m1 Lancer — west of centre
  [5, 6], // m2 Lancer — east of centre
  [4, 5], // m3 Archer — one rank back (range 2 reaches the whole bar)
  [2, 6], // m4 Scout — west flank / peel reviver
];

/**
 * The robust pattern: the telemetry of the exposed cell is k ticks STALE, so read
 * the deterministic telegraph (`delay.lead_cell` — where the weak point IS now) and
 * LEAD your strike there; hold when the lead cell is out of range rather than waste
 * tempo on inert plating. Post the ring, tank + revive. Every landed lead-strike
 * damages the boss → CLEAR.
 */
export function leadingSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  const reviverFor = reviverAssignment(observations);
  observations.forEach((obs, i) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));

    const revTarget = reviverFor.get(obs.member_id);
    if (revTarget) {
      const rv = reviveMove(obs, revTarget, new Set(blocked));
      if (rv) {
        out[obs.member_id] = [rv];
        return;
      }
    }

    // LEAD: fire at the telegraphed current cell (never the stale readout). If it is
    // in range, strike it; otherwise close to the home post (and hold if already
    // there — a lead cell out of reach this tick is not worth a plating whiff).
    const lead = obs.delay?.lead_cell;
    if (lead && cheb(u.cell[0], u.cell[1], lead[0], lead[1]) <= ROSTER[u.type].range) {
      out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: lead }];
      return;
    }
    const home = LATENCY_HOME[i] ?? LATENCY_HOME[LATENCY_HOME.length - 1];
    const steps = stepToward(u.cell, home, blocked, ROSTER[u.type].move);
    out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [{ unit_id: u.unit_id, verb: 'hold' }];
  });
  return out;
}

/**
 * The naive failure: trust the raw board and fire where the weak point APPEARS to
 * be — `delay.observed_cell`, k ticks stale. The exposed cell has already swept on,
 * so every strike lands on inert plating for zero damage; the boss never falls, the
 * squad never revives, and the enrage collapse finishes them → WIPE.
 */
export function staleReactSquad(observations: RaidObservation[]): RaidTickActions {
  const out: RaidTickActions = {};
  observations.forEach((obs, i) => {
    const u = obs.you.unit;
    if (!u || obs.you.downed) {
      out[obs.member_id] = [{ unit_id: u?.unit_id ?? `${obs.member_id}-x`, verb: 'hold' }];
      return;
    }
    const blocked = standBlocked(obs);
    for (const sq of obs.squad) if (sq.member_id !== obs.member_id) blocked.add(key(sq.cell[0], sq.cell[1]));

    // Chase the stale readout: strike where the weak point WAS (now inert plating).
    const stale = obs.delay?.observed_cell;
    if (stale && cheb(u.cell[0], u.cell[1], stale[0], stale[1]) <= ROSTER[u.type].range) {
      out[obs.member_id] = [{ unit_id: u.unit_id, verb: 'attack', target: stale }];
      return;
    }
    const home = LATENCY_HOME[i] ?? LATENCY_HOME[LATENCY_HOME.length - 1];
    const steps = stepToward(u.cell, home, blocked, ROSTER[u.type].move);
    out[obs.member_id] = steps.length ? [{ unit_id: u.unit_id, verb: 'move', steps }] : [{ unit_id: u.unit_id, verb: 'hold' }];
  });
  return out;
}

export type RaidSquadPolicy = (observations: RaidObservation[]) => RaidTickActions;
export type { RaidUnitAction };
