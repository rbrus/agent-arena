/**
 * The target-facing egress projection (arena-scenarios.md §1.4; contracts
 * `eval_raid_observation.schema.json`, `$defs/member_view`).
 *
 * The internal `RaidObservation` was built for in-process reference agents and
 * spectators and carries ground truth. The egress view is built by WHITELIST
 * from scratch (the duel discipline, wot-engine `observation.ts:1-7`), never by
 * deleting fields from the internal object. Transforms:
 *
 *  L1/L2  no `real` flag on readings or advisories (not whitelisted);
 *  L3     reading ids blinded `r_<hmac12>`, add ids blinded `a_<hmac12>` (separate domain);
 *  L4     consensus advisories sorted by `from_member` (never faulty-first);
 *  L5     during a Split-Brain window every member absent from the viewer's
 *         `squad` is absent EVERYWHERE: dropped from `threat_table`, and
 *         `anchors[].held_by` / `locks[].held_by` / `boss_telegraph.target_member`
 *         are nulled when they would name one;
 *  L6     no raid id / seed: the transport supplies the opaque episode id;
 *  L7     (new, B2) readings are emitted sorted by blinded id. The internal list
 *         is ordered reals-first, phantoms-last, so list POSITION leaked truth;
 *  L8     (new, B2) hazard `detonate_tick` is clamped to `turn + 1`. Every real
 *         hazard is first visible one tick after it spawns with a 2-tick fuse
 *         (lead ≤ 1), but the phantom generator stamps `t + 2`, so the lead alone
 *         separated phantoms from reals. The clamp is the identity on every real
 *         reading (asserted by the leak test) and is applied uniformly, without
 *         reading any truth label.
 *  L9     (new, B2) reading cells are clipped to the 9×9 board and a reading
 *         left with no cell is dropped. The phantom generator computes its row
 *         as `2 + ((h >> 4) % 5)` with a SIGNED shift of a uint32 hash, so about
 *         half of all phantoms sit at y = -2..-1: off the board (a contract
 *         violation) and a perfect phantom tell. Real readings are always on the
 *         board (asserted), so the clip is the identity on them.
 *
 * `egressFromInternal` is a pure function exported for sim-qa fuzzers: two
 * internal observations that differ only in ground-truth labels, internal list
 * order, or hidden-member positions produce byte-identical egress views.
 */

import type { Cell, RaidObservation } from 'wot-engine';
import { blindAddId, blindReadingId } from './blinding.ts';

export interface EgressReading {
  reading_id: string;
  kind: 'hazard' | 'add';
  cells: Cell[];
  detonate_tick: number | null;
  corroboration: { seen_by_count: number; squad_alive: number };
}

export interface MemberView {
  member_id: string;
  you: {
    unit: { unit_id: string; type: string; cell: Cell; hp: number; max_hp: number; downed: boolean } | null;
    action_tokens_remaining: number;
    downed: boolean;
  };
  boss: { boss_id: string; hp: number; max_hp: number; phase: number; footprint: Cell[]; enrage_in_ticks: number };
  squad: {
    member_id: string;
    type: string;
    cell: Cell;
    hp: number;
    max_hp: number;
    downed: boolean;
    threat: number;
    is_boss_target: boolean;
  }[];
  threat_table: { member_id: string; threat: number; is_current_target: boolean }[];
  boss_telegraph: { pattern: string; target_member: string | null; hazard_cells: Cell[]; resolves_on_turn: number };
  boss_readings: EgressReading[];
  anchors: { id: string; cell: Cell; held_by: string | null }[];
  adds: { add_id: string; cell: Cell; hp: number }[];
  obstacles: Cell[];
  corrupted_rings: number[];
  consensus_advisories?: { from_member: string; claimed_anchor: string }[];
  locks?: { rank: number; cell: Cell; held_by: string | null }[];
  next_lock_rank?: number | null;
  partition?: {
    group: 'A' | 'B';
    group_size: number;
    is_primary: boolean;
    window_ends_on_turn: number;
    core_cell: Cell | null;
  } | null;
  delay?: { ticks_stale: number; observed_cell: Cell; lead_cell: Cell } | null;
}

export interface PeerReport {
  from_member: string;
  readings: EgressReading[];
}

/** The maximum lead (detonate_tick − turn) of any REAL hazard reading (L8). */
export const MAX_REAL_HAZARD_LEAD = 1;

const cell = (c: readonly number[]): Cell => [c[0], c[1]];
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const onBoard = (c: readonly number[]): boolean => c[0] >= 0 && c[0] <= 8 && c[1] >= 0 && c[1] <= 8;

/**
 * L9 clip, the one definition shared by the egress and the oracles (B2c): the
 * reading with its cells clipped to the 9×9 board, or null when no cell is left
 * (the reading is dropped and the target never receives it). Internal id kept.
 */
export function clipReadingToBoard<R extends { cells: readonly (readonly number[])[] }>(r: R): (Omit<R, 'cells'> & { cells: Cell[] }) | null {
  const cells = r.cells.filter(onBoard).map(cell);
  return cells.length ? { ...r, cells } : null;
}

/** Blind + whitelist a reading list; sorted by blinded id (L7). Pure. */
export function egressReadings(
  readings: RaidObservation['boss_readings'],
  turn: number,
  blindingKey: string,
): EgressReading[] {
  const out = readings.flatMap((raw) => {
    const r = clipReadingToBoard(raw);
    return r ? [r] : [];
  }).map((r) => ({
    reading_id: blindReadingId(blindingKey, r.reading_id),
    kind: r.kind,
    cells: r.cells,
    detonate_tick:
      r.detonate_tick == null
        ? null
        : r.kind === 'hazard'
          ? Math.min(r.detonate_tick, turn + MAX_REAL_HAZARD_LEAD)
          : r.detonate_tick,
    corroboration: { seen_by_count: r.corroboration.seen_by_count, squad_alive: r.corroboration.squad_alive },
  }));
  out.sort((a, b) => cmp(a.reading_id, b.reading_id) || cmp(JSON.stringify(a), JSON.stringify(b)));
  return out;
}

