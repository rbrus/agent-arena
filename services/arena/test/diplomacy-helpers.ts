/**
 * Diplomacy test harness: an in-process http.Server carrying the REAL passports
 * routes (registration mints each passport's Ed25519 signing key and returns the
 * private half once) + the arena, whose signing-key resolver is the store-backed
 * one the sandbox uses; and a WSS client that plays an engine reference agent
 * OVER THE WIRE (contract frames in, contract frames out). Not a *.test.ts.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { jwkThumbprint, mintAccessToken, signPressMove, SIGNED_PRESS_MOVES, type Ed25519PrivateJwk, type PassportKeyResolver, type PassportSigningKey } from 'wot-auth';
import { createStores, passportKeyResolver, type Stores } from 'wot-store';
import { dipAgentAlive, dipAgentFor, POWERS, type DipAction, type DipObservation, type DipSeatSpec as EngineSeatSpec, type Power } from 'wot-engine';
import { attachPassportsRoutes, type ArchitectVerifier } from '../../passports/src/index.ts';
import { attachArena, type ArenaHandle } from '../src/index.ts';
import { dipFirstError, dipValidators } from '../src/diplomacy/validators.ts';
import { DipWireView, toWireAction, wireMsgId } from '../src/diplomacy/wire.ts';

export interface DipHarness {
  stores: Stores;
  server: http.Server;
  arena: ArenaHandle;
  /** The store-backed resolver the arena verifies against (the sandbox wiring). */
  keys: PassportKeyResolver;
  /** Base HTTP URL of the passports plane (registration, token). */
  httpUrl: string;
  url: string;
  events: Array<{ event: string; [k: string]: unknown }>;
  close: () => Promise<void>;
}

/**
 * Human-plane auth for the harness: the production path (Bearer Architect
 * token → `ArchitectVerifier` → owner keyed by issuer + architect id), with a
 * verifier that accepts `test-uid-*` tokens. No process-wide dev-auth flag is
 * needed.
 */
export const TEST_ARCHITECT_ISSUER = 'urn:agent-arena:test-harness';
export const testArchitectVerifier: ArchitectVerifier = {
  kind: 'jwt',
  issuer: TEST_ARCHITECT_ISSUER,
  async verify(token: string) {
    if (!/^test-uid-[A-Za-z0-9]{4,40}$/.test(token)) throw new Error('bad test token');
    return { issuer: TEST_ARCHITECT_ISSUER, architectId: token };
  },
};

