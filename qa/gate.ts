/**
 * Phase-1 GATE EVIDENCE harness (Stage C1, sim-qa-engineer).
 *
 *   Run:  WOT_ENV=development WOT_DEV_AUTH=1 npx tsx qa/gate.ts     (from ascension/)
 *
 * Boots the combined dev server (passports REST + gateway REST + arena WSS) on an
 * ephemeral port and drives it ENTIRELY from the OUTSIDE, using only the public
 * surfaces a real Architect's agents have:
 *   - the `agents/lib` client (`registerAgent` / `connectAndPlay`),
 *   - raw `ws` sockets against /v1/arena,
 *   - REST via `fetch`,
 *   - `wot-engine`'s `resimulate` as the REFERENCE verifier (not a server hook).
 *
 * No shared package/service/agent source is modified. Each check prints PASS/FAIL
 * with detail; the process exits non-zero if ANY check fails. See the written
 * report at docs/phase-1/GATE-EVIDENCE.md.
 *
 * Checks (PLAN.md Stage C1 + contracts/README.md Tier-1 + agent-passports §9):
 *   1. End-to-end gate: two passported agents auth -> queue -> full duel ->
 *      both fetch the hash-committed replay; ZERO spurious soft/hard/rate misses.
 *   2. Determinism: resimulate(seed, inputs) reproduces replay_hash bit-for-bit.
 *   3. Fog-of-war: every observation validates + enemy_visible within the
 *      receiver's own vision footprint + no hidden field appears as null.
 *   4. Malicious-agent corpus (raw ws): the documented reject/close for each abuse.
 *   5. Idle liveness: a lone agent is backfilled by the house bot (no lobby hang).
 */

// Fail-closed register needs the explicit dev bypass; the runnable command sets
// it, but default it here so a bare `npx tsx qa/gate.ts` still boots.
if (!process.env.WOT_DEV_AUTH) process.env.WOT_DEV_AUTH = '1';

import net from 'node:net';
import WebSocket from 'ws';
import { validators, maxBytes } from 'wot-contracts';
import type { Observation, MatchEnd } from 'wot-contracts';
import { resimulate } from 'wot-engine';
import type { TickActions } from 'wot-engine';
import { startDevServer, type DevServer } from '../sandbox/index.ts';
import { registerAgent, connectAndPlay, type ClientEvent, type Policy } from '../agents/lib/client.ts';
import { reflexPolicy } from '../agents/reflex/policy.ts';
import { createHunterPolicy } from '../agents/hunter/policy.ts';

// The Core-league soft deadline the arena runs with by default (config.ts). A
// clean match resolves every tick synchronously (setImmediate) far below this,
// so a total wall-clock < softMs is an independent black-box proof that NO tick
// ever fell to the soft timer (each soft miss would add >= softMs of wall-clock).
const SOFT_MS = 1500;

// ─── tiny frame type for raw-ws inspection ───────────────────────────────────
type Frame = Record<string, unknown> & { t?: string; reason?: string };

// ─── result accumulation ─────────────────────────────────────────────────────
interface Sub {
  label: string;
  ok: boolean;
  info?: string;
}
interface CheckResult {
  n: number;
  name: string;
  subs: Sub[];
  numbers: Record<string, string | number>;
  pass: boolean;
  error?: string;
}

class Check {
  private subs: Sub[] = [];
  private numbers: Record<string, string | number> = {};
  constructor(
    readonly n: number,
    readonly name: string,
  ) {}
  sub(label: string, ok: boolean, info?: string): boolean {
    this.subs.push({ label, ok, info });
    return ok;
  }
  num(k: string, v: string | number): void {
    this.numbers[k] = v;
  }
  result(error?: string): CheckResult {
    const pass = !error && this.subs.every((s) => s.ok);
    return { n: this.n, name: this.name, subs: this.subs, numbers: this.numbers, pass, error };
  }
}

// ─── server-log observation (soft_miss/hard_miss counting + noise suppression) ─
// The arena emits soft_miss/hard_miss as structured JSON on stderr (its own
// diagnostics). We passively OBSERVE that stream — no private hook — and suppress
// the (voluminous) structured server logs so the gate's own output stays legible.
const logCounts = { soft_miss: 0, hard_miss: 0, rate_limited: 0 };
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

