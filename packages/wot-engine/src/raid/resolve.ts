/**
 * `resolveRaidTick` — the pure, simultaneous-resolution raid tick (raids-v1 §2.7).
 * Extends the duel `resolve.ts` pipeline to the squad-vs-boss ruleset. Stages:
 *   1 validate & charge (per member; + revive/ping)   2 snapshot HP
 *   3 boss action (pure, from start-of-tick state)     4 movement (+ boss body)
 *   5 combat (squad attacks, boss strike, hazard detonations, add melee)
 *   6 deaths → downed conversion                        7 revive resolution
 *   8 threat update                                     9 anchor tally
 *   10 enrage / fog collapse                            11 phase transition
 *   12 close (state hash; clear/wipe/enrage evaluation)
 *
 * No wall-clock, no randomness beyond the seed, no I/O. Integer math throughout.
 * PHANTOMS are never touched here — they live only in the observation layer.
 */

import { cellsInRing, cheb, DIR_DELTA, key, onBoard, ring } from '../board.ts';
import { ROSTER } from '../constants.ts';
import type { Cell, EngineEvent } from '../types.ts';
import { ANCHORS } from './constants.ts';
import { bossModule, bossPolicy } from './bosses/index.ts';
import type { ChannelOutcome } from './bosses/registry.ts';
import { legalizeRaidMember, type RaidExec } from './legalize.ts';
import { cloneRaidState } from './state.ts';
import type { BossAction, MemberId, RaidAdd, RaidState, RaidUnit, RaidTickActions } from './types.ts';
import { aliveMembers, topThreat, unitOf } from './util.ts';

const cellEq = (ax: number, ay: number, c: Cell): boolean => ax === c[0] && ay === c[1];

