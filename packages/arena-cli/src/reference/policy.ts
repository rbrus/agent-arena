/**
 * The included reference agents as a TARGET (scripted, deterministic, no
 * model — Pillar 9): given one observation frame, return one action frame.
 * Transport-independent: the REST, WS, MCP and A2A endpoints of
 * `serve-reference` all call `respond()`, which is why the same seeds produce
 * the same replay hashes over every transport (gate criterion 2).
 *
 *   encounters, squad seating  → arena-scenarios `egressSquadDriver` (the
 *                                frozen golden-anchor squads, driven from the
 *                                target-facing egress only)
 *   encounters, member seating → the same joint policy over the one view it
 *                                has (best effort: it cannot see its squad, so
 *                                it does not reproduce the squad anchors)
 *   grid_tactics duel          → coordinated = the reflex floor, naive = the
 *                                null agent (every unit Holds)
 *   diplomacy_standard         → robust / credulous / injector / house over a
 *                                per-episode engine-side view (reference/diplomacy.ts);
 *                                coordinated / naive are aliases of robust / credulous
 *
 * Frames from the arena are still treated as untrusted input here (the
 * server listens on a socket): size-capped upstream, shape-checked, and any
 * surprise yields `null` (the arena records a miss).
 */

import { egressSquadDriver, nullDriver, RAID_SCENARIO_IDS, REFERENCE, reflexDriver, type MemberView, type RaidScenarioId } from 'arena-scenarios';
import type { Observation } from 'wot-contracts';
import { DiplomacyReferenceAgent, DIP_DEFAULT_AGENT_SEED, type DipServedPolicy } from './diplomacy.ts';

export type ReferencePolicy = 'coordinated' | 'naive';
/** What `serve-reference --policy` takes: the Phase 7 pair, or a Diplomacy reference. */
export type ServePolicy = ReferencePolicy | DipServedPolicy;

/** The Diplomacy policy a served policy name stands for (the Phase 7 pair maps onto robust / credulous). */
export function dipPolicyOf(p: ServePolicy): DipServedPolicy {
  return p === 'coordinated' ? 'robust' : p === 'naive' ? 'credulous' : p;
}
const isPhase7 = (p: ServePolicy): p is ReferencePolicy => p === 'coordinated' || p === 'naive';

type SquadDriver = ReturnType<typeof egressSquadDriver>;

const MAX_EPISODES = 256;

export class ReferenceAgent {
  private readonly drivers = new Map<string, SquadDriver>();
  private readonly dip: DiplomacyReferenceAgent;
  decisions = 0;

  constructor(
    readonly policy: ServePolicy,
    /** Restrict to one scenario (`--scenario`); undefined = answer any. */
    readonly scenario?: string,
    /** Diplomacy tie-break salt (reference/diplomacy.ts); default the goldens' seed. */
    agentSeed: number = DIP_DEFAULT_AGENT_SEED,
  ) {
    this.dip = new DiplomacyReferenceAgent(dipPolicyOf(policy), agentSeed);
  }

  private driverFor(episodeId: string, scenario: RaidScenarioId): SquadDriver {
    const key = `${scenario}\u0000${episodeId}`;
    let d = this.drivers.get(key);
    if (!d) {
      if (this.drivers.size >= MAX_EPISODES) this.drivers.delete(this.drivers.keys().next().value!);
      d = egressSquadDriver(scenario, this.policy as ReferencePolicy);
      this.drivers.set(key, d);
    }
    return d;
  }

  /** One observation frame in, one action frame out (or null = stay silent). */
  respond(frame: unknown): Record<string, unknown> | null {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
    const f = frame as Record<string, unknown>;
    if (f.t === 'eval_episode_end' || f.t === 'match_end') {
      for (const k of [...this.drivers.keys()]) if (k.endsWith(`\u0000${String(f.episode_id)}`)) this.drivers.delete(k);
      return { ok: true };
    }
    if (f.t === 'diplomacy_episode_end') {
      this.dip.end(f.episode_id);
      return { ok: true };
    }
    if (f.t === 'diplomacy_observation') {
      if (this.scenario && this.scenario !== 'diplomacy_standard') return null;
      const out = this.dip.respond(f);
      if (out) this.decisions++;
      return out;
    }
    if (!isPhase7(this.policy)) return null;
    if (f.t === 'eval_raid_observation') return this.raid(f);
    if (f.t === 'observation') return this.duel(f as unknown as Observation);
    return null;
  }

  private raid(f: Record<string, unknown>): Record<string, unknown> | null {
    const scenario = f.scenario_id as RaidScenarioId;
    if (!(RAID_SCENARIO_IDS as readonly string[]).includes(scenario)) return null;
    if (this.scenario && this.scenario !== scenario) return null;
    if (typeof f.episode_id !== 'string' || typeof f.nonce !== 'string' || typeof f.turn_id !== 'number') return null;
    const envelope = { t: 'eval_raid_action', protocol_version: '1.0', episode_id: f.episode_id, turn_id: f.turn_id, nonce: f.nonce };
    const drive = this.driverFor(f.episode_id, scenario);
    this.decisions++;
    if (f.mode === 'squad' && Array.isArray(f.views) && f.views.length >= 1 && f.views.length <= 5) {
      return { ...envelope, members: drive(f.views as MemberView[], f.turn_id) };
    }
    if (f.mode === 'member' && f.view && typeof f.view === 'object') {
      const me = (f.view as MemberView).member_id;
      let units: unknown[] = [];
      try {
        units = drive([f.view as MemberView], f.turn_id)[me] ?? [];
      } catch {
        units = [];
      }
      return { ...envelope, units };
    }
    return null;
  }

  private duel(obs: Observation): Record<string, unknown> | null {
    if (this.scenario && this.scenario !== 'grid_tactics') return null;
    if (typeof obs.match_id !== 'string' || typeof obs.nonce !== 'string' || typeof obs.turn_id !== 'number') return null;
    this.decisions++;
    const units = this.policy === 'coordinated' ? reflexDriver(obs) : nullDriver(obs);
    return { t: 'action', protocol_version: '1.0', match_id: obs.match_id, turn_id: obs.turn_id, nonce: obs.nonce, units };
  }
}

/**
 * The policy each scenario's reference pair names (for `list-scenarios` and the
 * server banner): raids read arena-scenarios' REFERENCE table (so a renamed
 * reference such as `orderedLockSquad.disciplined` is picked up), the duel pair
 * is the CLI's reflex / null. Scenarios without a Phase-7 pair are absent.
 */
export function referenceNames(): Record<string, { coordinated: string; naive: string }> {
  const out: Record<string, { coordinated: string; naive: string }> = { grid_tactics: { coordinated: 'reflex', naive: 'null' } };
  for (const id of RAID_SCENARIO_IDS) out[id] = { coordinated: REFERENCE[id].coordinated.name, naive: REFERENCE[id].naive.name };
  return out;
}
