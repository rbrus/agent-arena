/**
 * RaidMatch — the WSS raid tick loop over the pure raid engine (raids-v1 §2.7).
 *
 * Per tick: build each squad member's raid_observation with a fresh unpredictable
 * nonce, collect each member's raid_action (anti-replay on turn_id + nonce),
 * advance when all connected members submit or the soft deadline elapses (missing
 * member → its units Hold), and on a terminal state persist the replay and emit
 * raid_end. A clear records the outcome and the replay hash only (no reward:
 * ADR-001 §6 removed the economy).
 *
 * Internal engine member ids are `m0..m4`; the wire uses the delegated child's
 * `mem_…` id + 1-based slot. This runner owns that mapping. Boss + phantoms are
 * deterministic (Pillar 9) — nothing here trusts the client.
 */

import { randomBytes } from 'node:crypto';
import {
  buildRaidObservation,
  createInitialRaidState,
  foldHash,
  isRaidTerminal,
  raidStateHash,
  BOSS_CATALOG,
  referenceSquadSpec,
  resolveRaidTick,
  ROSTER,
  type BossId,
  type Cell,
  type Dir,
  type RaidObservation,
  type RaidState,
  type RaidTickActions,
  type RaidUnitAction,
  type SquadSpec,
} from 'wot-engine';
import type { League, Stores } from 'wot-store';
import { newId } from 'wot-store';
import type { LogFields } from './log.ts';

/** One squad slot's live wiring. */
export interface RaidSlot {
  slot: number; // 1..5
  memberId: string; // wire `mem_…`
  agentId: string; // reward beneficiary (child's parent-owner agent)
  ownerId: string;
  displayName: string;
  /** Engine member id + unit id, derived from the slot. */
  engineMember: string; // `m{slot-1}`
  unitId: string; // `m{slot-1}-{type}`
}

export interface RaidAgentSide {
  send(frame: unknown): void;
  close(code: number, reason?: string): void;
}

export interface RaidMatchOptions {
  raidId: string;
  seed: number;
  bossId: BossId;
  league: League;
  ownerId: string;
  /** The squad lobby id (sqd_…). */
  squadId?: string;
  slots: RaidSlot[];
  softMs: number;
  hardMs: number;
  stores: Stores;
  log: (f: LogFields) => void;
  onEnd: (raidId: string) => void;
}

const DIR_OF: Record<string, Dir> = { N: 'N', E: 'E', S: 'S', W: 'W' };

/** Build the squad spec (unit types by slot, from the reference composition). */
export function specForSlots(slots: RaidSlot[]): SquadSpec {
  const base = referenceSquadSpec();
  return {
    members: slots
      .sort((a, b) => a.slot - b.slot)
      .map((s, i) => ({ memberId: `m${i}`, type: base.members[i]?.type ?? 'lancer' })),
  };
}

export class RaidMatch {
  readonly raidId: string;
  private state: RaidState;
  private chain: string;
  private readonly perTickHashes: string[] = [];
  private readonly inputs: RaidTickActions[] = [];
  private readonly tickLog: unknown[] = [];
  private readonly sides = new Map<number, RaidAgentSide>(); // slot -> side
  private readonly slotByMember = new Map<string, RaidSlot>();
  private readonly bySlot = new Map<number, RaidSlot>();
  private turnId = 0;
  private nonces: Record<string, string> = {}; // engineMember -> nonce
  private submitted: Record<string, RaidUnitAction[] | null> = {};
  private softTimer: NodeJS.Timeout | null = null;
  private resolved = false;
  private ended = false;
  private readonly opts: RaidMatchOptions;
  private readonly spec: SquadSpec;

  constructor(opts: RaidMatchOptions) {
    this.opts = opts;
    this.raidId = opts.raidId;
    this.spec = specForSlots(opts.slots);
    for (const s of opts.slots) {
      this.slotByMember.set(s.memberId, s);
      this.bySlot.set(s.slot, s);
    }
    this.state = createInitialRaidState(opts.seed, opts.bossId, this.spec, { raidId: opts.raidId });
    this.chain = raidStateHash(this.state);
  }

  attach(slot: number, side: RaidAgentSide): void {
    this.sides.set(slot, side);
  }

  /** True once every slot has an attached live session. */
  allConnected(): boolean {
    return this.opts.slots.every((s) => this.sides.has(s.slot));
  }

  start(): void {
    this.opts.log({ event: 'raid_start', match_id: this.raidId, detail: { boss: this.opts.bossId, seed: this.opts.seed } });
    this.startTick();
  }

