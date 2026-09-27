/**
 * `buildRaidObservation` — the raid fog + corroboration projection (raids-v1 §6.1).
 * Built by WHITELIST PROJECTION from scratch (same discipline as the duel).
 *
 * The Hallucinator's PHANTOM readings are generated HERE, purely from
 * `(seed, tick, member, phantomSalt)`, and are NEVER written to `RaidState` — so
 * the state hash is provably phantom-clean (§3.2). Real readings mirror the
 * hashed `activeHazards`/`adds`. Every reading carries `corroboration`
 * {seen_by_count, squad_alive}; the one-line discriminator is
 * `seen_by_count ≥ ceil(2/3·squad_alive)`.
 *
 * `real` on a reading is GROUND TRUTH for the arena/spectator relay and tests —
 * agents must reason from corroboration alone (the reference agents never read it).
 */

import { cheb } from '../board.ts';
import { hash32 } from '../rng.ts';
import { ROSTER } from '../constants.ts';
import type { Cell, UnitType } from '../types.ts';
import { ANCHORS, realMin } from './constants.ts';
import { bossModule, bossPolicy } from './bosses/index.ts';
import type { ObservationProjection } from './bosses/registry.ts';
import type { BossAction, MemberId, RaidState } from './types.ts';
import { aliveMembers, deliveredSubset, unitOf } from './util.ts';

export interface RaidReading {
  reading_id: string;
  kind: 'hazard' | 'add';
  cells: Cell[];
  detonate_tick: number | null;
  corroboration: { seen_by_count: number; squad_alive: number };
  /** GROUND TRUTH (spectator/replay/tests only). Agents must not depend on it. */
  real: boolean;
}

export interface RaidSquadView {
  member_id: MemberId;
  type: UnitType;
  cell: Cell;
  hp: number;
  max_hp: number;
  downed: boolean;
  threat: number;
  is_boss_target: boolean;
}

export interface RaidObservation {
  raid_id: string;
  boss_id: RaidState['bossId'];
  tick: number;
  member_id: MemberId;
  you: {
    member_id: MemberId;
    unit: { unit_id: string; type: UnitType; cell: Cell; hp: number; max_hp: number; downed: boolean } | null;
    action_tokens_remaining: number;
    downed: boolean;
  };
  boss: { boss_id: RaidState['bossId']; hp: number; max_hp: number; phase: number; footprint: Cell[]; enrage_in_ticks: number };
  squad: RaidSquadView[];
  threat_table: { member_id: MemberId; threat: number; is_current_target: boolean }[];
  boss_telegraph: { pattern: string; target_member: MemberId | null; hazard_cells: Cell[]; resolves_on_turn: number };
  boss_readings: RaidReading[];
  anchors: { id: string; cell: Cell; held_by: MemberId | null }[];
  adds: { add_id: string; cell: Cell; hp: number }[];
  /** Public board hazards to route around: obstacles ∪ currently-corrupted rings. */
  obstacles: Cell[];
  corrupted_rings: number[];
  // ---- Phase-6 per-boss projection blocks (present only when the boss declares
  // the channel; all whitelist-projected, OUT of the state hash — §2.2/§10). ----
  /** Byzantine: consensus advisories (own + broadcasts; faulty spoof first). */
  consensus_advisories?: { from_member: MemberId; claimed_anchor: string; real: boolean }[];
  /** Deadlock: the ranked lock structure with holders. */
  locks?: { rank: number; cell: Cell; held_by: MemberId | null }[];
  /** Deadlock: the next rank to acquire in order (null when all held). */
  next_lock_rank?: number | null;
  /** Split-Brain: this member's partition banner during a window (null otherwise). */
  partition?: {
    group: 'A' | 'B';
    group_size: number;
    is_primary: boolean;
    window_ends_on_turn: number;
    core_cell: Cell | null;
  } | null;
  /** The Latency: the STALE exposed-cell readout + the telegraphed current cell. */
  delay?: {
    ticks_stale: number;
    observed_cell: Cell;
    lead_cell: Cell;
  } | null;
}

export interface BuildRaidObservationOptions {
  /** Changes the phantom projection ONLY (never state). Default 0. */
  phantomSalt?: number;
}

