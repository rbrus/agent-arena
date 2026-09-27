/**
 * The only `Peer` implementations in the open core. None runs a model.
 *
 *  - `fakePeer(policy)`: the engine's scripted reference diplomats
 *    (`robust` / `credulous` / `house` / `injector`) THROUGH THE WIRE FRAMES,
 *    i.e. exactly the agent `agent-arena serve-reference` exposes as a local
 *    target: arena-cli's `DiplomacyReferenceAgent` folds each
 *    `diplomacy_observation` frame into its per-episode view and answers with
 *    a `diplomacy_action` frame. Its cost counters are a deterministic
 *    function of the frame sizes (a stand-in for token usage; CHF from a
 *    fixed test price), so the cost meter can be exercised without a model.
 *  - `recordedPeer(record, power)`: replays a seat of a table record, keyed by
 *    `turn_id`; a recorded null (no valid action by Dh) is replayed as a
 *    fault, i.e. a hard miss.
 *  - `throwingPeer()`: fails every decision (or after `after` good ones by
 *    delegating to another peer), for the fault tests.
 *  - `hangingPeer()`: never answers (its answer would arrive after Dh), for
 *    the deadline tests.
 */

import type { DiplomacyActionPayload } from 'arena-scenarios';
import type { Power } from 'wot-engine';
// The served reference target of the CLI (pure: imports only arena-scenarios and wot-engine).
import { DiplomacyReferenceAgent, DIP_DEFAULT_AGENT_SEED, type DipServedPolicy } from '../../arena-cli/src/reference/diplomacy.ts';
import { definePeer, type Peer, type PeerCost, type PeerMeta } from './peer.ts';
import type { TableRecord } from './record.ts';

export type FakePolicy = DipServedPolicy;

/** A fixed test price (CHF per token) for the fake meters. Not a real provider price. */
export const FAKE_PRICE = Object.freeze({ inputChfPerToken: 0.000002, outputChfPerToken: 0.000008 });

export interface FakePeerOptions {
  provider_id?: string;
  model_id?: string;
  region?: string;
  /** Tie-break salt of the served reference agent (default: the engine goldens' seed). */
  agentSeed?: number;
  /** Override the per-decision metered usage (default: bytes / 4 of the frames). */
  usage?: (observationBytes: number, answerBytes: number) => PeerCost;
  prompt_digest?: string;
  connector_version?: string;
}

function mutableMeta(o: { provider_id: string; model_id: string; region: string; prompt_digest?: string; connector_version?: string }): PeerMeta & { cost: PeerCost } {
  return {
    provider_id: o.provider_id,
    model_id: o.model_id,
    region: o.region,
    cost: { input_tokens: 0, output_tokens: 0, chf: 0 },
    ...(o.prompt_digest ? { prompt_digest: o.prompt_digest } : {}),
    ...(o.connector_version ? { connector_version: o.connector_version } : {}),
  };
}

const defaultUsage = (inBytes: number, outBytes: number): PeerCost => {
  const input_tokens = Math.ceil(inBytes / 4);
  const output_tokens = Math.ceil(outBytes / 4);
  return { input_tokens, output_tokens, chf: input_tokens * FAKE_PRICE.inputChfPerToken + output_tokens * FAKE_PRICE.outputChfPerToken };
};

const ENVELOPE = new Set(['t', 'protocol_version', 'episode_id', 'turn_id', 'nonce', 'power']);

/** A scripted reference diplomat behind the `Peer` interface, driven through the wire frames. */
export function fakePeer(policy: FakePolicy, opts: FakePeerOptions = {}): Peer {
  const agent = new DiplomacyReferenceAgent(policy, opts.agentSeed ?? DIP_DEFAULT_AGENT_SEED);
  const meta = mutableMeta({
    provider_id: opts.provider_id ?? 'fake',
    model_id: opts.model_id ?? `${policy}-diplomat`,
    region: opts.region ?? 'local-harness1',
    ...(opts.prompt_digest ? { prompt_digest: opts.prompt_digest } : {}),
    ...(opts.connector_version ? { connector_version: opts.connector_version } : {}),
  });
  const usage = opts.usage ?? defaultUsage;
  return definePeer(meta, async (observation) => {
    const frame = agent.respond(structuredClone(observation) as Record<string, unknown>);
    const inBytes = Buffer.byteLength(JSON.stringify(observation), 'utf8');
    const outBytes = frame ? Buffer.byteLength(JSON.stringify(frame), 'utf8') : 0;
    const u = usage(inBytes, outBytes);
    meta.cost.input_tokens += u.input_tokens;
    meta.cost.output_tokens += u.output_tokens;
    meta.cost.chf += u.chf;
    if (!frame) throw new Error('the reference agent stayed silent');
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(frame)) if (!ENVELOPE.has(k)) payload[k] = v;
    return payload as DiplomacyActionPayload;
  });
}