export async function setupDip(opts: { softMs?: number; hardMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<DipHarness> {
  const stores = createStores();
  const app = express();
  app.disable('x-powered-by');
  attachPassportsRoutes(app, { stores, architectVerifier: testArchitectVerifier });
  const server = http.createServer(app);
  const events: DipHarness['events'] = [];
  const keys = passportKeyResolver(stores.passports);
  const arena = attachArena({
    server,
    stores,
    deadlines: { softMs: 60, hardMs: 250, backfillMs: 60_000, helloTimeoutMs: 10_000, revocationIntervalMs: 100_000 },
    diplomacyDeadlines: { softMs: opts.softMs ?? 20_000, hardMs: opts.hardMs ?? 30_000 },
    signingKeys: keys,
    env: opts.env ?? { WOT_ENV: 'test' },
    logger: (e) => events.push(e as unknown as DipHarness['events'][number]),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    stores,
    server,
    arena,
    keys,
    httpUrl: `http://127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}/v1/arena`,
    events,
    close: async () => {
      await arena.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface DipPassport {
  token: string;
  clientId: string;
  agentId: string;
  ownerId: string;
  /** The key registration returned (private JWK once); null for a key-less fixture passport. */
  signing: PassportSigningKey | null;
  /** The owner's human-plane bearer (test ID token) for rotate/revoke; null for a fixture passport. */
  ownerBearer: string | null;
}

/** Rebuild the `PassportSigningKey` view from the private JWK registration returned. */
export function signingKeyFromRegistration(privateJwk: Ed25519PrivateJwk): PassportSigningKey {
  const { d: _d, ...pub } = privateJwk;
  return { privateJwk, publicJwk: pub, jkt: jwkThumbprint(pub) };
}

let uidSeq = 0;

/**
 * A seat passport. Default: registered through `POST /v1/agents` (the key is
 * minted there; only its public half reaches the store) and a token from
 * `POST /v1/oauth/token` narrowed to `scopes`. `signingKey: false` builds a
 * key-less passport directly in the store (the registration path always mints).
 */
export async function dipPassport(h: DipHarness, opts: { scopes?: string[]; signingKey?: boolean } = {}): Promise<DipPassport> {
  const scopes = opts.scopes ?? ['negotiate:a2a'];
  if (opts.signingKey === false) {
    const ownerId = `own_${'0'.repeat(22)}${Math.floor(Math.random() * 9000 + 1000)}`;
    const p = await h.stores.passports.createPassport({ ownerId, scopes, league: 'core' });
    const token = await mintAccessToken({ ownerId, agentId: p.agentId, clientId: p.clientId, league: 'core', scope: scopes });
    return { token, clientId: p.clientId, agentId: p.agentId, ownerId, signing: null, ownerBearer: null };
  }
  const uid = `test-uid-${process.pid}x${++uidSeq}`;
  const reg = await fetch(`${h.httpUrl}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${uid}` },
    body: JSON.stringify({ display_name: `Seat ${uidSeq}`, league: 'core' }),
  });
  if (reg.status !== 201) throw new Error(`registration failed: ${reg.status} ${await reg.text()}`);
  const body = (await reg.json()) as { client_id: string; client_secret: string; agent_id: string; signing_key: Ed25519PrivateJwk };
  const tok = await fetch(`${h.httpUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: body.client_id, client_secret: body.client_secret, scope: scopes.join(' ') }).toString(),
  });
  if (tok.status !== 200) throw new Error(`token failed: ${tok.status} ${await tok.text()}`);
  const { access_token } = (await tok.json()) as { access_token: string };
  const record = await h.stores.passports.getByClientId(body.client_id);
  return { token: access_token, clientId: body.client_id, agentId: body.agent_id, ownerId: record!.ownerId, signing: signingKeyFromRegistration(body.signing_key), ownerBearer: uid };
}

export const dipHello = (token: string, tableId: string): Record<string, unknown> => ({
  t: 'hello',
  protocol_version: '1.0',
  token,
  scenario_id: 'diplomacy_standard',
  table_id: tableId,
});

type Frame = Record<string, unknown> & { t: string };

/** Seat kinds the reference runner knows (the test-only collude fixture is not exported). */
export type RefSeat = Exclude<EngineSeatSpec, { agent: 'collude' }>;

/** The reference runner's own seat → agent setup (`runTable`), so the wire seat is the same agent. */
export function refAgent(spec: RefSeat, seed: number, power: Power = 'austria'): (o: DipObservation) => DipAction {
  const seats = Object.fromEntries(POWERS.map((p) => [p, spec])) as Record<Power, EngineSeatSpec>;
  const agent = dipAgentFor({ seed, seats }, power, new Map());
  return (o) => agent(o).action;
}

/** The reference runner's liveness rule (agents act only while they hold a unit or a centre). */
const aliveInObs = dipAgentAlive;

/**
 * A seat played by an engine reference agent over the wire. Every inbound frame
 * is validated against the contract schema (errors collected, never thrown);
 * every outbound action too. `sign: 'passport'` replaces the agent's `session`
 * signatures with real detached Ed25519 JWS over the contract payload.
 */
export class DipWireAgent {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly schemaErrors: string[] = [];
  readonly actionSchemaErrors: string[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  observations = 0;
  /** The client's memory of the stream (a wire agent keeps its own window and commitment history). */
  private readonly view = new DipWireView();
  private readonly waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private readonly closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];

  constructor(
    url: string,
    readonly power: Power,
    private readonly agent: ((o: DipObservation) => DipAction) | null,
    private readonly opts: { sign?: 'session' | 'passport'; key?: PassportSigningKey | null; tamper?: (f: Record<string, unknown>) => Record<string, unknown> } = {},
  ) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => this.onMessage(d.toString('utf8')));
    this.ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString('utf8') };
      for (const w of this.closeWaiters.splice(0)) w(this.closeInfo);
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Send exact bytes (byte-cap tests). */
  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  private onMessage(raw: string): void {
    let f: Frame;
    try {
      f = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    this.frames.push(f);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].pred(f)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(f);
      }
    }
    if (f.t === 'diplomacy_observation') {
      this.observations++;
      const turn = String(f.turn_id);
      if (!dipValidators.diplomacy_observation(f)) this.schemaErrors.push(`t${turn} ${dipFirstError('diplomacy_observation')}`);
      const o = this.view.observe(f);
      if (this.agent) this.act(f, o);
    } else if (f.t === 'diplomacy_episode_end') {
      if (!dipValidators.diplomacy_episode_end(f)) this.schemaErrors.push(`end ${dipFirstError('diplomacy_episode_end')}`);
    } else if (f.t === 'ack' && f.ack_type === 'session') {
      // wot:ack:diplomacy:1 (contracts 2.4.0)
      if (!dipValidators.diplomacy_session_ack(f)) this.schemaErrors.push(`session ack ${dipFirstError('diplomacy_session_ack')}`);
    }
  }

  private act(f: Frame, o: DipObservation): void {
    const action = aliveInObs(o, this.power) ? this.agent!(o) : {};
    const step = f.step as { kind: string; round?: number };
    const echo = { episode_id: f.episode_id as string, turn_id: f.turn_id as number, nonce: f.nonce as string, power: this.power, phase: f.phase as string };
    const key = this.opts.key;
    let frame = toWireAction(action, echo, (i, w) => {
      if (this.opts.sign !== 'passport' || !key || !(SIGNED_PRESS_MOVES as readonly string[]).includes(w.move as string)) return undefined;
      return signPressMove(key, {
        episodeId: echo.episode_id,
        msgIdExpected: wireMsgId(echo.phase, step.round ?? 0, this.power, i + 1),
        from: this.power,
        to: w.to,
        move: w.move as string,
        respondTo: (w.respond_to as string | undefined) ?? null,
        terms: w.move === 'offer' || w.move === 'counter' ? w.terms : null,
      });
    });
    if (this.opts.tamper) frame = this.opts.tamper(frame);
    if (!dipValidators.diplomacy_action(frame)) this.actionSchemaErrors.push(`t${echo.turn_id} ${dipFirstError('diplomacy_action')}`);
    this.send(frame);
  }

  waitFor(pred: (f: Frame) => boolean, ms = 60_000): Promise<Frame> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`waitFor timed out (${this.power})`)), ms);
      this.waiters.push({
        pred,
        resolve: (x) => {
          clearTimeout(timer);
          resolve(x);
        },
      });
    });
  }

  waitClose(ms = 60_000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitClose timed out')), ms);
      this.closeWaiters.push((c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export { POWERS };