  private engineMemberFor(slot: number): string {
    // slots are 1..5 in join order → engine m0..m4 by sorted slot.
    const ordered = [...this.opts.slots].sort((a, b) => a.slot - b.slot);
    return `m${ordered.findIndex((s) => s.slot === slot)}`;
  }

  private startTick(): void {
    if (this.ended) return;
    this.turnId = this.state.tick;
    this.resolved = false;
    this.nonces = {};
    this.submitted = {};
    for (const m of this.state.members) this.submitted[m] = null;

    for (const s of this.opts.slots) {
      const em = this.engineMemberFor(s.slot);
      const nonce = `n_${randomBytes(12).toString('hex')}`;
      this.nonces[em] = nonce;
      const side = this.sides.get(s.slot);
      if (side) side.send(this.wireObservation(em, s, nonce));
    }
    this.softTimer = setTimeout(() => this.resolveTurn(), this.opts.softMs);
  }

  /** Map an internal RaidObservation → a schema-valid `raid_observation` frame. */
  private wireObservation(engineMember: string, slot: RaidSlot, nonce: string): Record<string, unknown> {
    const obs: RaidObservation = buildRaidObservation(this.state, engineMember);
    const memWire = (em: string): string => {
      const idx = this.state.members.indexOf(em);
      const s = [...this.opts.slots].sort((a, b) => a.slot - b.slot)[idx];
      return s ? s.memberId : slot.memberId;
    };
    const boss = obs.boss;
    return {
      t: 'raid_observation',
      protocol_version: '1.0',
      raid_id: this.raidId,
      turn_id: this.turnId,
      nonce,
      deadline_ms: this.opts.softMs,
      hard_deadline_ms: this.opts.hardMs,
      phase: 'raid',
      boss: {
        boss_id: boss.boss_id,
        name: BOSS_CATALOG[boss.boss_id as BossId]?.name ?? boss.boss_id,
        phase: boss.phase,
        hp: boss.hp,
        max_hp: boss.max_hp,
        cell: boss.footprint[0],
        enraged: this.state.tick >= this.state.config.enrageTick,
        telegraph: {
          pattern: obs.boss_telegraph.pattern,
          resolves_on_turn: this.turnId + 1,
          cells: obs.boss_telegraph.hazard_cells,
        },
      },
      you: {
        member_id: slot.memberId,
        slot: slot.slot,
        action_tokens_remaining: obs.you.action_tokens_remaining,
        downed: obs.you.downed,
        units: obs.you.unit
          ? [{ unit_id: obs.you.unit.unit_id, type: obs.you.unit.type, owner: slot.memberId, cell: obs.you.unit.cell, hp: obs.you.unit.hp, max_hp: obs.you.unit.max_hp }]
          : [],
      },
      squad: {
        members: obs.squad.map((sq) => {
          const s = this.slotOfEngine(sq.member_id);
          return { member_id: s?.memberId ?? memWire(sq.member_id), slot: s?.slot ?? 1, display_name: s?.displayName ?? 'Agent', downed: sq.downed, alive_units: sq.downed ? 0 : 1 };
        }),
      },
      threat: {
        aggro_on: this.state.currentTarget ? (this.slotOfEngine(this.state.currentTarget)?.memberId ?? null) : null,
        table: obs.threat_table.map((t) => ({ member_id: this.slotOfEngine(t.member_id)?.memberId ?? slot.memberId, threat: t.threat })),
      },
    };
  }

  private slotOfEngine(engineMember: string): RaidSlot | undefined {
    const idx = this.state.members.indexOf(engineMember);
    return [...this.opts.slots].sort((a, b) => a.slot - b.slot)[idx];
  }

  /** Route a schema-valid `raid_action` frame from a slot. */
  submitAction(slot: number, frame: { turn_id: number; nonce: string; member_id: string; units: unknown[] }): { ok: boolean; reason?: string } {
    if (this.ended) return { ok: false, reason: 'no_active_match' };
    const s = this.bySlot.get(slot);
    if (!s || s.memberId !== frame.member_id) return { ok: false, reason: 'not_your_member' };
    const em = this.engineMemberFor(slot);
    if (frame.turn_id !== this.turnId) return { ok: false, reason: 'stale_turn' };
    if (frame.nonce !== this.nonces[em]) return { ok: false, reason: 'bad_echo' };
    if (this.submitted[em] !== null) return { ok: false, reason: 'duplicate_submission' };
    this.submitted[em] = this.decodeUnits(frame.units);
    this.maybeResolve();
    return { ok: true };
  }