/** Replay one seat of a table record (moves only; timing is not replayed). */
export function recordedPeer(record: TableRecord, power: Power): Peer {
  const seat = record.seats.find((s) => s.power === power);
  if (!seat) throw new Error(`recordedPeer: ${power} is not a peer seat of table ${record.table_id}`);
  const byTick = new Map<number, DiplomacyActionPayload | null>();
  record.log[power]!.forEach((e, i) => byTick.set(e.tick, record.actions[power]![i] ?? null));
  const meta = mutableMeta({
    provider_id: seat.provider_id,
    model_id: seat.model_id,
    region: seat.region,
    ...(seat.prompt_digest ? { prompt_digest: seat.prompt_digest } : {}),
    ...(seat.connector_version ? { connector_version: seat.connector_version } : {}),
  });
  return definePeer(meta, async (observation) => {
    const p = byTick.get(observation.turn_id);
    if (p === undefined) throw new Error(`recordedPeer: no recorded decision for turn ${observation.turn_id}`);
    if (p === null) throw new Error(`recordedPeer: the recorded decision for turn ${observation.turn_id} had no valid action`);
    return structuredClone(p);
  });
}

export interface ThrowingPeerOptions {
  provider_id?: string;
  model_id?: string;
  region?: string;
  /** Delegate the first `after` decisions to `inner`, then throw. Default 0 (always throws). */
  after?: number;
  inner?: Peer;
  /** Also bill each failed call (a provider error that still costs). */
  chfPerCall?: number;
}

export function throwingPeer(opts: ThrowingPeerOptions = {}): Peer {
  const meta = mutableMeta({ provider_id: opts.provider_id ?? 'fake', model_id: opts.model_id ?? 'throwing', region: opts.region ?? 'local-harness1' });
  let n = 0;
  return definePeer(meta, async (observation, ctx) => {
    n++;
    if (opts.inner && n <= (opts.after ?? 0)) {
      const before = { ...opts.inner.meta.cost };
      const r = await opts.inner(observation, ctx);
      meta.cost.input_tokens += opts.inner.meta.cost.input_tokens - before.input_tokens;
      meta.cost.output_tokens += opts.inner.meta.cost.output_tokens - before.output_tokens;
      meta.cost.chf += opts.inner.meta.cost.chf - before.chf;
      return r;
    }
    meta.cost.chf += opts.chfPerCall ?? 0;
    throw new Error('provider error (fault injection)');
  });
}

/** Never answers before Dh; resolves only when the harness aborts the call. */
export function hangingPeer(opts: { provider_id?: string; model_id?: string } = {}): Peer {
  const meta = mutableMeta({ provider_id: opts.provider_id ?? 'fake', model_id: opts.model_id ?? 'hanging', region: 'local-harness1' });
  return definePeer(meta, (_o, ctx) => new Promise<DiplomacyActionPayload>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ orders: [] }), { once: true })));
}

/** A peer whose cost counter goes backwards on its `at`-th decision (a broken meter). */
export function brokenMeterPeer(inner: Peer, at = 2): Peer {
  const meta = mutableMeta({ provider_id: inner.meta.provider_id, model_id: inner.meta.model_id, region: inner.meta.region });
  let n = 0;
  return definePeer(meta, async (o, c) => {
    n++;
    const r = await inner(o, c);
    meta.cost.input_tokens = inner.meta.cost.input_tokens;
    meta.cost.output_tokens = inner.meta.cost.output_tokens;
    meta.cost.chf = n === at ? 0 : inner.meta.cost.chf;
    return r;
  });
}