/** Resolve one raid tick as a pure function. Returns the next state. */
export function resolveRaidTick(state: RaidState, actions: RaidTickActions): RaidState {
  const s = cloneRaidState(state);
  const t = state.tick;
  const cfg = s.config;
  const events: EngineEvent[] = [];
  let seq = 0;
  const emit = (type: string, fields: Record<string, unknown> = {}): void => {
    events.push({ tick: t, seq: seq++, type, ...fields });
  };

  // ---- Stage 1: validate & charge (per member, ascending id) ----
  const execByMember = new Map<MemberId, RaidExec[]>();
  for (const m of [...s.members].sort()) {
    const { exec, coercions, tokenSpend } = legalizeRaidMember(s, m, actions[m] ?? []);
    for (const c of coercions) emit('action_rejected', { member: m, unit: c.unit_id, reason: c.reason });
    s.remaining[m] -= tokenSpend;
    s.spent[m] += tokenSpend;
    execByMember.set(m, exec);
    // Ping is free + never affects state; recorded as an event only.
    for (const a of actions[m] ?? []) {
      if ((a as { verb?: string }).verb === 'ping') {
        emit('ping', { from: m, cell: (a as { cell?: Cell }).cell ?? null, tag: (a as { tag?: string }).tag ?? 'mark' });
      }
    }
  }
  const allExec: RaidExec[] = [];
  for (const m of [...s.members].sort()) allExec.push(...(execByMember.get(m) ?? []));

  // ---- Stage 2: snapshot HP (squad units, adds, boss pool) ----
  const preHp = new Map<string, number>();
  for (const u of s.units) preHp.set(u.unitId, u.hp);
  for (const a of s.adds) preHp.set(a.addId, a.hp);
  const preBossHp = s.boss.hp;

  // ---- Stage 3: boss action (pure, from start-of-tick state) ----
  const action: BossAction = bossPolicy(state);
  emit('boss_action', {
    strike_target: action.strikeTarget,
    hazards: action.hazards.map((h) => h.readingId),
    body_move: action.bodyMove,
  });

  // ---- Stage 4: movement (boss body first, then squad; 2 sub-steps, bounce) ----
  if (action.bodyMove) applyBossBodyMove(s, action.bodyMove, emit);
  resolveSquadMovement(s, allExec, emit);

  // Spawn boss real hazards + adds into hashed state (telegraphed at t−1's close).
  for (const h of action.hazards) {
    s.activeHazards.push({
      readingId: h.readingId,
      cells: h.cells.map((c) => [c[0], c[1]] as Cell),
      detonateTick: h.detonateTick,
      ...(h.targetMember != null ? { targetMember: h.targetMember } : {}),
    });
  }
  for (const a of action.spawnAdds) {
    if (!s.adds.some((x) => x.addId === a.addId)) {
      s.adds.push({ addId: a.addId, type: a.type, x: a.cell[0], y: a.cell[1], hp: ROSTER[a.type].hp });
      emit('add_spawned', { add: a.addId, cell: a.cell });
    }
  }

  // ---- Stage 5: combat (simultaneous, from snapshot) ----
  const dmgToBoss: Record<MemberId, number> = {};
  const dmgToUnit = new Map<string, number>();
  const dmgToAdd = new Map<string, number>();
  const addDmgUnit = (id: string, n: number): void => {
    dmgToUnit.set(id, (dmgToUnit.get(id) ?? 0) + n);
  };

  // Channel-mechanics wiring: cells the boss's channel OWNS (Split-Brain core).
  // Their incoming squad attacks are withheld from normal boss damage and recorded
  // for `applyChannelMechanics` to adjudicate (clean-write vs split-brain).
  const mod = bossModule(s.bossId);
  const reservedCells = mod.reservedCells ? mod.reservedCells(state) : new Set<string>();
  const channelAttacks: { memberId: MemberId; cell: Cell }[] = [];

  const footprintSet = new Set(s.boss.footprint.map((c) => key(c[0], c[1])));
  for (const e of allExec) {
    if (e.kind !== 'attack') continue;
    const u = e.unit;
    if (u.downed || u.hp <= 0) continue;
    const range = ROSTER[u.type].range;
    // Re-check range against the POST-move position (movement resolved first).
    if (cheb(u.x, u.y, e.target[0], e.target[1]) > range) {
      emit('attack_whiff', { attacker: u.unitId, target: e.target });
      continue;
    }
    const tk = key(e.target[0], e.target[1]);
    if (reservedCells.has(tk)) {
      // A channel-reserved cell (the exposed core): the mechanic adjudicates it.
      channelAttacks.push({ memberId: u.memberId, cell: [e.target[0], e.target[1]] });
      emit('attack_resolved', { attacker: u.unitId, target: e.target, hit: 'core', damage: 0 });
      continue;
    }
    if (footprintSet.has(tk)) {
      // Damage the shared boss pool, minus the Overfit mitigation for this member.
      let dmg = ROSTER[u.type].damage;
      const mit = action.mitigation?.[u.memberId];
      if (mit && mit.den > 0) dmg = Math.floor((dmg * (mit.den - Math.min(mit.num, mit.den))) / mit.den);
      dmgToBoss[u.memberId] = (dmgToBoss[u.memberId] ?? 0) + dmg;
      emit('attack_resolved', { attacker: u.unitId, target: e.target, hit: 'boss', damage: dmg });
      continue;
    }
    const add = s.adds.find((a) => cellEq(a.x, a.y, e.target));
    if (add) {
      const dmg = ROSTER[u.type].damage;
      dmgToAdd.set(add.addId, (dmgToAdd.get(add.addId) ?? 0) + dmg);
      emit('attack_resolved', { attacker: u.unitId, target: e.target, hit: add.addId, damage: dmg });
      continue;
    }
    // Empty / phantom cell → whiff (tokens already spent).
    emit('attack_whiff', { attacker: u.unitId, target: e.target });
  }

  // ---- Channel-mechanics stage (the pure, hashed consequence of the boss's
  // hashed-mechanic channel; failure-modes-pillar.md §2.3). Computed from REAL
  // post-move positions + executed actions; sits beside the hazard/threat stages.
  const outcome: ChannelOutcome = mod.applyChannelMechanics
    ? mod.applyChannelMechanics({ state: s, startState: state, allExec, execByMember, channelAttacks, action, emit })
    : {};
  for (const ud of outcome.unitDamage ?? []) addDmgUnit(ud.unitId, ud.amount);

  // Boss strike on the current threat target (whole-board range), unless the
  // channel suppressed it this tick (Byzantine grounded).
  if (action.strikeTarget && !outcome.suppressStrike) {
    const tu = s.units.find((u) => u.memberId === action.strikeTarget && !u.downed && u.hp > 0);
    if (tu) {
      addDmgUnit(tu.unitId, action.strikeDmg);
      emit('boss_strike', { target: tu.unitId, damage: action.strikeDmg });
    }
  }

  // Real add melee: each add chips 1 to the nearest adjacent alive member.
  for (const a of s.adds) {
    const victims = s.units
      .filter((u) => !u.downed && u.hp > 0 && cheb(u.x, u.y, a.x, a.y) <= 1)
      .sort((p, q) => (p.unitId < q.unitId ? -1 : 1));
    if (victims.length > 0) addDmgUnit(victims[0].unitId, 1);
  }

  // Real hazard detonations for hazards whose detonate_tick == t.
  const hazardDmg = cfg.hazardDamage + Math.max(0, s.corruptedRings.length); // enrage ramps lethality
  const survivingHazards = [];
  for (const hz of s.activeHazards) {
    if (hz.detonateTick === t) {
      const cellSet = new Set(hz.cells.map((c) => key(c[0], c[1])));
      for (const u of s.units) {
        if (!u.downed && u.hp > 0 && cellSet.has(key(u.x, u.y))) {
          addDmgUnit(u.unitId, hazardDmg);
          emit('hazard_detonate', { reading_id: hz.readingId, victim: u.unitId, damage: hazardDmg });
        }
      }
    } else if (hz.detonateTick > t) {
      survivingHazards.push(hz);
    }
  }
  s.activeHazards = survivingHazards;

  // Apply accumulated damage at once to snapshot HP. Squad attack damage is scaled
  // by the channel (a raised shield / sealed window mitigates it); the channel's
  // own core hit adds `bossExtraDamage` and its ward/split-brain adds `bossHeal`.
  const scale = outcome.bossDamageScale ?? { num: 1, den: 1 };
  const rawSquadDmg = Object.values(dmgToBoss).reduce((n, d) => n + d, 0);
  const scaledSquadDmg = scale.den > 0 ? Math.floor((rawSquadDmg * scale.num) / scale.den) : rawSquadDmg;
  const extra = outcome.bossExtraDamage ?? 0;
  const heal = Math.max(0, outcome.bossHeal ?? 0);
  const netDamage = scaledSquadDmg + extra - heal;
  if (netDamage !== 0 || heal > 0) {
    s.boss.hp = Math.min(s.boss.maxHp, preBossHp - netDamage);
    if (netDamage > 0) emit('boss_damaged', { amount: netDamage, hp_after: s.boss.hp });
    else if (netDamage < 0) emit('boss_healed', { amount: -netDamage, hp_after: s.boss.hp });
  }
  for (const u of s.units) {
    const d = dmgToUnit.get(u.unitId) ?? 0;
    if (d > 0 && !u.downed) {
      u.hp = (preHp.get(u.unitId) ?? u.hp) - d;
      emit('unit_damaged', { unit: u.unitId, amount: d, hp_after: u.hp });
    }
  }
  for (const a of s.adds) {
    const d = dmgToAdd.get(a.addId) ?? 0;
    if (d > 0) a.hp = (preHp.get(a.addId) ?? a.hp) - d;
  }

  // ---- Stage 6: deaths → downed conversion ----
  for (const u of s.units) {
    if (!u.downed && u.hp <= 0) {
      u.hp = 0;
      u.downed = true;
      u.downedSince = t;
      s.contribution[u.memberId].downs += 1;
      emit('unit_downed', { unit: u.unitId, at: [u.x, u.y] });
    }
  }
  s.adds = s.adds.filter((a) => {
    if (a.hp <= 0) {
      emit('add_destroyed', { add: a.addId });
      return false;
    }
    return true;
  });
  const bossDefeated = s.boss.hp <= 0;
  if (bossDefeated) emit('boss_defeated', { tick: t });

  // ---- Stage 7: revive resolution ----
  resolveRevives(s, execByMember, dmgToUnit, t, emit);
  // Bleed-out: a downed unit not revived within REVIVE_WINDOW dies.
  s.units = s.units.filter((u) => {
    if (u.downed && u.downedSince !== null && t - u.downedSince >= cfg.reviveWindow) {
      emit('unit_destroyed', { unit: u.unitId, reason: 'bleed_out' });
      delete s.reviveChannels[u.memberId];
      return false;
    }
    return true;
  });

  // ---- Stage 8: threat update (add, then integer-decay; recompute target) ----
  for (const m of s.members) {
    const u = unitOf(s, m);
    if (!u || u.downed) {
      s.threat[m] = 0;
      continue;
    }
    let add = (dmgToBoss[m] ?? 0) * cfg.threatPerDmg;
    if (s.boss.footprint.some((c) => cheb(u.x, u.y, c[0], c[1]) === 1)) add += cfg.meleePresence;
    if (u.type === 'guard') add *= cfg.tankThreatMult; // the tank taunt (§2.3)
    const raised = (s.threat[m] ?? 0) + add;
    s.threat[m] = Math.floor((raised * cfg.threatDecayNum) / cfg.threatDecayDen);
    s.contribution[m].dmg += dmgToBoss[m] ?? 0;
  }
  s.currentTarget = topThreat(s);

  // ---- Stage 9: Lucid-Anchor tally (corroboration credit for next tick) ----
  for (const m of s.members) {
    const u = unitOf(s, m);
    s.anchorCredits[m] = u && !u.downed && ANCHORS.some((a) => cellEq(u.x, u.y, a.cell)) ? 1 : 0;
  }

  // ---- Stage 10: enrage / Fog Collapse ----
  if (t >= cfg.enrageTick) {
    const since = t - cfg.enrageTick;
    if (since % 3 === 0) {
      const ringIndex = since / 3;
      if (ringIndex <= 4 && !s.corruptedRings.includes(ringIndex)) {
        s.corruptedRings.push(ringIndex);
        s.corruptedRings.sort((a, b) => a - b);
        emit('enrage_advance', { ring: ringIndex, cells: cellsInRing(ringIndex) });
      }
    }
    const corrupted = new Set(s.corruptedRings);
    s.units = s.units.filter((u) => {
      if (corrupted.has(ring(u.x, u.y))) {
        emit('unit_destroyed', { unit: u.unitId, reason: 'collapse' });
        delete s.reviveChannels[u.memberId];
        return false;
      }
      return true;
    });
    s.adds = s.adds.filter((a) => !corrupted.has(ring(a.x, a.y)));
  }

  // ---- Stage 11: phase transition (deterministic; forward only) ----
  const targetPhase = computePhase(s, t);
  if (targetPhase > s.boss.phase) {
    emit('boss_phase', { from: s.boss.phase, to: targetPhase, trigger: s.boss.hp <= cfg.p2HpThreshold ? 'hp' : 'tick' });
    s.boss.phase = targetPhase;
  }

  // ---- contribution: ticks alive ----
  for (const m of s.members) {
    const u = unitOf(s, m);
    if (u && !u.downed && u.hp > 0) s.contribution[m].ticksAlive += 1;
  }

  // ---- Stage 12: close ----
  s.tick = t + 1;
  s.events = events;
  return s;
}

