/**
 * `resolveTick` — the pure, simultaneous-resolution tick function (A1 §5).
 *
 * Pipeline (order-independent between the two players):
 *   1 validate & charge   2 snapshot   3 movement (2 sub-steps, mutual bounce)
 *   4 combat (simultaneous, from snapshot; guard counters)   5 deaths
 *   6 objective scoring   7 fog collapse   8 close (state hash)
 *
 * No wall-clock, no randomness, no I/O. Integer arithmetic throughout.
 */

import { cellsInRing, cheb, DIR_DELTA, key, ring } from './board.ts';
import { OBJECTIVES, ROSTER } from './constants.ts';
import { stateHash } from './hash.ts';
import { type ExecUnit, legalizeInternal } from './legalize.ts';
import { cloneState } from './state.ts';
import type { Cell, EngineEvent, MatchState, Player, TickActions, Unit } from './types.ts';

const other = (p: Player): Player => (p === 'A' ? 'B' : 'A');

/** Resolve one tick as a pure function (A1 §5). Returns the next state. */
export function resolveTick(state: MatchState, actions: TickActions): MatchState {
  const s = cloneState(state);
  const t = state.tick; // the tick being resolved
  const events: EngineEvent[] = [];
  let seq = 0;
  const emit = (type: string, fields: Record<string, unknown> = {}): void => {
    events.push({ tick: t, seq: seq++, type, ...fields });
  };

  // ---- Stage 1: validate & charge (per player, independent) ----
  const execs: ExecUnit[] = [];
  for (const player of ['A', 'B'] as Player[]) {
    const { exec, coercions, tokenSpend } = legalizeInternal(s, player, actions[player] ?? []);
    for (const c of coercions) {
      emit('action_rejected', { player, unit: c.unit_id, reason: c.reason });
    }
    s.remaining[player] -= tokenSpend;
    s.spent[player] += tokenSpend;
    emit('token_spend', { player, amount: tokenSpend, remaining: s.remaining[player] });
    execs.push(...exec);
  }

  // ---- Stage 2: snapshot HP (so combat damage is truly simultaneous) ----
  const preHp = new Map<string, number>();
  for (const u of s.units) preHp.set(u.unitId, u.hp);

  // ---- Stage 3: movement (up to 2 sub-steps; max speed = 2) ----
  const movers = execs
    .filter((e): e is Extract<ExecUnit, { kind: 'move' }> => e.kind === 'move')
    .map((e) => ({
      unit: e.unit,
      steps: e.steps,
      truncated: e.truncated,
      truncReason: e.truncReason,
      stopped: false,
      taken: 0,
      origin: [e.unit.x, e.unit.y] as Cell,
    }));

  const posOf = (u: Unit): Cell => [u.x, u.y];

  for (let sub = 0; sub < 2; sub++) {
    const active = movers.filter((m) => !m.stopped && m.steps.length > sub);
    if (active.length === 0) continue;

    // Snapshot ALL units' positions at the start of this sub-step (cascade-free).
    const startPos = new Map<string, Cell>();
    for (const u of s.units) startPos.set(u.unitId, posOf(u));

    // Intended destinations for the active movers.
    const dest = new Map<string, Cell>();
    for (const m of active) {
      const [dx, dy] = DIR_DELTA[m.steps[sub]];
      dest.set(m.unit.unitId, [m.unit.x + dx, m.unit.y + dy]);
    }

    // Count destination collisions (contended).
    const destCount = new Map<string, number>();
    for (const m of active) {
      const d = dest.get(m.unit.unitId) as Cell;
      const k = key(d[0], d[1]);
      destCount.set(k, (destCount.get(k) ?? 0) + 1);
    }

    const cancel = new Map<string, 'occupied' | 'contended' | 'swap'>();
    for (const m of active) {
      const id = m.unit.unitId;
      const d = dest.get(id) as Cell;
      const dk = key(d[0], d[1]);

      // (c) swap: another active mover exchanges cells with us.
      let reason: 'occupied' | 'contended' | 'swap' | null = null;
      for (const v of active) {
        if (v.unit.unitId === id) continue;
        const vStart = startPos.get(v.unit.unitId) as Cell;
        const vDest = dest.get(v.unit.unitId) as Cell;
        const myStart = startPos.get(id) as Cell;
        if (vDest[0] === myStart[0] && vDest[1] === myStart[1] && d[0] === vStart[0] && d[1] === vStart[1]) {
          reason = 'swap';
          break;
        }
      }
      // (b) contended: two or more movers share this destination.
      if (!reason && (destCount.get(dk) ?? 0) >= 2) reason = 'contended';
      // (a) occupied: destination occupied by ANY unit at sub-step start.
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

    // Apply: cancelled movers stop; the rest move simultaneously.
    for (const m of active) {
      const id = m.unit.unitId;
      const reason = cancel.get(id);
      if (reason) {
        m.stopped = true;
        emit('move_bounced', { unit: id, at: posOf(m.unit), reason });
      } else {
        const d = dest.get(id) as Cell;
        m.unit.x = d[0];
        m.unit.y = d[1];
        m.taken += 1;
      }
    }
  }

  for (const m of movers) {
    if (m.taken > 0) {
      emit('move_resolved', {
        unit: m.unit.unitId,
        from: m.origin,
        to: posOf(m.unit),
        steps_taken: m.taken,
      });
    }
    if (m.truncated) {
      emit('move_truncated', {
        unit: m.unit.unitId,
        stopped_at: posOf(m.unit),
        reason: m.truncReason ?? 'edge',
      });
    }
  }

  // ---- Stage 4: combat (simultaneous, post-movement positions, pre-snapshot HP) ----
  const damage = new Map<string, number>();
  const killedBy = new Map<string, string[]>();
  const addDamage = (id: string, amount: number, by?: string): void => {
    damage.set(id, (damage.get(id) ?? 0) + amount);
    if (by) {
      const arr = killedBy.get(id) ?? [];
      arr.push(by);
      killedBy.set(id, arr);
    }
  };

  const attackExecs = execs.filter(
    (e): e is Extract<ExecUnit, { kind: 'attack' }> => e.kind === 'attack',
  );
  // hits[i] = the victim unit (or null) for attackExecs[i], to resolve counters.
  const hits: (Unit | null)[] = [];
  for (const a of attackExecs) {
    const attacker = a.unit;
    const [tx, ty] = a.target;
    // vision >= range guarantees this cell is one the attacker can see (A1 §7.5).
    if (cheb(attacker.x, attacker.y, tx, ty) > ROSTER[attacker.type].range) {
      hits.push(null);
      emit('attack_whiff', { attacker: attacker.unitId, target: a.target });
      continue;
    }
    const victim = s.units.find(
      (u) => u.owner !== attacker.owner && u.x === tx && u.y === ty,
    );
    if (victim) {
      const dmg = ROSTER[attacker.type].damage;
      addDamage(victim.unitId, dmg, attacker.unitId);
      hits.push(victim);
      emit('attack_resolved', {
        attacker: attacker.unitId,
        target: a.target,
        hit: victim.unitId,
        damage: dmg,
      });
    } else {
      hits.push(null);
      emit('attack_whiff', { attacker: attacker.unitId, target: a.target });
    }
  }

  // Guard melee counters: each Guard hit by a Chebyshev-1 attacker counters it.
  for (let i = 0; i < attackExecs.length; i++) {
    const victim = hits[i];
    if (!victim || victim.type !== 'guard' || !ROSTER.guard.meleeCounter) continue;
    const attacker = attackExecs[i].unit;
    if (cheb(attacker.x, attacker.y, victim.x, victim.y) === 1) {
      const counterDmg = ROSTER.guard.damage;
      addDamage(attacker.unitId, counterDmg, victim.unitId);
      emit('counter_resolved', {
        guard: victim.unitId,
        attacker: attacker.unitId,
        damage: counterDmg,
      });
    }
  }

  // Apply all accumulated damage at once to the pre-snapshot HP.
  for (const u of s.units) {
    const dmg = damage.get(u.unitId) ?? 0;
    if (dmg > 0) {
      const base = preHp.get(u.unitId) ?? u.hp;
      u.hp = base - dmg;
      emit('unit_damaged', { unit: u.unitId, amount: dmg, hp_after: u.hp });
    }
  }

  // ---- Stage 5: deaths ----
  const combatDead = s.units.filter((u) => u.hp <= 0);
  for (const u of combatDead) {
    emit('unit_destroyed', { unit: u.unitId, by: killedBy.get(u.unitId) ?? [] });
  }
  s.units = s.units.filter((u) => u.hp > 0);

  // ---- Stage 6: objective scoring ----
  const gained: Record<Player, number> = { A: 0, B: 0 };
  for (const obj of OBJECTIVES) {
    const occ = s.units.find((u) => u.x === obj.cell[0] && u.y === obj.cell[1]);
    const controller: Player | 'none' = occ ? occ.owner : 'none';
    if (occ) {
      s.scores[occ.owner] += obj.points;
      gained[occ.owner] += obj.points;
    }
    emit('objective_tick', { objective: obj.id, controller, points: occ ? obj.points : 0 });
  }
  for (const p of ['A', 'B'] as Player[]) {
    if (gained[p] > 0) emit('score_update', { player: p, total: s.scores[p] });
  }

  // ---- Stage 7: fog collapse ----
  if (t >= s.config.collapseStart) {
    const sinceStart = t - s.config.collapseStart;
    if (sinceStart % s.config.collapseInterval === 0) {
      const ringIndex = sinceStart / s.config.collapseInterval;
      if (ringIndex <= 3 && !s.corruptedRings.includes(ringIndex)) {
        s.corruptedRings.push(ringIndex);
        s.corruptedRings.sort((x, y) => x - y);
        emit('collapse_advance', { ring: ringIndex, cells: cellsInRing(ringIndex) });
      }
    }
    const corruptedSet = new Set(s.corruptedRings);
    const collapseDead = s.units.filter((u) => corruptedSet.has(ring(u.x, u.y)));
    for (const u of collapseDead) {
      emit('collapse_kill', { unit: u.unitId, at: posOf(u) });
    }
    s.units = s.units.filter((u) => !corruptedSet.has(ring(u.x, u.y)));
  }

  // ---- Stage 8: close ----
  s.tick = t + 1;
  const hash = stateHash(s);
  emit('tick_close', { tick: t, state_hash: hash });
  s.events = events;
  return s;
}

export { other };
