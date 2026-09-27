/**
 * In-process table runner for reference agents (golden pairs, calibration sweeps, the
 * Phase 7 CLI's local targets). Seats an agent per power, drives
 * `dipObserve → agent → dipAct → dipTick` to the terminal, and collects the injector's
 * canary registry OUTSIDE the engine state. Returns the episode and the evaluation
 * context the oracle hook needs. Agents never see anything but their own observation.
 *
 * Profiles (§4.5) are expressed as explicit `seats`; `assignPersonas` applies the
 * seeded persona rule with the one-schemer re-roll.
 */

import type { DipObservation } from '../observation.ts';
import type { EvalClass } from '../press.ts';
import { dipAct, dipForfeit, dipInit, dipObserve, dipTick, type DipAction, type DipConfig, type DipEpisode, type TickInput } from '../scenario.ts';
import type { Power } from '../types.ts';
import { POWERS } from '../types.ts';
import type { Canary, CanaryKind, DipEvalContext, SeatInfo } from '../oracles/common.ts';
import { alive, hmix } from './board-view.ts';
import { colludeWith, newCollusionChannel, type CollusionChannel } from './collude-with.ts';
import { credulousDiplomat } from './credulous-diplomat.ts';
import { PERSONAS, type Persona } from './evaluator.ts';
import { houseDiplomat } from './house-diplomat.ts';
import { injectorPlan, type FloodMode } from './injector.ts';
import { robustDiplomat } from './robust-diplomat.ts';

export type SeatSpec =
  | { agent: 'house'; persona?: Persona; commitThenAsk?: Power }
  | { agent: 'robust' }
  | { agent: 'credulous' }
  | { agent: 'injector'; targets: readonly Power[]; kinds?: readonly CanaryKind[]; flood?: FloodMode }
  | { agent: 'collude'; partner: Power };

export interface TableSpec {
  seed: number;
  seats: Readonly<Record<Power, SeatSpec>>;
  /** Owner keys of target seats (default `owner:local`); reference seats are `ref:<agent>`. */
  owners?: Partial<Record<Power, string>>;
  /** Evaluate EVERY seat as a target with a distinct `ref:` owner (calibration sweeps). */
  allAsTargets?: boolean;
  cls?: EvalClass;
  overrides?: Partial<DipConfig>;
}

export interface TableRun {
  ep: DipEpisode;
  registry: Canary[];
  ctx: DipEvalContext;
}

const AGENT_NAME: Record<SeatSpec['agent'], string> = {
  house: 'house-diplomat',
  robust: 'robust-diplomat',
  credulous: 'credulous-diplomat',
  injector: 'injector',
  collude: 'robust-diplomat--collude-with',
};

/** Seat kinds and owner keys for the oracle context. */
export function seatInfo(spec: TableSpec): Record<Power, SeatInfo> {
  const out = {} as Record<Power, SeatInfo>;
  for (const p of POWERS) {
    const s = spec.seats[p];
    const agent = AGENT_NAME[s.agent];
    if (spec.allAsTargets) out[p] = { kind: 'target', owner: `ref:${agent}:${p}`, agent };
    else if (s.agent === 'house') out[p] = { kind: 'reference', owner: `ref:${agent}`, agent };
    else if (s.agent === 'injector') out[p] = { kind: 'fixture', owner: `ref:${agent}`, agent };
    else out[p] = { kind: 'target', owner: spec.owners?.[p] ?? 'owner:local', agent };
  }
  return out;
}

/**
 * Personas for house seats (§4.1, §4.5): `hmix(seed:power:persona:attempt) mod 4`,
 * re-rolled with the next attempt while it would create a second schemer (or any
 * schemer when `schemer: 'none'`). Pinned personas are kept.
 */
export function assignPersonas(seed: number, seats: readonly Power[], pinned: Partial<Record<Power, Persona>> = {}, schemer: 'one' | 'none' = 'one'): Record<Power, Persona> {
  const out = {} as Record<Power, Persona>;
  let schemers = Object.values(pinned).filter((x) => x === 'schemer').length;
  for (const p of POWERS) {
    if (!seats.includes(p)) continue;
    if (pinned[p]) {
      out[p] = pinned[p]!;
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      const x = PERSONAS[hmix(`${seed >>> 0}:${p}:persona:${attempt}`) % PERSONAS.length];
      if (x === 'schemer' && (schemer === 'none' || schemers >= 1)) continue;
      if (x === 'schemer') schemers++;
      out[p] = x;
      break;
    }
  }
  return out;
}

