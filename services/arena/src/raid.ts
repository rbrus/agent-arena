/**
 * The raid arena: the co-op raid lobby (`POST /v1/raids/queue`, `GET
 * /v1/raids/bosses`, `GET /v1/raids/{id}`, `GET /v1/squads/{id}`) + the raid WSS
 * play channel on `/v1/raid`. Each squad member connects on its OWN delegated
 * child token (raid_hello → `verifyDelegatedChild` → raid_observation/raid_action
 * loop → raid_end). Additive alongside the duel arena; nothing here trusts the
 * client — every frame is AJV-validated + size-capped at the edge (B1's seam does
 * the auth). See docs/design/raids-v1.md and docs/security/delegated-squad-tokens.md.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { raidMaxBytes, raidValidators } from 'wot-contracts';
import { verifyAccessToken } from 'wot-auth';
import { newId, type League, type Stores } from 'wot-store';
import { BOSS_CATALOG, REFERENCE_COMP, type BossId } from 'wot-engine';
import { CLOSE } from './config.ts';
import { verifyDelegatedChild, registryKeyFor } from './delegation.ts';
import { defaultLogger, makeLog, type Logger } from './log.ts';
import { RaidMatch, type RaidSlot } from './raidmatch.ts';

export const RAID_PATH = '/v1/raid';
const MAX_SQUAD = 5;

interface PendingRaid {
  raidId: string;
  squadId: string;
  bossId: BossId;
  league: League;
  seed: number;
  ownerId: string;
  ticketId: string;
  slots: RaidSlot[];
  createdAt: string;
}

export interface RaidQueueResult {
  ok: boolean;
  status: number;
  ticket?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface AttachRaidArenaOptions {
  server: HttpServer;
  stores: Stores;
  arenaBaseUrl?: string;
  softMs?: number;
  hardMs?: number;
  /** Fixed seed for all raids (tests); default random per raid. */
  raidSeed?: number;
  logger?: Logger;
}

export interface RaidArenaHandle {
  /** POST /v1/raids/queue — form a 5-slot squad from delegated tokens → RaidTicket. */
  queueRaid(req: {
    squad_id?: string;
    boss_id?: string;
    league?: string;
    delegated_tokens?: string[];
  }): Promise<RaidQueueResult>;
  /** GET /v1/raids/bosses — the boss catalog. */
  bosses(): { bosses: unknown[] };
  /** GET /v1/raids/{raid_id} — the raid summary (post-hoc). */
  getRaidSummary(raidId: string): Promise<unknown | null>;
  /** GET /v1/squads/{squad_id} — the lobby squad. */
  getSquad(squadId: string): unknown | null;
  close(): Promise<void>;
}

interface RaidSessionCtx {
  ws: WebSocket;
  authed: boolean;
  registryKey?: string;
  slot?: number;
  raidId?: string;
  schemaInvalid: number;
}

