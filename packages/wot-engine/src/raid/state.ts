/**
 * Initial raid-state construction + deep clone. Pure: given (seed, squad spec,
 * boss) the board, obstacles, boss body, and squad spawns are fully determined.
 */

import { ROSTER } from '../constants.ts';
import { deterministicMatchId } from '../state.ts';
import type { Cell } from '../types.ts';
import {
  BOSS_FOOTPRINT,
  RAID_CONFIGS,
  SQUAD_SPAWNS,
  referenceSquadSpec,
} from './constants.ts';
import type {
  BossId,
  FeatureCounts,
  RaidConfig,
  RaidState,
  RaidUnit,
  SquadSpec,
} from './types.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic placeholder raid_id (`rad_` + 26 Crockford chars) for standalone use. */
export function deterministicRaidId(seed: number, bossId: BossId): string {
  let n = ((seed >>> 0) ^ (bossId === 'the_overfit' ? 0x9e3779b9 : 0)) >>> 0 || 1;
  let s = '';
  for (let i = 0; i < 26; i++) {
    s += CROCKFORD[n % 32];
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
  }
  return `rad_${s}`;
}

function emptyFeatureCounts(): FeatureCounts {
  return { verb: {}, lane: {}, region: {}, total: 0 };
}

export interface CreateRaidStateOptions {
  raidId?: string;
  config?: Partial<RaidConfig>;
}

/** Build the tick-0 authoritative raid state. */
export function createInitialRaidState(
  seed: number,
  bossId: BossId,
  spec: SquadSpec = referenceSquadSpec(),
  opts: CreateRaidStateOptions = {},
): RaidState {
  const config: RaidConfig = { ...RAID_CONFIGS[bossId], ...(opts.config ?? {}) };
  // Raids run on an OPEN board: the boss owns the north, the squad the south, and
  // the encounter's depth is the corroboration/threat/revive systems — not seeded
  // terrain (which would only wall off firing lanes around the fixed boss body).
  // `seed` still drives the boss script + phantom projection deterministically.
  const obstacles: Cell[] = [];

  const members: string[] = [];
  const units: RaidUnit[] = [];
  const threat: Record<string, number> = {};
  const remaining: Record<string, number> = {};
  const spent: Record<string, number> = {};
  const anchorCredits: Record<string, number> = {};
  const featureCounts: Record<string, FeatureCounts> = {};
  const contribution: RaidState['contribution'] = {};

  spec.members.forEach((m, i) => {
    const spawn: Cell = SQUAD_SPAWNS[i] ?? SQUAD_SPAWNS[SQUAD_SPAWNS.length - 1];
    members.push(m.memberId);
    units.push({
      memberId: m.memberId,
      unitId: `${m.memberId}-${m.type}`,
      type: m.type,
      x: spawn[0],
      y: spawn[1],
      hp: ROSTER[m.type].hp,
      downed: false,
      downedSince: null,
      forfeited: false,
    });
    threat[m.memberId] = 0;
    remaining[m.memberId] = config.allowance;
    spent[m.memberId] = 0;
    anchorCredits[m.memberId] = 0;
    featureCounts[m.memberId] = emptyFeatureCounts();
    contribution[m.memberId] = { dmg: 0, revives: 0, ticksAlive: 0, downs: 0 };
  });

  return {
    raidId: opts.raidId ?? deterministicRaidId(seed, bossId),
    seed,
    bossId,
    tick: 0,
    obstacles,
    boss: {
      bossId,
      hp: config.bossHp,
      maxHp: config.bossHp,
      phase: 0,
      footprint: BOSS_FOOTPRINT.map((c) => [c[0], c[1]] as Cell),
    },
    members,
    units,
    adds: [],
    threat,
    currentTarget: null,
    remaining,
    spent,
    activeHazards: [],
    corruptedRings: [],
    anchorCredits,
    reviveChannels: {},
    featureCounts,
    contribution,
    channel: { lockOutOfOrderAge: {} },
    config,
    events: [],
  };
}

function cloneFeatureCounts(f: FeatureCounts): FeatureCounts {
  return {
    verb: { ...f.verb },
    lane: { ...f.lane },
    region: { ...f.region },
    total: f.total,
  };
}

/** Deep clone of the mutable parts of a raid state (obstacles/config are shared). */
export function cloneRaidState(s: RaidState): RaidState {
  const featureCounts: Record<string, FeatureCounts> = {};
  for (const m of s.members) featureCounts[m] = cloneFeatureCounts(s.featureCounts[m]);
  const contribution: RaidState['contribution'] = {};
  for (const m of s.members) contribution[m] = { ...s.contribution[m] };
  const reviveChannels: Record<string, RaidState['reviveChannels'][string]> = {};
  for (const [k, v] of Object.entries(s.reviveChannels)) reviveChannels[k] = { ...v };
  return {
    raidId: s.raidId,
    seed: s.seed,
    bossId: s.bossId,
    tick: s.tick,
    obstacles: s.obstacles,
    boss: { ...s.boss, footprint: s.boss.footprint.map((c) => [c[0], c[1]] as Cell) },
    members: s.members,
    units: s.units.map((u) => ({ ...u })),
    adds: s.adds.map((a) => ({ ...a })),
    threat: { ...s.threat },
    currentTarget: s.currentTarget,
    remaining: { ...s.remaining },
    spent: { ...s.spent },
    activeHazards: s.activeHazards.map((h) => ({
      readingId: h.readingId,
      cells: h.cells.map((c) => [c[0], c[1]] as Cell),
      detonateTick: h.detonateTick,
      ...(h.targetMember != null ? { targetMember: h.targetMember } : {}),
    })),
    corruptedRings: [...s.corruptedRings],
    anchorCredits: { ...s.anchorCredits },
    reviveChannels,
    featureCounts,
    contribution,
    channel: { lockOutOfOrderAge: { ...s.channel.lockOutOfOrderAge } },
    config: s.config,
    events: [],
  };
}

export { deterministicMatchId };