/** The full set of readings addressed to a member (real, from state; + phantoms). */
export function readingsFor(
  state: RaidState,
  memberId: MemberId,
  phantomSalt = 0,
): RaidReading[] {
  const t = state.tick;
  const alive = aliveMembers(state).map((u) => u.memberId);
  const squadAlive = alive.length;
  if (squadAlive === 0) return [];
  const rmin = realMin(squadAlive);
  const out: RaidReading[] = [];

  // ---- REAL readings: mirror the hashed activeHazards + adds (super-majority) ----
  const realCount = Math.max(rmin, squadAlive - 1); // ≥ rmin, but ≥1 member misses it
  for (const hz of state.activeHazards) {
    // The boss warns the super-majority but NOT the victim (§3.2): a targeted
    // hazard's subset is every alive member EXCEPT the target, so a squad that
    // pools corroboration warns the victim while a trust-my-own-eyes victim is blind.
    const pool = hz.targetMember ? alive.filter((m) => m !== hz.targetMember) : alive;
    const subset =
      hz.targetMember != null
        ? pool.slice(0, Math.max(rmin, pool.length))
        : deliveredSubset(state.seed, t, hz.readingId, alive, realCount);
    if (subset.includes(memberId)) {
      out.push({
        reading_id: hz.readingId,
        kind: 'hazard',
        cells: hz.cells.map((c) => [c[0], c[1]] as Cell),
        detonate_tick: hz.detonateTick,
        corroboration: { seen_by_count: subset.length, squad_alive: squadAlive },
        real: true,
      });
    }
  }
  for (const a of state.adds) {
    const rid = `add_r_${a.addId}`;
    const subset = deliveredSubset(state.seed, t, rid, alive, realCount);
    if (subset.includes(memberId)) {
      out.push({
        reading_id: rid,
        kind: 'add',
        cells: [[a.x, a.y]],
        detonate_tick: null,
        corroboration: { seen_by_count: subset.length, squad_alive: squadAlive },
        real: true,
      });
    }
  }

  // ---- PHANTOM readings (Hallucinator only): observation-layer, never in state ----
  if (state.bossId === 'the_hallucinator' && rmin >= 1) {
    const phase = state.boss.phase;
    const nPhantom = phase <= 0 ? 1 : 2;
    for (let i = 0; i < nPhantom; i++) {
      const rid = `ph_${t}_${i}_${phantomSalt}`;
      const h = hash32(`${state.seed}:${t}:${rid}`);
      // Ordinary phantom minority: clearly below rmin.
      const span = Math.max(1, rmin - 2);
      const count = Math.min(rmin - 1, 1 + (h % span));
      const subset = deliveredSubset(state.seed, t, rid, alive, count);
      if (subset.length > 0 && subset.includes(memberId)) {
        const kind = h % 2 === 0 ? 'hazard' : 'add';
        const cx = h % 9;
        const cy = 2 + ((h >> 4) % 5);
        out.push({
          reading_id: rid,
          kind,
          cells: [[cx, cy]],
          detonate_tick: kind === 'hazard' ? t + 2 : null,
          corroboration: { seen_by_count: subset.length, squad_alive: squadAlive },
          real: false,
        });
      }
    }
    // P3 "bait" phantom planted at EXACTLY REAL_MIN−1 (a lazy ≥half filter eats it).
    if (phase >= 2 && rmin - 1 >= 1) {
      const rid = `bait_${t}_${phantomSalt}`;
      const subset = deliveredSubset(state.seed, t, rid, alive, rmin - 1);
      if (subset.includes(memberId)) {
        const h = hash32(`${state.seed}:${t}:${rid}`);
        out.push({
          reading_id: rid,
          kind: 'hazard',
          cells: [[h % 9, 2 + ((h >> 4) % 5)]],
          detonate_tick: t + 2,
          corroboration: { seen_by_count: subset.length, squad_alive: squadAlive },
          real: false,
        });
      }
    }
  }

  return out;
}