/** Attach the raid lobby + WSS play channel to `server`. */
export function attachRaidArena(opts: AttachRaidArenaOptions): RaidArenaHandle {
  const { server, stores } = opts;
  const log = makeLog(opts.logger ?? defaultLogger);
  const softMs = opts.softMs ?? 1500;
  const hardMs = opts.hardMs ?? 3000;

  const wsOrigin = (opts.arenaBaseUrl ?? 'ws://127.0.0.1')
    .replace(/\/+$/, '')
    .replace(/\/v1\/(arena|spectate|raid)$/, '');
  const arenaUrl = `${wsOrigin}${RAID_PATH}`;

  const pendingBySquad = new Map<string, PendingRaid>();
  const pendingByRaid = new Map<string, PendingRaid>();
  const matches = new Map<string, RaidMatch>();
  const sessions = new Map<string, RaidSessionCtx>(); // registryKey -> ctx
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });

  // ---- lobby: queue ----
  const queueRaid: RaidArenaHandle['queueRaid'] = async (req) => {
    const squadId = req.squad_id;
    const bossId = (req.boss_id ?? '') as BossId;
    const tokens = req.delegated_tokens ?? [];
    if (!squadId || !/^sqd_[0-9A-HJKMNP-TV-Z]{26}$/.test(squadId)) {
      return { ok: false, status: 422, error: { code: 'invalid_squad', message: 'squad_id missing or malformed' } };
    }
    if (!(bossId in BOSS_CATALOG)) {
      return { ok: false, status: 422, error: { code: 'unknown_boss', message: 'unknown boss_id' } };
    }
    if (tokens.length < 1 || tokens.length > MAX_SQUAD) {
      return { ok: false, status: 422, error: { code: 'bad_roster', message: '1..5 delegated tokens required' } };
    }

    // Each token MUST bind (via its delegation claim) to this squad_id, or 422.
    const slots: RaidSlot[] = [];
    const seenSlots = new Set<number>();
    let ownerId = '';
    for (const token of tokens) {
      let claims;
      try {
        claims = await verifyAccessToken(token);
      } catch {
        return { ok: false, status: 422, error: { code: 'token_invalid', message: 'a delegated token failed verification' } };
      }
      const d = claims.delegation;
      if (!d || d.squad_id !== squadId) {
        return { ok: false, status: 422, error: { code: 'token_not_bound', message: 'a token is not bound to this squad_id' } };
      }
      if (!claims.scopes.includes('play:raid')) {
        return { ok: false, status: 422, error: { code: 'insufficient_scope', message: 'a token lacks play:raid' } };
      }
      if (seenSlots.has(d.slot)) {
        return { ok: false, status: 422, error: { code: 'duplicate_slot', message: 'two tokens share a squad slot' } };
      }
      seenSlots.add(d.slot);
      ownerId = claims.owner_id;
      const engineMember = `m${d.slot - 1}`;
      const type = REFERENCE_COMP[(d.slot - 1) % REFERENCE_COMP.length];
      slots.push({
        slot: d.slot,
        memberId: d.member_id,
        agentId: d.parent_agent_id, // the reward accrues to the parent owner (§5.4)
        ownerId: claims.owner_id,
        displayName: `Agent ${claims.agent_id.slice(4, 12)}`,
        engineMember,
        unitId: `${engineMember}-${type}`,
      });
    }

    const raidId = newId('rad');
    const ticketId = newId('tkt');
    const seed = opts.raidSeed ?? randomInt(1, 2 ** 31 - 1);
    const league = ((req.league as League) ?? 'core') as League;
    const pending: PendingRaid = {
      raidId,
      squadId,
      bossId,
      league,
      seed,
      ownerId,
      ticketId,
      slots: slots.sort((a, b) => a.slot - b.slot),
      createdAt: new Date().toISOString(),
    };
    pendingBySquad.set(squadId, pending);
    pendingByRaid.set(raidId, pending);

    // Bind the raid to the squad's grant (best-effort) so children may enter it.
    const grantId = (await verifyAccessToken(tokens[0])).delegation?.grant_id;
    if (grantId) {
      const grant = await stores.delegations.getGrant(grantId);
      if (grant && !grant.raidId) {
        await stores.delegations
          .openOrGet({
            squadId,
            raidId,
            parentClientId: grant.parentClientId,
            parentAgentId: grant.parentAgentId,
            ownerId: grant.ownerId,
            scopes: grant.scopes,
            ttlSeconds: 3600,
          })
          .catch(() => undefined);
      }
    }

    log({ event: 'raid_queued', match_id: raidId, detail: { squad: squadId, boss: bossId, members: slots.length } });
    return {
      ok: true,
      status: 200,
      ticket: {
        ticket_id: ticketId,
        raid_id: raidId,
        squad_id: squadId,
        boss_id: bossId,
        league,
        status: 'matched',
        arena_url: arenaUrl,
        members: pending.slots.map((s) => ({ member_id: s.memberId, slot: s.slot })),
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        seed, // convenience for a coordinating client / the gate demo (not in the schema)
      },
    };
  };

  const matchFor = (pending: PendingRaid): RaidMatch => {
    let m = matches.get(pending.raidId);
    if (!m) {
      m = new RaidMatch({
        raidId: pending.raidId,
        seed: pending.seed,
        bossId: pending.bossId,
        league: pending.league,
        ownerId: pending.ownerId,
        squadId: pending.squadId,
        slots: pending.slots,
        softMs,
        hardMs,
        stores,
        log,
        onEnd: (raidId) => {
          matches.delete(raidId);
        },
      });
      matches.set(pending.raidId, m);
    }
    return m;
  };

  // ---- WSS upgrade routing (only our path) ----
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== RAID_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  const send = (ws: WebSocket, frame: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };

  const handleHello = async (ctx: RaidSessionCtx, obj: Record<string, unknown>): Promise<void> => {
    const squadId = typeof obj.squad_id === 'string' ? obj.squad_id : undefined;
    const memberId = typeof obj.member_id === 'string' ? obj.member_id : undefined;
    const raidId = typeof obj.raid_id === 'string' ? obj.raid_id : undefined;
    const token = typeof obj.token === 'string' ? obj.token : '';

    // B1's seam authenticates the child token + the squad/member/raid binding.
    const verdict = await verifyDelegatedChild(stores, { token, squadId, memberId, raidId });
    if (!verdict.ok) {
      log({ event: 'raid_hello_denied', code: verdict.code, reason: verdict.reason });
      try {
        ctx.ws.close(verdict.code, verdict.reason);
      } catch {
        /* ignore */
      }
      return;
    }
    const d = verdict.delegation;
    const pending = pendingBySquad.get(d.squad_id);
    if (!pending) {
      try {
        ctx.ws.close(CLOSE.NOT_LIVE, 'squad has not queued a raid');
      } catch {
        /* ignore */
      }
      return;
    }
    const slot = pending.slots.find((s) => s.slot === d.slot);
    if (!slot) {
      try {
        ctx.ws.close(CLOSE.FORBIDDEN, 'slot not in this raid');
      } catch {
        /* ignore */
      }
      return;
    }

    // One session per (squad_id, slot): supersede any prior holder of the key.
    const key = registryKeyFor(verdict.claims);
    const prior = sessions.get(key);
    if (prior && prior !== ctx) {
      try {
        prior.ws.close(CLOSE.SUPERSEDED, 'session superseded');
      } catch {
        /* ignore */
      }
    }
    ctx.authed = true;
    ctx.registryKey = key;
    ctx.slot = slot.slot;
    ctx.raidId = pending.raidId;
    sessions.set(key, ctx);

    const match = matchFor(pending);
    match.attach(slot.slot, {
      send: (frame) => send(ctx.ws, frame),
      close: (code, reason) => {
        try {
          ctx.ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
    });

    send(ctx.ws, {
      t: 'raid_ack',
      ack_type: 'session',
      session_id: newId('ses'),
      mode: 'raid',
      squad_id: d.squad_id,
      member_id: slot.memberId,
      slot: slot.slot,
      league: pending.league,
      raid_id: pending.raidId,
      boss_id: pending.bossId,
      config: { soft_deadline_ms: softMs, hard_deadline_ms: hardMs, action_allowance: 240, tick_cap: 120, squad_size: pending.slots.length },
    });
    log({ event: 'raid_session_bound', match_id: pending.raidId, detail: { slot: slot.slot } });

    if (match.allConnected()) {
      log({ event: 'raid_squad_ready', match_id: pending.raidId });
      match.start();
    }
  };

  const handleMessage = async (ctx: RaidSessionCtx, data: RawData): Promise<void> => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > raidMaxBytes('raid_action')) {
      send(ctx.ws, { t: 'reject', reason: 'too_large', hint: 'frame exceeds byte cap' });
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      try {
        ctx.ws.close(CLOSE.MALFORMED, 'unparseable frame');
      } catch {
        /* ignore */
      }
      return;
    }
    const t = (obj as { t?: unknown }).t;
    if (t === 'raid_hello') {
      if (ctx.authed) {
        send(ctx.ws, { t: 'reject', reason: 'unknown_frame', hint: 'already authenticated' });
        return;
      }
      if (!raidValidators.raid_hello(obj)) {
        try {
          ctx.ws.close(CLOSE.MALFORMED, 'raid_hello schema_invalid');
        } catch {
          /* ignore */
        }
        return;
      }
      await handleHello(ctx, obj as Record<string, unknown>);
      return;
    }
    if (t === 'raid_action') {
      if (!ctx.authed || ctx.slot === undefined || !ctx.raidId) {
        send(ctx.ws, { t: 'reject', reason: 'no_active_match', hint: 'no live raid on this session' });
        return;
      }
      if (!raidValidators.raid_action(obj)) {
        ctx.schemaInvalid += 1;
        send(ctx.ws, { t: 'reject', reason: 'schema_invalid', hint: 'raid_action failed schema validation', turn_id: (obj as { turn_id?: number }).turn_id ?? null });
        if (ctx.schemaInvalid >= 5) {
          try {
            ctx.ws.close(CLOSE.MALFORMED, 'repeated schema_invalid');
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const match = matches.get(ctx.raidId);
      if (!match) {
        send(ctx.ws, { t: 'reject', reason: 'no_active_match', hint: 'raid not live' });
        return;
      }
      const f = obj as { turn_id: number; nonce: string; member_id: string; units: unknown[] };
      const res = match.submitAction(ctx.slot, f);
      if (!res.ok) send(ctx.ws, { t: 'reject', reason: res.reason ?? 'rejected', turn_id: f.turn_id });
      return;
    }
    send(ctx.ws, { t: 'reject', reason: 'unknown_frame', hint: `unrecognized frame type: ${String(t)}` });
  };

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    const ctx: RaidSessionCtx = { ws, authed: false, schemaInvalid: 0 };
    ws.on('message', (data: RawData) => {
      void handleMessage(ctx, data).catch((err) => log({ event: 'handler_error', detail: { message: (err as Error).message } }));
    });
    ws.on('close', () => {
      sockets.delete(ws);
      if (ctx.registryKey && sessions.get(ctx.registryKey) === ctx) sessions.delete(ctx.registryKey);
    });
    ws.on('error', () => {
      /* surfaces as a close */
    });
  });

  const handle: RaidArenaHandle = {
    queueRaid,
    bosses: () => ({ bosses: Object.values(BOSS_CATALOG) }),
    getRaidSummary: async (raidId) => {
      const summary = await stores.matches.getSummary(raidId);
      if (summary) return summary;
      const pending = pendingByRaid.get(raidId);
      return pending
        ? { raid_id: raidId, squad_id: pending.squadId, boss_id: pending.bossId, status: 'pending', members: pending.slots.map((s) => ({ member_id: s.memberId, result: 'survived' })) }
        : null;
    },
    getSquad: (squadId) => {
      const pending = pendingBySquad.get(squadId);
      if (!pending) return null;
      return {
        squad_id: squadId,
        raid_id: pending.raidId,
        boss_id: pending.bossId,
        league: pending.league,
        status: 'queued',
        members: pending.slots.map((s) => ({ member_id: s.memberId, slot: s.slot, connected: sessions.has(`${squadId}:${s.slot}`) })),
        created_at: pending.createdAt,
      };
    },
    close: async () => {
      server.removeListener('upgrade', onUpgrade);
      for (const m of [...matches.values()]) m.forceClose(1012);
      for (const ws of [...sockets]) {
        try {
          ws.close(1012, 'arena draining');
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
  return handle;
}
