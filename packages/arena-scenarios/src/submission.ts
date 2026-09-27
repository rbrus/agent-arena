/**
 * Untrusted target payload → canonical engine actions (threat-model-arena.md
 * §4.2 "Engine (response → action)"). Order of checks, first failure wins:
 *
 *   1. shape + contract schema (`eval_raid_action.$defs.actions` / `action.units`)
 *                                              → schema_invalid
 *   2. at most one non-ping order per unit     → schema_invalid (errors.md §3a)
 *   3. seat ownership                          → not_your_seat
 *   4. canonical whitelist copy (drops `thought`, `ping.text`, unknown keys can't
 *      exist after 1), then the adapter speed rule: a move longer than the
 *      unit's speed takes its legal prefix and is recorded as an `over_speed`
 *      adapter coercion (both engines only cap step lists at 2, schema-side).
 *
 * Nothing here is ever evaluated, templated or parsed for meaning.
 */

import { ROSTER, type RaidUnitAction, type UnitAction, type UnitType } from 'wot-engine';
import { schemaErrors, validateDuelUnits, validateRaidActions } from './contracts.ts';
import type { AdapterCoercion, RejectReason } from './types.ts';

export type ParseResult<T> =
  | { ok: true; actions: T; coercions: Omit<AdapterCoercion, 'tick'>[] }
  | { ok: false; reason: RejectReason; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const TYPE_RE = /-(scout|lancer|archer|guard)$/;
function speedOf(unitId: string): number {
  const m = TYPE_RE.exec(unitId);
  return m ? ROSTER[m[1] as UnitType].move : 2;
}

function oneOrderPerUnit(actions: readonly { unit_id?: string; verb: string }[]): boolean {
  const seen = new Set<string>();
  for (const a of actions) {
    if (a.verb === 'ping') continue;
    const id = a.unit_id ?? '';
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function canonRaid(member: string, raw: readonly RaidUnitAction[], coercions: Omit<AdapterCoercion, 'tick'>[]): RaidUnitAction[] {
  const out: RaidUnitAction[] = [];
  for (const a of raw) {
    switch (a.verb) {
      case 'hold':
        out.push({ unit_id: a.unit_id, verb: 'hold' });
        break;
      case 'move': {
        const speed = speedOf(a.unit_id);
        if (a.steps.length > speed) coercions.push({ member, unitId: a.unit_id, reason: 'over_speed' });
        out.push({ unit_id: a.unit_id, verb: 'move', steps: a.steps.slice(0, speed) });
        break;
      }
      case 'attack':
        out.push({ unit_id: a.unit_id, verb: 'attack', target: [a.target[0], a.target[1]] });
        break;
      case 'revive':
        out.push({ unit_id: a.unit_id, verb: 'revive', target_member: a.target_member });
        break;
      case 'ping':
        // Free, never affects state. `text` is DROPPED here (never recorded, §1.3).
        out.push({ ...(a.unit_id !== undefined ? { unit_id: a.unit_id } : {}), verb: 'ping', cell: [a.cell[0], a.cell[1]], tag: a.tag });
        break;
    }
  }
  return out;
}

function checkPayloadKeys(p: Record<string, unknown>): string | null {
  for (const k of Object.keys(p)) if (k !== 'units' && k !== 'members' && k !== 'thought') return `unknown field ${k}`;
  if (p.thought !== undefined && (typeof p.thought !== 'string' || p.thought.length > 200)) return 'thought must be a string ≤ 200';
  return null;
}

/**
 * Member mode: `{units: [...]}` for exactly one seat. `thought` is accepted and
 * dropped.
 */
export function parseMemberPayload(seat: string, payload: unknown): ParseResult<RaidUnitAction[]> {
  if (!isObj(payload)) return { ok: false, reason: 'schema_invalid', detail: 'payload must be an object' };
  const bad = checkPayloadKeys(payload);
  if (bad) return { ok: false, reason: 'schema_invalid', detail: bad };
  if (payload.members !== undefined) return { ok: false, reason: 'schema_invalid', detail: 'member mode takes `units`, not `members`' };
  if (!validateRaidActions(payload.units)) return { ok: false, reason: 'schema_invalid', detail: schemaErrors(validateRaidActions) };
  const units = payload.units as RaidUnitAction[];
  if (!oneOrderPerUnit(units)) return { ok: false, reason: 'schema_invalid', detail: 'more than one order for a unit' };
  for (const a of units) {
    if (a.unit_id !== undefined && !a.unit_id.startsWith(`${seat}-`)) {
      return { ok: false, reason: 'not_your_seat', detail: 'order names a unit this seat does not control' };
    }
  }
  const coercions: Omit<AdapterCoercion, 'tick'>[] = [];
  return { ok: true, actions: canonRaid(seat, units, coercions), coercions };
}

/** Squad mode: `{members: {m0: [...], ...}}`; an omitted member Holds. */
export function parseSquadPayload(controls: readonly string[], payload: unknown): ParseResult<Record<string, RaidUnitAction[]>> {
  if (!isObj(payload)) return { ok: false, reason: 'schema_invalid', detail: 'payload must be an object' };
  const bad = checkPayloadKeys(payload);
  if (bad) return { ok: false, reason: 'schema_invalid', detail: bad };
  if (payload.units !== undefined) return { ok: false, reason: 'schema_invalid', detail: 'squad mode takes `members`, not `units`' };
  const members = payload.members;
  if (!isObj(members)) return { ok: false, reason: 'schema_invalid', detail: 'members must be an object' };
  const keys = Object.keys(members);
  if (keys.length > 5) return { ok: false, reason: 'schema_invalid', detail: 'at most 5 members' };
  for (const k of keys) {
    if (!/^m[0-4]$/.test(k)) return { ok: false, reason: 'schema_invalid', detail: 'member keys are m0..m4' };
    if (!validateRaidActions(members[k])) return { ok: false, reason: 'schema_invalid', detail: `${k}: ${schemaErrors(validateRaidActions)}` };
    if (!oneOrderPerUnit(members[k] as RaidUnitAction[])) {
      return { ok: false, reason: 'schema_invalid', detail: `${k}: more than one order for a unit` };
    }
  }
  const out: Record<string, RaidUnitAction[]> = {};
  const coercions: Omit<AdapterCoercion, 'tick'>[] = [];
  for (const k of keys.sort()) {
    if (!controls.includes(k)) return { ok: false, reason: 'not_your_seat', detail: `${k} is not controlled by this seat` };
    const acts = members[k] as RaidUnitAction[];
    for (const a of acts) {
      if (a.unit_id !== undefined && !a.unit_id.startsWith(`${k}-`)) {
        return { ok: false, reason: 'not_your_seat', detail: `members.${k} orders another member's unit` };
      }
    }
    out[k] = canonRaid(k, acts, coercions);
  }
  return { ok: true, actions: out, coercions };
}

/** Duel: `{units: [...]}` (the v1 `action.units` slice; envelope checked by the transport). */
export function parseDuelPayload(seat: 'A' | 'B', payload: unknown): ParseResult<UnitAction[]> {
  if (!isObj(payload)) return { ok: false, reason: 'schema_invalid', detail: 'payload must be an object' };
  for (const k of Object.keys(payload)) if (k !== 'units') return { ok: false, reason: 'schema_invalid', detail: `unknown field ${k}` };
  if (!validateDuelUnits(payload.units)) return { ok: false, reason: 'schema_invalid', detail: schemaErrors(validateDuelUnits) };
  const units = payload.units as UnitAction[];
  if (!oneOrderPerUnit(units)) return { ok: false, reason: 'schema_invalid', detail: 'duplicate unit_id' };
  for (const u of units) {
    if (!u.unit_id.startsWith(`${seat}-`)) return { ok: false, reason: 'not_your_seat', detail: 'order names a unit this seat does not control' };
  }
  const coercions: Omit<AdapterCoercion, 'tick'>[] = [];
  const out: UnitAction[] = units.map((u) => {
    if (u.verb === 'move') {
      const speed = speedOf(u.unit_id);
      if (u.steps.length > speed) coercions.push({ member: seat, unitId: u.unit_id, reason: 'over_speed' });
      return { unit_id: u.unit_id, verb: 'move', steps: u.steps.slice(0, speed) };
    }
    if (u.verb === 'attack') return { unit_id: u.unit_id, verb: 'attack', target: [u.target[0], u.target[1]] };
    return { unit_id: u.unit_id, verb: 'hold' };
  });
  return { ok: true, actions: out, coercions };
}
