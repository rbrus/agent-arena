/**
 * The `Peer` contract: the one interface a Neutral Ground seat is played
 * through. Sixi's provider connectors implement it (prompt template, provider
 * call with pinned parameters, defensive parsing, usage accounting); this
 * package ships only scripted implementations (fake-peers.ts) and never runs
 * a model (ADR-001 §4, Pillar 9).
 *
 * A peer is a function from one `diplomacy_observation` frame (the exact wire
 * frame the CLI would send a target, already validated at egress) to one
 * `diplomacy_action` payload (orders | intent | press; the harness adds the
 * envelope and runs the CLI's edge over the result). It carries `meta`: who
 * it is (provider id, model id, inference region) and a CUMULATIVE cost
 * counter the harness reads after every decision.
 *
 * Naming rule (HOSTED-PROFILE §6.3): a peer is named by provider id and model
 * id only. `assertPeerMeta` refuses anything that is not a provider slug, so
 * no country, flag or region label can enter a manifest, a report or a pack
 * through this interface.
 */

import type { DiplomacyActionPayload } from 'arena-scenarios';
import type { Power } from 'wot-engine';

/** Cumulative usage since the peer was created. The harness meters deltas; counters must never decrease. */
export interface PeerCost {
  input_tokens: number;
  output_tokens: number;
  /** Cost in CHF at the price table in force (Sixi-side, versioned). */
  chf: number;
}

export interface PeerMeta {
  /** Provider slug, e.g. `mistral` (episode_result `peer.provider`: ^[a-z0-9][a-z0-9-]{0,39}$). Never a country. */
  readonly provider_id: string;
  /** Model id as the provider API reports it (recorded as `model_reported`, unverified). */
  readonly model_id: string;
  /** Region of the model endpoint the connector calls, e.g. `europe-west6`. */
  readonly region: string;
  /** Live, cumulative. The harness reads it after each decision and at the end of the game. */
  readonly cost: Readonly<PeerCost>;
  /** Optional: digest of the versioned, published prompt template (`sha256:<64 hex>`). */
  readonly prompt_digest?: string;
  /** Optional: connector version, used in the recorded-peer agent id (`<provider>/<model>@<version>`). */
  readonly connector_version?: string;
}

/** What the harness tells a peer about the decision it is asked for. Never the seed, the secret or another seat's view. */
export interface PeerContext {
  readonly table_id: string;
  readonly power: Power;
  readonly turn_id: number;
  /** Soft deadline Ds of the tier (a later answer is applied and counted as a soft miss). */
  readonly deadline_ms: number;
  /** Hard deadline Dh of the tier (a later answer is dropped: hard miss, no retry). */
  readonly hard_deadline_ms: number;
  /** Aborted at Dh; an connector should cancel its provider call. */
  readonly signal: AbortSignal;
}

/** One `diplomacy_observation` wire frame (contracts 2.1.0+), as the CLI sends it to a target. */
export type DiplomacyObservationFrame = Readonly<Record<string, unknown>> & {
  readonly t: 'diplomacy_observation';
  readonly power: Power;
  readonly turn_id: number;
};

/** The interface Sixi's provider connectors implement. */
export type Peer = ((observation: DiplomacyObservationFrame, ctx: PeerContext) => Promise<DiplomacyActionPayload>) & {
  readonly meta: PeerMeta;
};

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const REGION_RE = /^[a-z]{2,12}-[a-z]{2,12}[0-9]{1,2}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

export class PeerMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerMetaError';
  }
}

export function assertCost(c: unknown, where: string): asserts c is PeerCost {
  const o = c as Partial<PeerCost> | null;
  if (!o || typeof o !== 'object') throw new PeerMetaError(`${where}: cost must be an object`);
  for (const k of ['input_tokens', 'output_tokens', 'chf'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new PeerMetaError(`${where}: cost.${k} must be a finite number >= 0`);
  }
}

/** Refuse meta that could not be written into a contract document (or that names anything but a provider). */
export function assertPeerMeta(m: unknown, where = 'peer.meta'): asserts m is PeerMeta {
  const o = m as Partial<PeerMeta> | null;
  if (!o || typeof o !== 'object') throw new PeerMetaError(`${where} must be an object`);
  if (typeof o.provider_id !== 'string' || !PROVIDER_RE.test(o.provider_id)) throw new PeerMetaError(`${where}.provider_id must be a provider slug (^[a-z0-9][a-z0-9-]{0,39}$)`);
  if (typeof o.model_id !== 'string' || !MODEL_RE.test(o.model_id)) throw new PeerMetaError(`${where}.model_id must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$`);
  if (typeof o.region !== 'string' || !REGION_RE.test(o.region)) throw new PeerMetaError(`${where}.region must be a cloud region id like europe-west6`);
  if (o.prompt_digest !== undefined && (typeof o.prompt_digest !== 'string' || !DIGEST_RE.test(o.prompt_digest))) throw new PeerMetaError(`${where}.prompt_digest must be sha256:<64 hex>`);
  if (o.connector_version !== undefined && (typeof o.connector_version !== 'string' || !VERSION_RE.test(o.connector_version))) throw new PeerMetaError(`${where}.connector_version must match ^[0-9A-Za-z.+-]{1,32}$`);
  assertCost(o.cost, `${where}`);
}

/** Build a `Peer` from a decide function and its meta (the shape Sixi's connectors export). */
export function definePeer(meta: PeerMeta, decide: (observation: DiplomacyObservationFrame, ctx: PeerContext) => Promise<DiplomacyActionPayload>): Peer {
  assertPeerMeta(meta);
  const peer = ((o: DiplomacyObservationFrame, c: PeerContext) => decide(o, c)) as Peer;
  Object.defineProperty(peer, 'meta', { value: meta, enumerable: true });
  return peer;
}

/** `provider/model` display id (the only way a peer is ever named). */
export const modelKey = (m: Pick<PeerMeta, 'provider_id' | 'model_id'>): string => `${m.provider_id}/${m.model_id}`;

/** A model id as a contract slug segment (`[a-z0-9][a-z0-9-]{0,39}`). */
export function slug(s: string): string {
  const x = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return x === '' ? 'model' : x;
}