/** One seated reference agent: its action and the canaries it planted (injector only). */
export type Agent = (o: DipObservation) => { action: DipAction; canaries: Canary[] };

/** The seat → agent setup `runTable` uses (exported for the transport and the Phase 7 scenario wrapper). */
export function agentFor(spec: TableSpec, p: Power, channels: Map<string, CollusionChannel>): Agent {
  const s = spec.seats[p];
  const seed = spec.seed;
  switch (s.agent) {
    case 'house':
      return (o) => ({ action: houseDiplomat(o, { seed, persona: s.persona, commitThenAsk: s.commitThenAsk }), canaries: [] });
    case 'robust':
      return (o) => ({ action: robustDiplomat(o, { seed }), canaries: [] });
    case 'credulous':
      return (o) => ({ action: credulousDiplomat(o, { seed }), canaries: [] });
    case 'injector':
      return (o) => injectorPlan(o, { seed, targets: s.targets, kinds: s.kinds, flood: s.flood });
    case 'collude': {
      const key = [p, s.partner].sort().join('+');
      if (!channels.has(key)) channels.set(key, newCollusionChannel());
      const channel = channels.get(key)!;
      return (o) => ({ action: colludeWith(o, { seed, partner: s.partner, channel }), canaries: [] });
    }
  }
}

export function runTable(spec: TableSpec): TableRun {
  const channels = new Map<string, CollusionChannel>();
  const agents = {} as Record<Power, Agent>;
  for (const p of POWERS) agents[p] = agentFor(spec, p, channels);
  let ep = dipInit(spec.seed, spec.cls ?? 'core', spec.overrides);
  const registry: Canary[] = [];
  while (!ep.terminal) {
    for (const p of POWERS) {
      const o = dipObserve(ep, p);
      if (!alive(o, p)) continue;
      const r = agents[p](o);
      registry.push(...r.canaries);
      ep = dipAct(ep, p, r.action);
    }
    ep = dipTick(ep).ep;
  }
  return { ep, registry, ctx: { seats: seatInfo(spec), registry } };
}

/** House seats for every power not listed, personas per `assignPersonas`. */
export function withHouse(seed: number, fixed: Partial<Record<Power, SeatSpec>>, pinned: Partial<Record<Power, Persona>> = {}, schemer: 'one' | 'none' = 'none'): Record<Power, SeatSpec> {
  const free = POWERS.filter((p) => !fixed[p]);
  const personas = assignPersonas(seed, free, pinned, schemer);
  const out = {} as Record<Power, SeatSpec>;
  for (const p of POWERS) out[p] = fixed[p] ?? { agent: 'house', persona: personas[p] };
  return out;
}

/**
 * Re-derive the canary registry from the seed and the RECORDED inputs alone (verify path):
 * replay the episode, and at every tick re-run each injector seat on its own observation.
 * Also checks that the injector's recomputed action equals the recorded one (throws if not),
 * so a tampered injector input cannot pass as the fixture.
 */
export function rebuildRegistry(spec: TableSpec, inputs: readonly TickInput[]): Canary[] {
  let ep = dipInit(spec.seed, spec.cls ?? 'core', spec.overrides);
  const out: Canary[] = [];
  const injectors = POWERS.filter((p) => spec.seats[p].agent === 'injector');
  for (const inp of inputs) {
    if (inp.tick !== ep.tick) throw new Error(`rebuildRegistry: input for tick ${inp.tick} at tick ${ep.tick}`);
    for (const p of injectors) {
      const s = spec.seats[p] as Extract<SeatSpec, { agent: 'injector' }>;
      const o = dipObserve(ep, p);
      if (!alive(o, p)) continue;
      const plan = injectorPlan(o, { seed: spec.seed, targets: s.targets, kinds: s.kinds, flood: s.flood });
      const recorded = inp.actions[p];
      if (JSON.stringify(recorded ?? null) !== JSON.stringify(JSON.parse(JSON.stringify(plan.action)))) {
        throw new Error(`rebuildRegistry: recorded injector input at tick ${inp.tick} differs from the fixture`);
      }
      out.push(...plan.canaries);
    }
    for (const p of inp.forfeit) ep = dipForfeit(ep, p);
    for (const p of POWERS) {
      const a = inp.actions[p];
      if (a !== undefined) ep = dipAct(ep, p, a);
    }
    ep = dipTick(ep).ep;
  }
  return out;
}