/** Forward-only phase computation from HP thresholds (primary) + tick floors. */
function computePhase(s: RaidState, t: number): number {
  const cfg = s.config;
  const nextTick = t + 1;
  let phase = 0;
  if (s.boss.hp <= cfg.p2HpThreshold || nextTick >= cfg.p2TickFloor) phase = 1;
  if (s.boss.hp <= cfg.p3HpThreshold || nextTick >= cfg.p3TickFloor) phase = 2;
  if (nextTick >= cfg.enrageTick) phase = 3;
  return Math.max(phase, s.boss.phase);
}

/** Shift the whole boss bar one lateral step if every destination cell is clear. */
function applyBossBodyMove(s: RaidState, dir: 'N' | 'E' | 'S' | 'W', emit: (t: string, f?: Record<string, unknown>) => void): void {
  const [dx, dy] = DIR_DELTA[dir];
  const occupied = new Set<string>();
  for (const u of s.units) occupied.add(key(u.x, u.y));
  for (const a of s.adds) occupied.add(key(a.x, a.y));
  for (const o of s.obstacles) occupied.add(key(o[0], o[1]));
  const moved: Cell[] = [];
  for (const c of s.boss.footprint) {
    const nx = c[0] + dx;
    const ny = c[1] + dy;
    if (!onBoard(nx, ny) || occupied.has(key(nx, ny))) return; // blocked → no move
    moved.push([nx, ny]);
  }
  s.boss.footprint = moved.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  emit('boss_body_move', { dir });
}