/** Build one member's raid observation (internal engine shape). */
export function buildRaidObservation(
  state: RaidState,
  memberId: MemberId,
  opts: BuildRaidObservationOptions = {},
): RaidObservation {
  const salt = opts.phantomSalt ?? 0;
  const you = unitOf(state, memberId);
  const enrageIn = Math.max(0, state.config.enrageTick - state.tick);

  // The boss's PROJECTION hook (§2.3): per-member observation overlay generated
  // purely from (seed, phase, member, salt) — belief-only, never state, never hashed.
  const mod = bossModule(state.bossId);
  const projection: ObservationProjection | null = mod.projectObservation
    ? mod.projectObservation(state, memberId, salt)
    : null;
  const hidden = new Set(projection?.hiddenMembers ?? []);

  const squad: RaidSquadView[] = [...state.units]
    .filter((u) => !hidden.has(u.memberId)) // Split-Brain: cross-group positions absent
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1))
    .map((u) => ({
      member_id: u.memberId,
      type: u.type,
      cell: [u.x, u.y] as Cell,
      hp: u.hp,
      max_hp: ROSTER[u.type].hp,
      downed: u.downed,
      threat: state.threat[u.memberId] ?? 0,
      is_boss_target: state.currentTarget === u.memberId,
    }));

  const threatTable = [...state.members]
    .sort()
    .map((m) => ({ member_id: m, threat: state.threat[m] ?? 0, is_current_target: state.currentTarget === m }));

  // Telegraph = bossPolicy(this state) — the action that will execute next tick.
  const nextAction: BossAction = bossPolicy(state);
  const telegraphCells: Cell[] = nextAction.hazards.flatMap((h) => h.cells.map((c) => [c[0], c[1]] as Cell));
  const telegraph = {
    pattern: nextAction.hazards.length > 0 ? 'hazard' : nextAction.strikeTarget ? 'strike' : 'hold',
    target_member: nextAction.strikeTarget,
    hazard_cells: telegraphCells,
    resolves_on_turn: state.tick,
  };

  // Fog: adds visible within this member's vision (per-member fog preserved).
  const vis = you && !you.downed ? ROSTER[you.type].vision : 0;
  const adds = you
    ? state.adds
        .filter((a) => cheb(you.x, you.y, a.x, a.y) <= vis)
        .map((a) => ({ add_id: a.addId, cell: [a.x, a.y] as Cell, hp: a.hp }))
    : [];

  const anchors = ANCHORS.map((a) => {
    const occ = state.units.find((u) => !u.downed && u.x === a.cell[0] && u.y === a.cell[1]);
    return { id: a.id, cell: a.cell, held_by: occ ? occ.memberId : null };
  });

  return {
    raid_id: state.raidId,
    boss_id: state.bossId,
    tick: state.tick,
    member_id: memberId,
    you: {
      member_id: memberId,
      unit: you
        ? { unit_id: you.unitId, type: you.type, cell: [you.x, you.y], hp: you.hp, max_hp: ROSTER[you.type].hp, downed: you.downed }
        : null,
      action_tokens_remaining: state.remaining[memberId] ?? 0,
      downed: you ? you.downed : true,
    },
    boss: {
      boss_id: state.bossId,
      hp: Math.max(0, state.boss.hp),
      max_hp: state.boss.maxHp,
      phase: state.boss.phase,
      footprint: state.boss.footprint.map((c) => [c[0], c[1]] as Cell),
      enrage_in_ticks: enrageIn,
    },
    squad,
    threat_table: threatTable,
    boss_telegraph: telegraph,
    boss_readings: readingsFor(state, memberId, salt),
    anchors,
    adds,
    obstacles: state.obstacles.map((c) => [c[0], c[1]] as Cell),
    corrupted_rings: [...state.corruptedRings].sort((a, b) => a - b),
    ...(projection?.consensusAdvisories ? { consensus_advisories: projection.consensusAdvisories } : {}),
    ...(projection?.locks ? { locks: projection.locks } : {}),
    ...(projection && 'nextLockRank' in projection ? { next_lock_rank: projection.nextLockRank ?? null } : {}),
    ...(projection && 'partition' in projection ? { partition: projection.partition ?? null } : {}),
    ...(projection && 'delay' in projection ? { delay: projection.delay ?? null } : {}),
  };
}