  private decodeUnits(units: unknown[]): RaidUnitAction[] {
    const out: RaidUnitAction[] = [];
    for (const raw of units) {
      const u = raw as Record<string, unknown>;
      const unit_id = String(u.unit_id ?? '');
      const verb = String(u.verb ?? '');
      if (verb === 'hold') out.push({ unit_id, verb: 'hold' });
      else if (verb === 'move') out.push({ unit_id, verb: 'move', steps: (Array.isArray(u.steps) ? u.steps : []).map((d) => DIR_OF[String(d)]).filter(Boolean) as Dir[] });
      else if (verb === 'attack' && Array.isArray(u.target)) out.push({ unit_id, verb: 'attack', target: [Number(u.target[0]), Number(u.target[1])] as Cell });
      else if (verb === 'revive' && typeof u.target_member === 'string') {
        // Map the wire target member (mem_…) → engine member id.
        const s = this.slotByMember.get(u.target_member);
        if (s) out.push({ unit_id, verb: 'revive', target_member: this.engineMemberFor(s.slot) });
      }
      // `ability` and unknown verbs are dropped (coerced to Hold by the engine).
    }
    return out;
  }

  private maybeResolve(): void {
    if (this.resolved) return;
    const allIn = this.opts.slots.every((s) => this.submitted[this.engineMemberFor(s.slot)] !== null || !this.sides.has(s.slot));
    if (allIn) {
      this.resolved = true;
      if (this.softTimer) clearTimeout(this.softTimer);
      setImmediate(() => this.doResolve());
    }
  }

  private resolveTurn(): void {
    if (this.resolved || this.ended) return;
    this.resolved = true;
    this.doResolve();
  }

  private doResolve(): void {
    if (this.ended) return;
    const actions: RaidTickActions = {};
    for (const m of this.state.members) actions[m] = this.submitted[m] ?? [];
    this.state = resolveRaidTick(this.state, actions);
    this.inputs.push(actions);
    const h = raidStateHash(this.state);
    this.perTickHashes.push(h);
    this.chain = foldHash(this.chain, h);
    for (const ev of this.state.events) this.tickLog.push(ev);

    const term = isRaidTerminal(this.state);
    if (term.over) {
      void this.finish(term.outcome ?? 'wipe');
      return;
    }
    this.startTick();
  }

  private async finish(outcome: 'clear' | 'wipe' | 'timeout'): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.softTimer) clearTimeout(this.softTimer);

    // Persist the replay (seed + inputs + tick log + chain) — retrievable like a duel.
    let replayId = 'rpl_' + '0'.repeat(26);
    try {
      const rec = await this.opts.stores.replays.saveReplay({
        seed: this.opts.seed,
        inputs: this.inputs,
        tickLog: this.tickLog,
        hash: this.chain,
        matchId: this.raidId,
      });
      replayId = rec.replayId;
    } catch (err) {
      this.opts.log({ event: 'persist_error', match_id: this.raidId, detail: { message: (err as Error).message } });
    }

    // Persist a raid summary (retrievable via GET /v1/raids/{raid_id}).
    try {
      await this.opts.stores.matches.saveSummary({
        matchId: this.raidId,
        mode: 'duel', // MatchSummary is duel-typed; the raid fields ride the open record
        raid: true,
        boss_id: this.opts.bossId,
        status: outcome === 'clear' ? 'completed' : 'completed',
        outcome,
        boss_defeated: outcome === 'clear',
        seed: this.opts.seed,
        replay_id: replayId,
        replay_hash: this.chain,
        ticks_played: this.state.tick,
        ended_at: new Date().toISOString(),
      });
    } catch {
      /* summary is best-effort */
    }

    // Emit raid_end to each connected member, then close.
    for (const s of this.opts.slots) {
      const em = this.engineMemberFor(s.slot);
      const unit = this.state.units.find((u) => u.memberId === em);
      const side = this.sides.get(s.slot);
      if (!side) continue;
      side.send({
        t: 'raid_end',
        raid_id: this.raidId,
        boss_id: this.opts.bossId,
        outcome,
        boss_defeated: outcome === 'clear',
        you: { member_id: s.memberId, slot: s.slot, survived: !!unit && !unit.downed },
        boss: { phase_reached: this.state.boss.phase, hp_remaining: Math.max(0, this.state.boss.hp) },
        ticks_played: this.state.tick,
        seed: this.opts.seed,
        replay_id: replayId,
        replay_hash: this.chain,
      });
      side.close(1000, 'raid_end');
    }

    this.opts.log({ event: 'raid_end', match_id: this.raidId, reason: outcome, detail: { ticks: this.state.tick, replay_id: replayId } });
    this.opts.onEnd(this.raidId);
  }

  forceClose(code: number): void {
    if (this.ended) return;
    this.ended = true;
    if (this.softTimer) clearTimeout(this.softTimer);
    for (const side of this.sides.values()) side.close(code, 'arena shutdown');
  }
}

export { ROSTER };
