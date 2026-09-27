/**
 * The scripted heuristic engine.
 *
 * One deterministic policy body with a small set of capability flags. Turning
 * flags on raises the skill from "reflex-ish" to "reads the board" — the ceiling
 * behaviours listed in grid-tactics-v1 §13 (fog memory, RPS positioning,
 * predictive fire, token efficiency), all as plain scripted rules. NO model,
 * NO randomness, NO LLM call (Pillar 9 / ADDENDUM-001). The `hunter` bot is the
 * full-capability configuration; the `house-bot` maps a difficulty tier onto a
 * flag set (the difficulty dial is heuristic quality, never a model).
 */
import type { Observation } from 'wot-contracts';
import {
  attack,
  attacksOf,
  beats,
  buildAction,
  cheb,
  eq,
  keyOf,
  manh,
  moveAway,
  moveToward,
  OBJECTIVES,
  onBoard,
  reachableOf,
  UNIT_STATS,
  type Cell,
  type Policy,
  type UnitAction,
  type UnitType,
} from './grid.ts';

export interface HeuristicConfig {
  /** RPS-aware target/threat selection: hunt favourable matchups, avoid bad trades. */
  rps: boolean;
  /** Remember last-seen enemy positions across ticks (the server keeps none). */
  memory: boolean;
  /** Fire at the cell an enemy will likely step into (§4.1, §5.4). */
  predictiveFire: boolean;
  /** Role-based objective spread (guard anchors the Nexus) instead of clumping. */
  roles: boolean;
  /** Max move-step length used for tempo (1 = frugal, 2 = fast units sprint). */
  maxSteps: number;
}

export type Difficulty = 'bronze' | 'silver' | 'gold';
export const DIFFICULTY: Record<Difficulty, HeuristicConfig> = {
  bronze: { rps: false, memory: false, predictiveFire: false, roles: false, maxSteps: 1 },
  silver: { rps: true, memory: false, predictiveFire: false, roles: true, maxSteps: 1 },
  gold: { rps: true, memory: true, predictiveFire: true, roles: true, maxSteps: 2 },
};

interface Foe {
  id: string;
  type: UnitType;
  hp: number;
  cell: Cell;
  fresh: boolean; // seen this tick (vs recalled from memory)
}
interface MyUnit {
  unit_id: string;
  type: UnitType;
  cell: Cell;
  hp: number;
}

/** Enemy positions remembered across ticks — the fog memory the server won't keep. */
type Memory = Map<string, { type: UnitType; hp: number; cell: Cell; tick: number }>;

const MEMORY_TTL = 6; // ticks before a stale sighting is forgotten

function updateMemory(mem: Memory, obs: Observation): void {
  for (const e of obs.enemy_visible) {
    mem.set(e.unit_id, { type: e.type as UnitType, hp: e.hp, cell: e.cell as Cell, tick: obs.turn_id });
  }
  const visible = (obs.visible_cells ?? []) as Cell[];
  for (const [id, m] of mem) {
    // Forget: too old, or we can now see its last cell and it isn't there.
    const stale = obs.turn_id - m.tick > MEMORY_TTL;
    const vacated = m.tick < obs.turn_id && visible.some((c) => eq(c, m.cell));
    if (stale || vacated) mem.delete(id);
  }
}

/** Score a candidate attack on the enemy standing at `tc`; higher is better. */
function scoreAttack(me: MyUnit, tc: Cell, foe: Foe | undefined, cfg: HeuristicConfig): number {
  if (!cfg.rps) return 1; // bronze: any in-range target is fine
  if (!foe) return 0.5; // in range but no known occupant — weakly worth a poke
  const stat = UNIT_STATS[me.type];
  let s = 10 - foe.hp; // finish wounded things first
  if (beats(me.type, foe.type)) s += 8;
  if (beats(foe.type, me.type)) s -= 6;
  if (foe.type === 'archer' || foe.type === 'scout') s += 3; // soft, high-value
  // Guard's melee counter (§2): never trade a melee hit into a Guard unless it kills.
  if (foe.type === 'guard' && stat.range <= 1 && cheb(me.cell, tc) <= 1) {
    s += stat.damage >= foe.hp ? 5 : -12;
  }
  return s;
}

function chooseAttack(me: MyUnit, obs: Observation, byCell: Map<string, Foe>, cfg: HeuristicConfig): Cell | null {
  let best: Cell | null = null;
  let bestScore = cfg.rps ? 0 : -Infinity; // rps requires a positive (non-losing) trade
  for (const tc of attacksOf(obs, me.unit_id)) {
    const s = scoreAttack(me, tc, byCell.get(keyOf(tc)), cfg);
    if (s > bestScore) {
      bestScore = s;
      best = tc;
    }
  }
  return best;
}