function tally(s: string): void {
  if (s.includes('"event":"soft_miss"')) logCounts.soft_miss += 1;
  if (s.includes('"event":"hard_miss"')) logCounts.hard_miss += 1;
}
function isServerLog(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith('{') && s.includes('"ts":"') && s.includes('"level":"');
}
function installLogInterceptor(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any, ...rest: any[]): boolean => {
    const s = String(chunk);
    tally(s);
    if (isServerLog(s) && !s.includes('"level":"error"')) return true; // suppress
    return origStderr(chunk, ...rest);
  }) as typeof process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any, ...rest: any[]): boolean => {
    const s = String(chunk);
    tally(s);
    if (isServerLog(s) && !s.includes('"level":"error"')) return true; // suppress
    return origStdout(chunk, ...rest);
  }) as typeof process.stdout.write;
}

// ─── raw WSS harness (the malicious-agent driver) ────────────────────────────
class RawWs {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  readonly opened: Promise<void>;
  private frameWaiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }[] = [];
  private closeWaiters: { resolve: (c: { code: number; reason: string }) => void; timer: NodeJS.Timeout }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e: Error) => reject(e));
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      let f: Frame;
      try {
        f = JSON.parse(data.toString()) as Frame;
      } catch {
        f = { t: '__nonjson__', raw: data.toString() };
      }
      this.frames.push(f);
      for (const w of [...this.frameWaiters]) {
        if (w.pred(f)) {
          clearTimeout(w.timer);
          this.frameWaiters.splice(this.frameWaiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    });
    this.ws.on('close', (code: number, reasonBuf: Buffer) => {
      this.closeInfo = { code, reason: reasonBuf?.toString() ?? '' };
      for (const w of [...this.closeWaiters]) {
        clearTimeout(w.timer);
        w.resolve(this.closeInfo);
      }
      this.closeWaiters = [];
      for (const w of [...this.frameWaiters]) {
        clearTimeout(w.timer);
        // frame waiters that never matched now reject via timeout semantics
      }
    });
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  waitFrame(pred: (f: Frame) => boolean, ms = 5000): Promise<Frame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error('timed out waiting for a matching frame'));
      }, ms);
      this.frameWaiters.push({ pred, resolve, timer });
    });
  }

  waitClose(ms = 8000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for socket close')), ms);
      this.closeWaiters.push({ resolve, timer });
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

// ─── REST helpers (public management plane, via fetch) ───────────────────────
async function mintToken(baseUrl: string, clientId: string, secret: string, scope: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`token mint failed: ${res.status} ${json.error ?? ''}`);
  return json.access_token;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Check state shared across 1 -> 2 -> 3
// ═════════════════════════════════════════════════════════════════════════════
interface ReplayBody {
  replay_id: string;
  match_id: string;
  seed: number;
  replay_hash: string;
  inputs: TickActions[];
  tick_log: unknown[];
  created_at: string;
}
interface E2EArtifacts {
  matchEnd: MatchEnd;
  replay: ReplayBody;
  obsA: Observation[];
  obsB: Observation[];
}

// ─── CHECK 1 — end-to-end gate ───────────────────────────────────────────────
async function check1(baseUrl: string): Promise<{ res: CheckResult; art?: E2EArtifacts }> {
  const c = new Check(1, 'End-to-end gate (auth -> queue -> full duel -> replay; zero spurious misses)');
  try {
    const a = await registerAgent({ baseUrl, displayName: 'Reflex Prime' });
    const b = await registerAgent({ baseUrl, displayName: 'Hunter Prime' });

    const obsA: Observation[] = [];
    const obsB: Observation[] = [];
    let rateRejectsA = 0;
    let rateRejectsB = 0;
    const capReflex: Policy = (o) => {
      obsA.push(o);
      return reflexPolicy(o);
    };
    const hunter = createHunterPolicy();
    const capHunter: Policy = (o) => {
      obsB.push(o);
      return hunter(o);
    };
    const onA = (e: ClientEvent): void => {
      if (e.type === 'reject' && e.reason === 'rate_limited') rateRejectsA += 1;
    };
    const onB = (e: ClientEvent): void => {
      if (e.type === 'reject' && e.reason === 'rate_limited') rateRejectsB += 1;
    };

    const softBefore = logCounts.soft_miss;
    const hardBefore = logCounts.hard_miss;
    const t0 = performance.now();
    const [ra, rb] = await Promise.all([
      connectAndPlay({ baseUrl, clientId: a.clientId, clientSecret: a.clientSecret, policy: capReflex, league: 'core', onEvent: onA }),
      connectAndPlay({ baseUrl, clientId: b.clientId, clientSecret: b.clientSecret, policy: capHunter, league: 'core', onEvent: onB }),
    ]);
    const wallMs = Math.round(performance.now() - t0);
    const softDelta = logCounts.soft_miss - softBefore;
    const hardDelta = logCounts.hard_miss - hardBefore;

    const me = ra.matchEnd;
    const replay = ra.replay as ReplayBody;

    c.num('match_id', me.match_id);
    c.num('replay_id', me.replay_id);
    c.num('ticks_played', me.ticks_played);
    c.num('wall_clock_ms', wallMs);
    c.num('reason', me.reason);
    c.num('winner', me.winner);
    c.num('final_scores', JSON.stringify(me.final_scores));
    c.num('soft_miss', softDelta);
    c.num('hard_miss', hardDelta);
    c.num('rate_limited_rejects', rateRejectsA + rateRejectsB);
    c.num('replay_hash', me.replay_hash);

    c.sub('same match_id both sides', ra.matchEnd.match_id === rb.matchEnd.match_id, ra.matchEnd.match_id);
    c.sub('same replay_id both sides', ra.matchEnd.replay_id === rb.matchEnd.replay_id, ra.matchEnd.replay_id);
    c.sub('both results decisive (win/loss/draw)', ['win', 'loss', 'draw'].includes(ra.result) && ['win', 'loss', 'draw'].includes(rb.result), `${ra.result}/${rb.result}`);
    c.sub('winner consistent across sides', ra.matchEnd.winner === rb.matchEnd.winner, `${ra.matchEnd.winner} == ${rb.matchEnd.winner}`);
    c.sub(
      'result labels complementary',
      me.winner === 'draw'
        ? ra.result === 'draw' && rb.result === 'draw'
        : (ra.result === 'win' && rb.result === 'loss') || (ra.result === 'loss' && rb.result === 'win'),
      `${ra.result}/${rb.result}`,
    );
    c.sub('replay_hash matches ^sha256:[0-9a-f]{64}$', /^sha256:[0-9a-f]{64}$/.test(me.replay_hash), me.replay_hash);
    c.sub('BOTH sides fetched the replay', !!ra.replay && !!rb.replay);
    c.sub('replay body carries seed + inputs', typeof replay.seed === 'number' && Array.isArray(replay.inputs), `seed=${replay.seed} inputs=${replay.inputs?.length}`);
    c.sub('ZERO soft_miss in the clean match', softDelta === 0, `count=${softDelta}`);
    c.sub('ZERO hard_miss in the clean match', hardDelta === 0, `count=${hardDelta}`);
    c.sub('ZERO rate_limited rejects', rateRejectsA + rateRejectsB === 0, `count=${rateRejectsA + rateRejectsB}`);
    c.sub(`wall-clock < softMs (${SOFT_MS}ms) => no tick hit the soft timer`, wallMs < SOFT_MS, `${wallMs}ms`);

    return { res: c.result(), art: { matchEnd: me, replay, obsA, obsB } };
  } catch (err) {
    return { res: c.result((err as Error).message) };
  }
}

// ─── CHECK 2 — determinism (bit-for-bit resim) ───────────────────────────────
function check2(art: E2EArtifacts | undefined): CheckResult {
  const c = new Check(2, 'Determinism — resimulate(seed, inputs) reproduces replay_hash bit-for-bit');
  try {
    if (!art) throw new Error('check 1 did not produce a replay to verify');
    const { matchEnd, replay } = art;
    const resim = resimulate(replay.seed, replay.inputs, { matchId: replay.match_id });

    c.num('seed', replay.seed);
    c.num('committed_replay_hash', matchEnd.replay_hash);
    c.num('recomputed_replay_hash', resim.replayHash);
    c.num('resim_ticks', resim.perTickHashes.length);
    c.num('recorded_ticks', replay.inputs.length);

    c.sub('replay body hash == match_end hash', replay.replay_hash === matchEnd.replay_hash, replay.replay_hash);
    c.sub('recomputed hash == committed hash (BIT-FOR-BIT)', resim.replayHash === matchEnd.replay_hash, `${resim.replayHash}`);
    c.sub('resim tick count == recorded input count', resim.perTickHashes.length === replay.inputs.length, `${resim.perTickHashes.length} == ${replay.inputs.length}`);
    c.sub('resim terminal decided (over)', resim.terminal.over === true, `over=${resim.terminal.over} winner=${resim.terminal.winner ?? 'n/a'}`);
    return c.result();
  } catch (err) {
    return c.result((err as Error).message);
  }
}

// ─── CHECK 3 — fog-of-war leakage (observable contract) ──────────────────────
function nullPaths(v: unknown, path = ''): string[] {
  if (v === null) return [path || '(root)'];
  if (Array.isArray(v)) return v.flatMap((x, i) => nullPaths(x, `${path}[${i}]`));
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, val]) => nullPaths(val, path ? `${path}.${k}` : k));
  }
  return [];
}
// The ONLY schema-sanctioned null in an observation is collapse.next_ring_tick
// (type ["integer","null"] once every ring has corrupted). Everything else that
// is hidden must be ABSENT, never present-but-null (fog contract).
function isAllowedNull(p: string): boolean {
  return p === 'collapse.next_ring_tick';
}