/**
 * The egress member view for `seat` from its internal observation. Pure; never
 * mutates or aliases the input.
 */
export function egressFromInternal(obs: RaidObservation, seat: string, blindingKey: string): MemberView {
  if (obs.member_id !== seat) throw new Error(`egress: observation is for ${obs.member_id}, not ${seat}`);
  const turn = obs.tick;

  // L5: inside a Split-Brain window the viewer may name only itself and the
  // members its own `squad` shows. Outside a window nothing is hidden.
  const inWindow = obs.partition != null;
  const visible = new Set<string>([seat, ...obs.squad.map((s) => s.member_id)]);
  const shown = (m: string | null | undefined): string | null =>
    m == null ? null : !inWindow || visible.has(m) ? m : null;

  const you = obs.you.unit;
  const view: MemberView = {
    member_id: seat,
    you: {
      unit: you
        ? { unit_id: you.unit_id, type: you.type, cell: cell(you.cell), hp: you.hp, max_hp: you.max_hp, downed: you.downed }
        : null,
      action_tokens_remaining: obs.you.action_tokens_remaining,
      downed: obs.you.downed,
    },
    boss: {
      boss_id: obs.boss.boss_id,
      hp: obs.boss.hp,
      max_hp: obs.boss.max_hp,
      phase: obs.boss.phase,
      footprint: obs.boss.footprint.map(cell),
      enrage_in_ticks: obs.boss.enrage_in_ticks,
    },
    squad: [...obs.squad]
      .sort((a, b) => cmp(a.member_id, b.member_id))
      .map((s) => ({
        member_id: s.member_id,
        type: s.type,
        cell: cell(s.cell),
        hp: s.hp,
        max_hp: s.max_hp,
        downed: s.downed,
        threat: s.threat,
        is_boss_target: s.is_boss_target,
      })),
    threat_table: obs.threat_table
      .filter((r) => !inWindow || visible.has(r.member_id))
      .sort((a, b) => cmp(a.member_id, b.member_id))
      .map((r) => ({ member_id: r.member_id, threat: r.threat, is_current_target: r.is_current_target })),
    boss_telegraph: {
      pattern: obs.boss_telegraph.pattern,
      target_member: shown(obs.boss_telegraph.target_member),
      hazard_cells: obs.boss_telegraph.hazard_cells.map(cell),
      resolves_on_turn: obs.boss_telegraph.resolves_on_turn,
    },
    boss_readings: egressReadings(obs.boss_readings, turn, blindingKey),
    anchors: obs.anchors.map((a) => ({ id: a.id, cell: cell(a.cell), held_by: shown(a.held_by) })),
    adds: obs.adds
      .map((a) => ({ add_id: blindAddId(blindingKey, a.add_id), cell: cell(a.cell), hp: a.hp }))
      .sort((a, b) => cmp(a.add_id, b.add_id)),
    obstacles: obs.obstacles.map(cell),
    corrupted_rings: [...obs.corrupted_rings].sort((a, b) => a - b),
  };

  if (obs.consensus_advisories !== undefined) {
    // L2 (no truth flag) + L4 (canonical member order, never faulty-first).
    view.consensus_advisories = obs.consensus_advisories
      .map((a) => ({ from_member: a.from_member, claimed_anchor: a.claimed_anchor }))
      .sort((a, b) => cmp(a.from_member, b.from_member) || cmp(a.claimed_anchor, b.claimed_anchor));
  }
  if (obs.locks !== undefined) {
    view.locks = obs.locks
      .map((l) => ({ rank: l.rank, cell: cell(l.cell), held_by: shown(l.held_by) }))
      .sort((a, b) => a.rank - b.rank);
  }
  if (obs.next_lock_rank !== undefined) view.next_lock_rank = obs.next_lock_rank;
  if (obs.partition !== undefined) {
    const p = obs.partition;
    view.partition = p
      ? {
          group: p.group,
          group_size: p.group_size,
          is_primary: p.is_primary,
          window_ends_on_turn: p.window_ends_on_turn,
          core_cell: p.core_cell ? cell(p.core_cell) : null,
        }
      : null;
  }
  if (obs.delay !== undefined) {
    const d = obs.delay;
    view.delay = d ? { ticks_stale: d.ticks_stale, observed_cell: cell(d.observed_cell), lead_cell: cell(d.lead_cell) } : null;
  }
  return view;
}

/**
 * Member-mode `peer_reports` (The Hallucinator, §2.2): the other ALIVE members'
 * readings, relayed honestly and blinded the same way. Victim blindness means a
 * single-seat target cannot see a hazard aimed at it without this block; it
 * gives the target exactly what the coordinated reference pools. Projection
 * only; out of the hash.
 */
export function peerReports(internals: readonly RaidObservation[], seat: string, blindingKey: string): PeerReport[] {
  return internals
    .filter((o) => o.member_id !== seat && o.you.unit != null && !o.you.downed)
    .sort((a, b) => cmp(a.member_id, b.member_id))
    .map((o) => ({ from_member: o.member_id, readings: egressReadings(o.boss_readings, o.tick, blindingKey) }));
}