/** Bet on where a soft/beatable foe will step: a cell in my range it can reach. */
function predictiveTarget(me: MyUnit, foes: Foe[]): Cell | null {
  const stat = UNIT_STATS[me.type];
  for (const f of foes) {
    if (!(beats(me.type, f.type) || f.type === 'archer' || f.type === 'scout')) continue;
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let dx = -stat.range; dx <= stat.range; dx++) {
      for (let dy = -stat.range; dy <= stat.range; dy++) {
        const c: Cell = [me.cell[0] + dx, me.cell[1] + dy];
        if (!onBoard(c) || cheb(me.cell, c) > stat.range) continue;
        const d = cheb(f.cell, c);
        if (d === 0 || d > UNIT_STATS[f.type].speed) continue; // must be a *step away* it can reach
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function nearest<T extends { cell: Cell }>(from: Cell, xs: T[]): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const x of xs) {
    const d = cheb(from, x.cell);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

/** Role-based objective target — spreads the squad instead of clumping. */
function objectiveTarget(me: MyUnit, obs: Observation, cfg: HeuristicConfig, myId: 'A' | 'B'): Cell {
  if (!cfg.roles) {
    // Greedy nearest objective (weak: the whole squad piles onto one cell).
    return (nearest(me.cell, OBJECTIVES.map((o) => ({ cell: o.cell }))) ?? { cell: OBJECTIVES[0].cell }).cell;
  }
  const relays = OBJECTIVES.filter((o) => o.id !== 'nexus');
  switch (me.type) {
    case 'guard':
      return OBJECTIVES[0].cell; // anchor the +2 Nexus
    case 'archer':
    case 'lancer':
      return (nearest(me.cell, relays.map((o) => ({ cell: o.cell }))) ?? relays[0]).cell;
    case 'scout':
    default: {
      // Grab / contest the nearest objective we don't already control.
      const open = obs.objectives.filter((o) => o.controller !== myId);
      const pick = nearest(me.cell, (open.length ? open : obs.objectives).map((o) => ({ cell: o.cell as Cell })));
      return (pick ?? { cell: OBJECTIVES[0].cell }).cell;
    }
  }
}

function decideUnit(
  me: MyUnit,
  obs: Observation,
  cfg: HeuristicConfig,
  foes: Foe[],
  byCell: Map<string, Foe>,
  myId: 'A' | 'B',
  budget: number,
): UnitAction | null {
  const stat = UNIT_STATS[me.type];

  // 1. Direct attack on a visible in-range enemy (RPS-weighted).
  if (budget >= 2) {
    const tc = chooseAttack(me, obs, byCell, cfg);
    if (tc) return attack(me.unit_id, tc);
  }

  // 2. Predictive fire: flush a soft/beatable foe out of the fog into a kill-cell.
  if (cfg.predictiveFire && budget >= 2) {
    const tc = predictiveTarget(me, foes);
    if (tc) return attack(me.unit_id, tc);
  }

  if (cfg.rps && budget >= 1) {
    // 3. Kite: fragile pieces back off from a unit that counters them.
    if (me.type === 'archer' || me.type === 'scout') {
      const threat = nearest(
        me.cell,
        foes.filter((f) => beats(f.type, me.type) && cheb(me.cell, f.cell) <= UNIT_STATS[f.type].speed + UNIT_STATS[f.type].range + 1),
      );
      if (threat) {
        const safeObj = objectiveTarget(me, obs, cfg, myId);
        const away = moveAway(obs, me.unit_id, me.cell, threat.cell, safeObj);
        if (away) return away;
      }
    }
    // 4. Hunt: chase a favourable matchup to force the trade we win.
    const prey = nearest(me.cell, foes.filter((f) => beats(me.type, f.type)));
    if (prey && cheb(me.cell, prey.cell) <= stat.vision + stat.speed * 3) {
      const mv = moveToward(obs, me.unit_id, me.cell, prey.cell, cfg.maxSteps);
      if (mv) return mv;
    }
  }

  // 5. Objective control. Sitting on an objective scores — hold rather than
  //    spend a token walking off it (token efficiency).
  const target = objectiveTarget(me, obs, cfg, myId);
  if (eq(me.cell, target)) return null;
  if (budget >= 1) {
    const mv = moveToward(obs, me.unit_id, me.cell, target, cfg.maxSteps);
    if (mv) return mv;
  }
  return null; // hold
}

/**
 * Build a scripted policy for the given capability set. The returned closure
 * carries the fog memory (used only when `cfg.memory`), so create ONE per match.
 */
export function createHeuristicPolicy(cfg: HeuristicConfig): Policy {
  const mem: Memory = new Map();
  return (obs: Observation) => {
    if (cfg.memory) updateMemory(mem, obs);
    const myId = obs.you.player_id;

    const byCell = new Map<string, Foe>();
    const foes: Foe[] = [];
    for (const e of obs.enemy_visible) {
      const f: Foe = { id: e.unit_id, type: e.type as UnitType, hp: e.hp, cell: e.cell as Cell, fresh: true };
      foes.push(f);
      byCell.set(keyOf(f.cell), f);
    }
    if (cfg.memory) {
      const seen = new Set(obs.enemy_visible.map((e) => e.unit_id));
      for (const [id, m] of mem) {
        if (!seen.has(id)) foes.push({ id, type: m.type, hp: m.hp, cell: m.cell, fresh: false });
      }
    }

    const units: MyUnit[] = obs.you.units.map((u) => ({ unit_id: u.unit_id, type: u.type as UnitType, cell: u.cell as Cell, hp: u.hp }));
    // Act with the most decisive pieces first so the shared token budget is spent well.
    const order = [...units].sort((a, b) => UNIT_STATS[b.type].damage - UNIT_STATS[a.type].damage);

    const acts: UnitAction[] = [];
    let budget = obs.you.action_tokens_remaining;
    for (const u of order) {
      const a = decideUnit(u, obs, cfg, foes, byCell, myId, budget);
      if (!a) continue;
      acts.push(a);
      budget -= a.verb === 'attack' ? 2 : a.verb === 'move' ? a.steps.length : 0;
    }
    return buildAction(obs, acts);
  };
}