/** Squad movement: 2 sub-steps, mutual-bounce, occupancy vs all units/adds/body. */
function resolveSquadMovement(
  s: RaidState,
  allExec: RaidExec[],
  emit: (t: string, f?: Record<string, unknown>) => void,
): void {
  const movers = allExec
    .filter((e): e is Extract<RaidExec, { kind: 'move' }> => e.kind === 'move' && e.steps.length > 0)
    .map((e) => ({ unit: e.unit, steps: e.steps, stopped: false, taken: 0, origin: [e.unit.x, e.unit.y] as Cell }));

  const staticBlocked = new Set<string>();
  for (const a of s.adds) staticBlocked.add(key(a.x, a.y));
  for (const c of s.boss.footprint) staticBlocked.add(key(c[0], c[1]));
  for (const o of s.obstacles) staticBlocked.add(key(o[0], o[1]));
  for (const r of s.corruptedRings) for (const c of cellsInRing(r)) staticBlocked.add(key(c[0], c[1]));

  for (let sub = 0; sub < 2; sub++) {
    const active = movers.filter((m) => !m.stopped && m.steps.length > sub);
    if (active.length === 0) continue;
    const startPos = new Map<string, Cell>();
    for (const u of s.units) startPos.set(u.unitId, [u.x, u.y]);
    const dest = new Map<string, Cell>();
    for (const m of active) {
      const [dx, dy] = DIR_DELTA[m.steps[sub]];
      dest.set(m.unit.unitId, [m.unit.x + dx, m.unit.y + dy]);
    }
    const destCount = new Map<string, number>();
    for (const m of active) {
      const d = dest.get(m.unit.unitId) as Cell;
      destCount.set(key(d[0], d[1]), (destCount.get(key(d[0], d[1])) ?? 0) + 1);
    }
    const cancel = new Map<string, 'occupied' | 'contended' | 'swap'>();
    for (const m of active) {
      const id = m.unit.unitId;
      const d = dest.get(id) as Cell;
      const dk = key(d[0], d[1]);
      let reason: 'occupied' | 'contended' | 'swap' | null = null;
      if (staticBlocked.has(dk)) reason = 'occupied';
      for (const v of active) {
        if (reason || v.unit.unitId === id) continue;
        const vStart = startPos.get(v.unit.unitId) as Cell;
        const vDest = dest.get(v.unit.unitId) as Cell;
        const myStart = startPos.get(id) as Cell;
        if (vDest[0] === myStart[0] && vDest[1] === myStart[1] && d[0] === vStart[0] && d[1] === vStart[1]) reason = 'swap';
      }
      if (!reason && (destCount.get(dk) ?? 0) >= 2) reason = 'contended';
      if (!reason) {
        for (const [uid, p] of startPos) {
          if (uid === id) continue;
          if (p[0] === d[0] && p[1] === d[1]) {
            reason = 'occupied';
            break;
          }
        }
      }
      if (reason) cancel.set(id, reason);
    }
    for (const m of active) {
      const id = m.unit.unitId;
      const reason = cancel.get(id);
      if (reason) {
        m.stopped = true;
      } else {
        const d = dest.get(id) as Cell;
        m.unit.x = d[0];
        m.unit.y = d[1];
        m.taken += 1;
      }
    }
  }
  for (const m of movers) {
    if (m.taken > 0) emit('move_resolved', { unit: m.unit.unitId, from: m.origin, to: [m.unit.x, m.unit.y], steps_taken: m.taken });
  }
}

