/**
 * Arena test harness: an in-process http.Server + attached arena, a passport +
 * minted token, and a small WSS client that can auto-play with a policy.
 * (Not a *.test.ts, so the runner does not execute it directly.)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { mintAccessToken } from 'wot-auth';
import { createStores, type Stores } from 'wot-store';
import type { UnitAction } from 'wot-engine';
import type { Observation } from 'wot-contracts';
import { attachArena, type ArenaHandle } from '../src/index.ts';
import type { ConnectLimits, DeadlineConfig } from '../src/config.ts';

export interface Harness {
  stores: Stores;
  server: http.Server;
  arena: ArenaHandle;
  url: string;
  /** Every structured log event the arena emitted (for asserting e.g. zero misses). */
  events: Array<{ event: string; turn_id?: number; [k: string]: unknown }>;
  close: () => Promise<void>;
}

export async function setup(
  deadlines?: Partial<DeadlineConfig>,
  extra?: {
    limits?: Partial<ConnectLimits>;
  },
): Promise<Harness> {
  const stores = createStores();
  const server = http.createServer();
  const events: Harness['events'] = [];
  const arena = attachArena({
    server,
    stores,
    deadlines: {
      softMs: 60,
      hardMs: 250,
      backfillMs: 5000,
      helloTimeoutMs: 5000,
      revocationIntervalMs: 100_000,
      ...(deadlines ?? {}),
    },
    ...(extra?.limits ? { limits: extra.limits } : {}),
    logger: (e) => events.push(e as unknown as Harness['events'][number]),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    stores,
    server,
    arena,
    url: `ws://127.0.0.1:${port}/v1/arena`,
    events,
    close: async () => {
      await arena.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface MintedPassport {
  token: string;
  clientId: string;
  agentId: string;
  ownerId: string;
}

export async function makePassport(
  stores: Stores,
  scopes: string[] = ['play:duel'],
): Promise<MintedPassport> {
  const ownerId = 'own_0000000000000000000000TEST';
  const p = await stores.passports.createPassport({ ownerId, scopes, league: 'core' });
  const token = await mintAccessToken({
    ownerId,
    agentId: p.agentId,
    clientId: p.clientId,
    league: 'core',
    scope: scopes,
  });
  return { token, clientId: p.clientId, agentId: p.agentId, ownerId };
}

/** Create a matchmaking ticket for a passport (mirrors the gateway's POST /v1/queue). */
export async function makeTicket(
  stores: Stores,
  passport: Pick<MintedPassport, 'ownerId' | 'agentId'>,
  league: 'edge' | 'core' | 'frontier' = 'core',
): Promise<string> {
  const ticket = await stores.tickets.createTicket({
    ownerId: passport.ownerId,
    agentId: passport.agentId,
    mode: 'duel',
    league,
  });
  return ticket.ticketId;
}

export function helloFrame(token: string, ticketId?: string): Record<string, unknown> {
  return {
    t: 'hello',
    protocol_version: '1.0',
    token,
    mode: 'duel',
    ...(ticketId ? { ticket_id: ticketId } : {}),
  };
}

type Frame = Record<string, unknown> & { t: string };

export class Client {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  /** Optional hook run on every observation BEFORE the autoplay action (tests). */
  onObs: ((obs: Observation) => void) | null = null;
  private policy: ((obs: Observation) => UnitAction[]) | null = null;
  private readonly waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private readonly closeWaiters: Array<(c: { code: number; reason: string }) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => this.onMessage(d.toString('utf8')));
    this.ws.on('close', (code, reason) => this.onClose(code, reason.toString('utf8')));
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

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  autoplay(policy: (obs: Observation) => UnitAction[]): void {
    this.policy = policy;
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
    if (f.t === 'observation') {
      const obs = f as unknown as Observation;
      this.onObs?.(obs);
      if (this.policy) {
        this.send({
          t: 'action',
          protocol_version: '1.0',
          match_id: obs.match_id,
          turn_id: obs.turn_id,
          nonce: obs.nonce,
          units: this.policy(obs),
        });
      }
    }
  }

  private onClose(code: number, reason: string): void {
    this.closeInfo = { code, reason };
    for (const w of this.closeWaiters.splice(0)) w({ code, reason });
  }

  waitFor(pred: (f: Frame) => boolean, ms = 6000): Promise<Frame> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), ms);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  waitClose(ms = 6000): Promise<{ code: number; reason: string }> {
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