function check3(art: E2EArtifacts | undefined): CheckResult {
  const c = new Check(3, 'Fog-of-war — observation stream validates + enemy_visible within own vision + no hidden nulls');
  try {
    if (!art) throw new Error('check 1 did not produce an observation stream to inspect');
    const all: { side: 'A' | 'B'; obs: Observation }[] = [
      ...art.obsA.map((obs) => ({ side: 'A' as const, obs })),
      ...art.obsB.map((obs) => ({ side: 'B' as const, obs })),
    ];

    let schemaFails = 0;
    let footprintViolations = 0;
    let disallowedNulls = 0;
    let missingVisibleCells = 0;
    let enemySightings = 0;

    for (const { obs } of all) {
      if (!validators.observation(obs)) {
        schemaFails += 1;
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const o = obs as any;
      const enemy: { unit_id: string; cell: [number, number] }[] = o.enemy_visible ?? [];
      enemySightings += enemy.length;

      const vis: [number, number][] | undefined = o.visible_cells;
      if (!vis) {
        missingVisibleCells += 1;
      } else {
        const set = new Set(vis.map((cc) => `${cc[0]},${cc[1]}`));
        for (const ev of enemy) {
          if (!set.has(`${ev.cell[0]},${ev.cell[1]}`)) footprintViolations += 1;
        }
      }

      for (const p of nullPaths(obs)) {
        if (!isAllowedNull(p)) disallowedNulls += 1;
      }
    }

    c.num('observations_checked', all.length);
    c.num('observations_A', art.obsA.length);
    c.num('observations_B', art.obsB.length);
    c.num('enemy_sightings_total', enemySightings);
    c.num('schema_failures', schemaFails);
    c.num('footprint_violations', footprintViolations);
    c.num('disallowed_nulls', disallowedNulls);

    c.sub('all observations validate against the contract schema', schemaFails === 0, `fails=${schemaFails}/${all.length}`);
    c.sub('every enemy_visible unit is inside the receiver visible_cells footprint', footprintViolations === 0, `violations=${footprintViolations}`);
    c.sub('every observation carried visible_cells to cross-check', missingVisibleCells === 0, `missing=${missingVisibleCells}`);
    c.sub('no hidden field appears as null (only collapse.next_ring_tick may be null)', disallowedNulls === 0, `disallowed=${disallowedNulls}`);
    c.sub('observation stream was non-trivial (both sides observed many ticks)', art.obsA.length > 5 && art.obsB.length > 5, `A=${art.obsA.length} B=${art.obsB.length}`);
    return c.result();
  } catch (err) {
    return c.result((err as Error).message);
  }
}

// ─── CHECK 4 — malicious-agent corpus (raw ws) ───────────────────────────────
async function check4(baseUrl: string, arenaUrl: string): Promise<CheckResult> {
  const c = new Check(4, 'Malicious-agent corpus — documented reject/close per abuse (raw ws)');
  const openSockets: RawWs[] = [];
  const track = (r: RawWs): RawWs => {
    openSockets.push(r);
    return r;
  };
  try {
    // 4a. Oversized frame (> action x-max-frame-bytes) -> repeated -> close 4413.
    {
      const s = track(new RawWs(arenaUrl));
      await s.opened;
      const big = JSON.stringify({ t: 'action', pad: 'x'.repeat(maxBytes('action') + 512) });
      for (let i = 0; i < 5; i++) s.send(big);
      const close = await s.waitClose();
      const gotTooLarge = s.frames.some((f) => f.t === 'reject' && f.reason === 'too_large');
      c.sub('oversized frame -> reject too_large + close 4413', gotTooLarge && close.code === 4413, `reject=${gotTooLarge} close=${close.code}`);
    }

    // 4b. Malformed / non-JSON -> reject unparseable + close 4400.
    {
      const s = track(new RawWs(arenaUrl));
      await s.opened;
      s.send('{ this is not valid json');
      const close = await s.waitClose();
      const gotUnparseable = s.frames.some((f) => f.t === 'reject' && f.reason === 'unparseable');
      c.sub('non-JSON frame -> reject unparseable + close 4400', gotUnparseable && close.code === 4400, `reject=${gotUnparseable} close=${close.code}`);
    }

    // 4c. Unknown-field frame -> schema_invalid (retryable, no close).
    {
      const s = track(new RawWs(arenaUrl));
      await s.opened;
      s.send({ t: 'hello', protocol_version: '1.0', token: 'x'.repeat(40), mode: 'duel', bogus_field: 1 });
      const rej = await s.waitFrame((f) => f.t === 'reject');
      c.sub('unknown-field frame -> reject schema_invalid', rej.reason === 'schema_invalid', `reason=${rej.reason}`);
      s.close();
    }

    // 4d/e/f. bad_echo, stale_turn, duplicate_submission — require a live match.
    {
      const m = await registerAgent({ baseUrl, displayName: 'Mal Prime' });
      const co = await registerAgent({ baseUrl, displayName: 'Coop Prime' });
      const mTok = await mintToken(baseUrl, m.clientId, m.clientSecret, 'play:duel spectate:read');
      const cTok = await mintToken(baseUrl, co.clientId, co.clientSecret, 'play:duel spectate:read');
      const M = track(new RawWs(arenaUrl));
      const C = track(new RawWs(arenaUrl));
      await Promise.all([M.opened, C.opened]);
      M.send({ t: 'hello', protocol_version: '1.0', token: mTok, mode: 'duel' });
      await M.waitFrame((f) => f.t === 'ack' && (f as Frame).ack_type === 'session');
      C.send({ t: 'hello', protocol_version: '1.0', token: cTok, mode: 'duel' });
      await C.waitFrame((f) => f.t === 'ack' && (f as Frame).ack_type === 'session');

      // Cooperative side answers every observation with a legal all-Hold so the
      // match stays alive while the misbehaver probes reject reasons.
      C.ws.on('message', (data: WebSocket.RawData) => {
        let f: Frame;
        try {
          f = JSON.parse(data.toString()) as Frame;
        } catch {
          return;
        }
        if (f.t === 'observation') {
          C.send({ t: 'action', protocol_version: '1.0', match_id: f.match_id, turn_id: f.turn_id, nonce: f.nonce, units: [] });
        }
      });

      // obs #1 (turn T0)
      const o1 = await M.waitFrame((f) => f.t === 'observation');
      const t0 = o1.turn_id as number;
      const validA = { t: 'action', protocol_version: '1.0', match_id: o1.match_id, turn_id: t0, nonce: o1.nonce, units: [] };
      M.send(validA);
      await M.waitFrame((f) => f.t === 'ack' && (f as Frame).ack_type === 'action');
      M.send(validA); // duplicate for the same (turn_id, nonce)
      const dup = await M.waitFrame((f) => f.t === 'reject' && f.reason === 'duplicate_submission');
      c.sub('duplicate action for one (turn_id,nonce) -> duplicate_submission', dup.reason === 'duplicate_submission');

      // obs #2 (turn T1) — bad_echo (right turn, wrong nonce)
      const o2 = await M.waitFrame((f) => f.t === 'observation' && (f.turn_id as number) === t0 + 1);
      M.send({ t: 'action', protocol_version: '1.0', match_id: o2.match_id, turn_id: o2.turn_id, nonce: 'wrong_nonce_0001', units: [] });
      const bad = await M.waitFrame((f) => f.t === 'reject' && f.reason === 'bad_echo');
      c.sub('action with wrong nonce -> bad_echo', bad.reason === 'bad_echo');

      // stale_turn — reference the already-resolved T0 while T1 is current
      M.send({ t: 'action', protocol_version: '1.0', match_id: o2.match_id, turn_id: t0, nonce: 'stale_nonce_0001', units: [] });
      const stale = await M.waitFrame((f) => f.t === 'reject' && f.reason === 'stale_turn');
      c.sub('action with stale turn_id -> stale_turn', stale.reason === 'stale_turn');

      M.close();
      C.close();
    }

    // 4g. spectate:read-only token at a play:duel connect -> close 4403.
    {
      const p = await registerAgent({ baseUrl, displayName: 'Spectator Prime' });
      const specTok = await mintToken(baseUrl, p.clientId, p.clientSecret, 'spectate:read');
      const s = track(new RawWs(arenaUrl));
      await s.opened;
      s.send({ t: 'hello', protocol_version: '1.0', token: specTok, mode: 'duel' });
      const close = await s.waitClose();
      const gotAck = s.frames.some((f) => f.t === 'ack');
      c.sub('spectate:read token at play:duel connect -> close 4403 (no session ack)', close.code === 4403 && !gotAck, `close=${close.code} ack=${gotAck}`);
    }

    // 4h. Two concurrent connects on one passport -> second supersedes first.
    {
      const p = await registerAgent({ baseUrl, displayName: 'Solo Prime' });
      const tok = await mintToken(baseUrl, p.clientId, p.clientSecret, 'play:duel spectate:read');
      const s1 = track(new RawWs(arenaUrl));
      await s1.opened;
      s1.send({ t: 'hello', protocol_version: '1.0', token: tok, mode: 'duel' });
      await s1.waitFrame((f) => f.t === 'ack' && (f as Frame).ack_type === 'session');
      const s2 = track(new RawWs(arenaUrl));
      await s2.opened;
      s2.send({ t: 'hello', protocol_version: '1.0', token: tok, mode: 'duel' });
      await s2.waitFrame((f) => f.t === 'ack' && (f as Frame).ack_type === 'session');
      const superseded = await s1.waitFrame((f) => f.t === 'session_superseded');
      const close1 = await s1.waitClose();
      c.sub('second connect supersedes first -> session_superseded + close 4409', superseded.t === 'session_superseded' && close1.code === 4409, `event=${superseded.t} close=${close1.code}`);
      s2.close();
    }

    // 4i. Frame flood beyond the credit/burst budget -> rate_limited + close 4429.
    {
      const s = track(new RawWs(arenaUrl));
      await s.opened;
      for (let i = 0; i < 120; i++) s.send({ t: 'noop_flood', i }); // tiny, un-prompted frames
      const close = await s.waitClose();
      const gotRate = s.frames.some((f) => f.t === 'reject' && f.reason === 'rate_limited');
      c.sub('frame flood beyond burst budget -> rate_limited + close 4429', gotRate && close.code === 4429, `reject=${gotRate} close=${close.code}`);
    }

    return c.result();
  } catch (err) {
    return c.result((err as Error).message);
  } finally {
    for (const s of openSockets) s.close();
  }
}

// ─── CHECK 5 — idle liveness (house-bot backfill) ────────────────────────────
async function check5(baseUrl: string): Promise<CheckResult> {
  const c = new Check(5, 'Idle liveness — a lone agent is backfilled by the house bot (no lobby hang)');
  try {
    const solo = await registerAgent({ baseUrl, displayName: 'Lonely Prime' });
    const t0 = performance.now();
    const r = await connectAndPlay({ baseUrl, clientId: solo.clientId, clientSecret: solo.clientSecret, policy: reflexPolicy, league: 'core' });
    const wallMs = Math.round(performance.now() - t0);

    c.num('wall_clock_ms', wallMs);
    c.num('ticks_played', r.matchEnd.ticks_played);
    c.num('reason', r.matchEnd.reason);
    c.num('result', r.result);

    c.sub('lone agent got matched and reached a decisive match_end', ['win', 'loss', 'draw'].includes(r.result), r.result);
    c.sub('match actually played ticks (not an empty/hung lobby)', r.matchEnd.ticks_played > 0, `ticks=${r.matchEnd.ticks_played}`);
    c.sub('lone agent retrieved the committed replay', !!r.replay, r.matchEnd.replay_id);
    c.sub('replay_hash well-formed', /^sha256:[0-9a-f]{64}$/.test(r.matchEnd.replay_hash), r.matchEnd.replay_hash);
    return c.result();
  } catch (err) {
    return c.result((err as Error).message);
  }
}

// ─── reporting ───────────────────────────────────────────────────────────────
function print(line = ''): void {
  origStdout(line + '\n');
}
function renderCheck(r: CheckResult): void {
  print(`\n[${r.pass ? 'PASS' : 'FAIL'}] Check ${r.n} — ${r.name}`);
  if (r.error) print(`   ERROR: ${r.error}`);
  for (const s of r.subs) print(`   ${s.ok ? 'ok  ' : 'FAIL'} ${s.label}${s.info ? `  (${s.info})` : ''}`);
  const keys = Object.keys(r.numbers);
  if (keys.length) {
    print('   ── numbers ──');
    for (const k of keys) print(`     ${k} = ${r.numbers[k]}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  installLogInterceptor();
  const port = await freePort();
  const server: DevServer = await startDevServer({ port });
  const baseUrl = server.url;
  const arenaUrl = `${baseUrl.replace(/^http/, 'ws')}/v1/arena`;

  print('='.repeat(78));
  print('  Agent Arena — Phase-1 GATE EVIDENCE harness (sim-qa-engineer)');
  print('='.repeat(78));
  print(`  dev server (passports REST + gateway REST + arena WSS): ${baseUrl}`);
  print(`  arena WSS: ${arenaUrl}`);
  print(`  node ${process.version} | WOT_DEV_AUTH=${process.env.WOT_DEV_AUTH}`);

  const results: CheckResult[] = [];
  try {
    const one = await check1(baseUrl);
    results.push(one.res);
    results.push(check2(one.art));
    results.push(check3(one.art));
    // Run idle-liveness BEFORE the malicious corpus so the shared arena queue is
    // guaranteed empty when the lone agent enqueues (no cross-check interference).
    results.push(await check5(baseUrl));
    results.push(await check4(baseUrl, arenaUrl));
  } finally {
    await server.close();
  }

  results.sort((a, b) => a.n - b.n);
  for (const r of results) renderCheck(r);

  const allPass = results.every((r) => r.pass);
  print('\n' + '='.repeat(78));
  print('  RESULTS TABLE');
  print('='.repeat(78));
  for (const r of results) print(`  Check ${r.n}: ${r.pass ? 'PASS' : 'FAIL'}  — ${r.name}`);
  print('='.repeat(78));
  print(`  GATE: ${allPass ? 'PASS — objectively met' : 'FAIL — see failing checks above'}`);
  print('='.repeat(78));

  process.exitCode = allPass ? 0 : 1;
}

main().catch((err) => {
  origStderr(`[gate] FATAL ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