/** Advance/complete/reset channelled revives (§2.4). */
function resolveRevives(
  s: RaidState,
  execByMember: Map<MemberId, RaidExec[]>,
  dmgToUnit: Map<string, number>,
  t: number,
  emit: (type: string, f?: Record<string, unknown>) => void,
): void {
  const cfg = s.config;
  for (const m of [...s.members].sort()) {
    const reviver = unitOf(s, m);
    const reviveExec = (execByMember.get(m) ?? []).find((e): e is Extract<RaidExec, { kind: 'revive' }> => e.kind === 'revive');
    // Channel breaks if the reviver is now downed/dead, took a hit that downed it,
    // or did not issue a revive on the same target this tick.
    if (!reviver || reviver.downed || !reviveExec) {
      delete s.reviveChannels[m];
      continue;
    }
    const target = s.units.find((u) => u.memberId === reviveExec.target && u.downed && !u.forfeited);
    if (!target || cheb(reviver.x, reviver.y, target.x, target.y) > 1) {
      delete s.reviveChannels[m];
      continue;
    }
    const ch = s.reviveChannels[m];
    const ticks = ch && ch.target === reviveExec.target ? ch.ticks + 1 : 1;
    if (ticks === 1) emit('revive_started', { reviver: reviver.unitId, target: target.unitId });
    if (ticks >= cfg.reviveTicks) {
      target.downed = false;
      target.downedSince = null;
      target.hp = cfg.reviveHp;
      s.contribution[m].revives += 1;
      delete s.reviveChannels[m];
      emit('revive_completed', { reviver: reviver.unitId, target: target.unitId });
    } else {
      s.reviveChannels[m] = { target: reviveExec.target, ticks };
      emit('revive_progress', { reviver: reviver.unitId, target: target.unitId, ticks });
    }
  }
  void dmgToUnit;
}

export { unitOf, aliveMembers };
export type { RaidAdd, RaidUnit };
