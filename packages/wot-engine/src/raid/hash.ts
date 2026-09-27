/**
 * Deterministic raid state hashing (raids-v1 §8). Extends the duel `canonicalize`
 * to the boss layer in a FIXED key order. **Phantom readings and observations are
 * excluded** — they never touch `RaidState` (they live only in the observation
 * projection, §3.2), so the state-hash chain is provably phantom-clean.
 *
 * Reuses the duel `foldHash` for the running replay chain (identical discipline).
 */

import { createHash } from 'node:crypto';
import { foldHash } from '../hash.ts';
import type { Cell } from '../types.ts';
import type { FeatureCounts, RaidState } from './types.ts';

const sortCells = (cells: Cell[]): Cell[] =>
  [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const byId = <T extends { [k: string]: unknown }>(arr: T[], key: string): T[] =>
  [...arr].sort((a, b) =>
    String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0,
  );

/** Canonical, hashable projection of `f` (keys sorted so it is order-stable). */
function canonFeatures(f: FeatureCounts): unknown {
  const sortRec = (r: Record<string | number, number>): [string, number][] =>
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]] as [string, number]);
  return { verb: sortRec(f.verb), lane: sortRec(f.lane), region: sortRec(f.region), total: f.total };
}

/**
 * Canonical serialization of the authoritative raid state (§8). Included in a
 * fixed key order: tick; boss {hp,phase,footprint}; every squad unit
 * {id,type,cell,hp,downed} sorted by id; adds sorted by id; threat sorted by
 * member; activeHazards sorted by reading_id; per-member remaining; corrupted
 * rings; anchor credits; revive channels; and the (Overfit) counter-table.
 * raid_id, obstacles (seed-fixed), and events are excluded — as are PHANTOMS.
 */
export function canonicalizeRaid(s: RaidState): string {
  const units = byId(
    s.units.map((u) => ({
      id: u.unitId,
      type: u.type,
      cell: [u.x, u.y] as Cell,
      hp: u.hp,
      downed: u.downed,
    })),
    'id',
  );
  const adds = byId(
    s.adds.map((a) => ({ id: a.addId, type: a.type, cell: [a.x, a.y] as Cell, hp: a.hp })),
    'id',
  );
  const threat = [...s.members].sort().map((m) => [m, s.threat[m] ?? 0] as [string, number]);
  const remaining = [...s.members].sort().map((m) => [m, s.remaining[m] ?? 0] as [string, number]);
  const anchorCredits = [...s.members]
    .sort()
    .map((m) => [m, s.anchorCredits[m] ?? 0] as [string, number]);
  const hazards = byId(
    s.activeHazards.map((h) => ({
      reading_id: h.readingId,
      cells: sortCells(h.cells),
      detonate_tick: h.detonateTick,
      target_member: h.targetMember ?? null,
    })),
    'reading_id',
  );
  const reviveChannels = Object.keys(s.reviveChannels)
    .sort()
    .map((k) => [k, s.reviveChannels[k].target, s.reviveChannels[k].ticks] as [string, string, number]);
  const featureCounts =
    s.bossId === 'the_overfit'
      ? [...s.members].sort().map((m) => [m, canonFeatures(s.featureCounts[m])])
      : [];

  // Deadlock canonical extension (§6): the out-of-order lock-hold age vector — the
  // channel's real, cross-tick, HASHED state. The key is present ONLY for Deadlock
  // so the shipped Hallucinator/Overfit hashes are byte-for-byte unchanged.
  // Byzantine + Split-Brain add nothing (shield/vote/partition recompute from
  // real positions, which are already hashed via `units`).
  const channelExt =
    s.bossId === 'deadlock'
      ? {
          channel: Object.keys(s.channel.lockOutOfOrderAge)
            .sort((a, b) => Number(a) - Number(b))
            .map((r) => [Number(r), s.channel.lockOutOfOrderAge[Number(r)]] as [number, number]),
        }
      : {};

  return JSON.stringify({
    tick: s.tick,
    boss: { hp: s.boss.hp, phase: s.boss.phase, footprint: sortCells(s.boss.footprint) },
    current_target: s.currentTarget,
    units,
    adds,
    threat,
    remaining,
    active_hazards: hazards,
    corrupted_rings: [...s.corruptedRings].sort((a, b) => a - b),
    anchor_credits: anchorCredits,
    revive_channels: reviveChannels,
    feature_counts: featureCounts,
    ...channelExt,
  });
}

/** `sha256:<hex>` over the canonical serialization of `state`. */
export function raidStateHash(state: RaidState): string {
  const hex = createHash('sha256').update(canonicalizeRaid(state), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

export { foldHash };
