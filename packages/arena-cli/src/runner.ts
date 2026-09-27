/**
 * The episode runner: the engine runs IN-PROCESS (no arena server), the runner
 * owns the clock, the episode id, the per-decision nonce and the blinding key,
 * and the target is reached through one Transport. Per decision:
 *
 *   observe → frame (edge.ts) → transport.decide(…, t0 + Dh) → edge.ts parse
 *   (size, JSON, frame type, protocol, schema, echo) → Scenario.act → tick
 *
 * Target bytes never reach the engine except as a Submission produced by
 * arena-scenarios' edge parser; wall time enters only as data (latencyMs).
 * A timeout is a hard miss; a refused / garbled answer is a rejected
 * submission; the units Hold either way. The episode record (inputs + timing)
 * is what `verify` and `replay` re-simulate. For diplomacy_standard the record
 * DOES carry target press (it is an engine input): redacted here at the edge,
 * before `act()` (G-40), and written inert (G-36, inert.ts).
 */

import {
  createScenario,
  diplomacyEpisodeEndFrame,
  diplomacyObservationFrame,
  duelObservationFrame,
  evalEpisodeEndFrame,
  evalRaidObservationFrame,
  newBlindingKey,
  parseDiplomacyActionFrame,
  parseDuelActionFrame,
  parseEvalRaidActionFrame,
  tierOf,
  toEpisodeResult,
  type EpisodeRecord,
  type DiplomacyObservationBody,
  type EvalRaidObservationBody,
  type PowerSeat,
  type Scenario,
  type ScenarioId,
  type SeatId,
  type Submission,
  type TargetDriver,
  type TierId,
} from 'arena-scenarios';
import type { Observation } from 'wot-contracts';
import { attestLocalSignatures, DIP_PRESS_REDACTION_MARKER, DIPLOMACY, redactPressText, type DipRunOptions } from './diplomacy.ts';
import { CliError, describeError, runError } from './errors.ts';
import { newEpisodeId, newNonce } from './ids.ts';
import { replayRefFor } from './files.ts';

/** Output file stem: report.json, report.sarif, report.episode-<n>.{replay,record}.json. */
export const REPORT_BASE = 'report';
import { NetBlockedError } from './net/index.ts';
import type { EpisodeResult } from './report.ts';
import type { Answer, Transport } from './transports/index.ts';
import { info, targetText, warn, writeStderr } from './ui.ts';

export interface EpisodePlan {
  index: number;
  scenarioId: ScenarioId;
  seed: number;
  tier: TierId;
  mode: 'duel' | 'squad' | 'member' | 'power';
  /** duel A|B, member m0..m4, squad, or (power) a power or `auto`. */
  seat: SeatId;
  fill?: 'coordinated' | 'naive';
  /** diplomacy_standard only: table fill, horizon (always explicit) and the episode secret ('' locally). */
  diplomacy?: DipRunOptions;
  engineCommit: string;
  /** Where the episode's replay file goes, relative to the report (default `report.episode-<n>.replay.json`; hosted: `episodes/<n>.replay.json`). */
  replayRef?: string;
}

export interface EpisodeOutcome {
  result: EpisodeResult;
  record: EpisodeRecord;
}

/** Consecutive 401/403 answers after which the run aborts (threat model M-3: never retry auth). */
export const AUTH_ABORT_AFTER = 3;

export interface TargetRunState {
  /** Any answer at all (frame or HTTP status) received from the target during this run. */
  everAnswered: boolean;
  authFailuresInARow: number;
  /** One warning per kind per run, so a hostile target cannot flood the terminal. */
  warned: Set<string>;
  /** `performance.now()` before which no request goes out (the target's Retry-After). */
  pauseUntil: number;
  /** The longest Retry-After the run honours; a longer one aborts the run (G-23). */
  maxRetryAfterMs: number;
  deadlineWarnings: number;
  /** diplomacy_standard: credential-shaped spans of target press replaced at the edge (G-40). */
  pressRedactions: number;
}

/** Default and ceiling for `--max-retry-after` (seconds). */
export const DEFAULT_MAX_RETRY_AFTER_S = 30;
export const MAX_RETRY_AFTER_CAP_S = 3600;

export function newTargetRunState(o: { maxRetryAfterMs?: number } = {}): TargetRunState {
  return { everAnswered: false, authFailuresInARow: 0, warned: new Set(), pauseUntil: 0, maxRetryAfterMs: o.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_S * 1000, deadlineWarnings: 0, pressRedactions: 0 };
}

/** A2A: poll interval for a task that is still working (a2a.ts). */
export const A2A_POLL_MS = 50;

/**
 * The most requests one run can send (threat model §8.1), printed before the
 * first request: every decision is one request (one frame on ws), plus the
 * best-effort terminal notice per episode, plus the transport handshake.
 * A2A adds at most one `tasks/get` poll per 50 ms while a task is working.
 */
export function requestCeiling(transport: string, tier: TierId, episodes: number): { requests: number; decisionsPerEpisode: number; extra?: string } {
  const t = tierOf(tier);
  const decisionsPerEpisode = t.tickCap;
  const perEpisode = decisionsPerEpisode + 1; // + eval_episode_end
  let requests = episodes * perEpisode;
  let extra: string | undefined;
  if (transport === 'mcp') {
    requests += 4; // initialize, notifications/initialized, tools/list, DELETE
    extra = 'plus 4 MCP session requests';
  } else if (transport === 'a2a') {
    const polls = Math.floor(t.hardDeadlineMs / A2A_POLL_MS);
    requests = 1 + episodes * perEpisode * (1 + polls);
    extra = `incl. the agent card and ≤ ${polls} tasks/get polls per decision while a task is working`;
  } else if (transport === 'ws') {
    extra = 'as WebSocket frames, one connection per episode';
  }
  return { requests, decisionsPerEpisode, extra };
}

function initScenario(p: EpisodePlan, blindingKey: string, targetDriver: TargetDriver = 'external'): Scenario {
  const scn = createScenario(p.scenarioId);
  if (p.mode === 'power') {
    const d = p.diplomacy;
    if (!d) throw new Error('a power-mode plan needs its diplomacy options');
    // The horizon is ALWAYS passed (RunSpec default 1906); the engine's own default (1908) is never relied on.
    scn.init(p.seed, p.tier, {
      mode: 'power',
      targetSeat: p.seat,
      targetDriver,
      blindingKey,
      engineCommit: p.engineCommit,
      diplomacy: { fill: d.fill, horizonYear: d.horizonYear, secret: d.secret },
    });
    return scn;
  }
  scn.init(p.seed, p.tier, {
    mode: p.mode,
    ...(p.mode === 'squad' ? {} : { targetSeat: p.seat }),
    ...(p.mode === 'member' && p.fill ? { fill: p.fill } : {}),
    targetDriver,
    blindingKey,
    engineCommit: p.engineCommit,
  });
  return scn;
}

function warnOnce(st: TargetRunState, key: string, line: string, detail?: string): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  warn(line);
  if (detail) writeStderr(`${targetText(detail)}\n`);
}

type FrameKind = 'duel' | 'raid' | 'diplomacy';

/** Map a transport answer to a Submission via the edge parser (the only path from target bytes to the engine). */
function toSubmission(
  a: Answer,
  kind: FrameKind,
  expect: { id: string; turnId: number; nonce: string; power?: PowerSeat },
  latencyMs: number,
  st: TargetRunState,
  transport: string,
): Submission {
  switch (a.kind) {
    case 'frame':
      st.everAnswered = true;
      st.authFailuresInARow = 0;
      if (kind === 'diplomacy') return attested(parseDiplomacyActionFrame(a.raw, { episodeId: expect.id, turnId: expect.turnId, nonce: expect.nonce, power: expect.power! }, latencyMs), st, transport);
      return kind === 'duel' ? parseDuelActionFrame(a.raw, expect, latencyMs) : parseEvalRaidActionFrame(a.raw, expect, latencyMs);
    case 'too_large':
      st.everAnswered = true;
      st.authFailuresInARow = 0;
      return { kind: 'rejected', reason: 'too_large', latencyMs, frameBytes: a.bytes };
    case 'timeout':
      return { kind: 'miss', severity: 'hard' };
    case 'refused': {
      st.everAnswered = true;
      if (a.why === 'auth') {
        st.authFailuresInARow++;
        warnOnce(st, 'auth', `the target refused the credentials (HTTP ${a.status ?? '?'}) over ${transport}`, a.detail);
        if (st.authFailuresInARow >= AUTH_ABORT_AFTER) {
          throw runError(
            `the target answered HTTP ${a.status ?? '401/403'} ${AUTH_ABORT_AFTER} times in a row over ${transport}; the arena never retries authentication.`,
            'check --auth (and --auth-header) against what your agent expects, then run again.',
          );
        }
      } else st.authFailuresInARow = 0;
      if (a.why === 'rate_limited') {
        if (a.retryAfterMs !== undefined && a.retryAfterMs > st.maxRetryAfterMs) {
          // Never hammer (threat model §8.1, G-23): a wait longer than the cap ends the run instead.
          throw runError(
            `the target asked the arena to wait ${Math.ceil(a.retryAfterMs / 1000)} s (HTTP ${a.status ?? 429}, Retry-After) over ${transport}, longer than the ${Math.round(st.maxRetryAfterMs / 1000)} s the run honours; stopping rather than sending inside that window.`,
            'raise the rate limit your agent applies to the arena, lower --max-rps, or pass --max-retry-after <seconds> (max 3600) to wait it out.',
          );
        }
        if (a.retryAfterMs !== undefined) st.pauseUntil = Math.max(st.pauseUntil, performance.now() + a.retryAfterMs);
        warnOnce(st, 'rate', `the target is rate-limiting the arena (HTTP ${a.status ?? 429}); no request is sent until its Retry-After has passed (honoured up to ${Math.round(st.maxRetryAfterMs / 1000)} s, --max-retry-after)`);
        return { kind: 'rejected', reason: 'rate_limited', latencyMs, frameBytes: null };
      }
      warnOnce(st, `refused:${a.why}`, `the target answered without an action frame over ${transport} (${a.why}${a.status ? `, HTTP ${a.status}` : ''}); the decision is recorded as rejected and the units Hold`, a.detail);
      return { kind: 'rejected', reason: 'unparseable', latencyMs, frameBytes: null };
    }
    case 'unreachable':
      throw a.error;
  }
}

/**
 * The edge steps between the parser and `act()` for a Diplomacy action:
 *  1. local signature attestation (diplomacy.ts): no wire signature byte reaches the
 *     engine. `session` passes; anything else becomes the fixed sentinel the engine
 *     refuses as `signature_invalid`;
 *  2. press redaction (G-40): credential-shaped text and registered secrets become
 *     `[redact]` BEFORE the engine reads them, so the engine input and the record
 *     are the same bytes and the report stays verifiable. Counted per run
 *     (`arena.press_redactions`).
 */
function attested(sub: Submission, st: TargetRunState, transport: string): Submission {
  if (sub.kind !== 'action') return sub;
  const r = attestLocalSignatures(sub.payload as Record<string, unknown>);
  if (r.replaced) {
    warnOnce(
      st,
      'dip-signature',
      `the target signed press with something other than \`session\` over ${transport}; a local run holds no passport keys and cannot verify it, so those messages are refused (signature_invalid) and the signature bytes are not recorded`,
    );
  }
  const red = redactPressText(r.payload);
  if (red.replaced) {
    st.pressRedactions += red.replaced;
    warnOnce(
      st,
      'dip-redaction',
      `the target's action over ${transport} contained credential-shaped text (or a registered secret); it was replaced with ${DIP_PRESS_REDACTION_MARKER} before the engine read it, so the engine, the record and the report hold the same text (counted in the RunSpec label arena.press_redactions)`,
    );
  }
  return r.replaced || red.replaced ? { ...sub, payload: red.payload } : sub;
}

export interface RunEpisodeOptions {
  transport: Transport | null;
  /** In-process reference target (`--target ref:*`), no network. */
  inProcess?: TargetDriver;
  transportName: string;
  targetLabel: string;
  state: TargetRunState;
  /** Replaces the local "is it running?" hint when the target cannot be reached (hosted runs). */
  unreachableHint?: string;
  /**
   * G-54 (hosted runs): the manifest's wall-clock deadline (`performance.now()` instant, and as written).
   * No decision runs past it: its deadline is min(sent + Dh, at); a decision cut there is a hard miss and
   * the episode is aborted with `deadline_exceeded` (the run writes nothing).
   */
  runDeadline?: { at: number; iso: string };
}

/** G-54: the run passed the manifest's wall-clock deadline inside an episode. Names the tier budget and the overshoot. */
export function deadlineExceededError(p: EpisodePlan, tick: number, iso: string, overshootMs: number, cut: boolean): CliError {
  const t = tierOf(p.tier);
  return runError(
    `deadline_exceeded: the run reached its wall-clock deadline (manifest wall_clock_deadline ${iso}) during episode ${p.index} at tick ${tick}${cut ? `; the in-flight decision was cut at the deadline and recorded as a hard miss (${p.tier} tier Dh ${t.hardDeadlineMs} ms)` : ''}, ${Math.max(0, Math.round(overshootMs))} ms past it. The episode was aborted; no report was written.`,
    'the plan cap bounds hosted runs: start a new run with fewer episodes or a faster target (the seal step records seal_failed for this one).',
  );
}

/** Play one episode to terminal and return its EpisodeResult + record. */
export async function playEpisode(p: EpisodePlan, o: RunEpisodeOptions): Promise<EpisodeOutcome> {
  const blindingKey = newBlindingKey();
  const t0 = performance.now();
  if (o.inProcess) {
    const scn = initScenario(p, blindingKey, o.inProcess);
    while (!scn.terminal()) scn.tick();
    const record = scn.record();
    return { record, result: toEpisodeResult(record, { episodeIndex: p.index, replayRef: p.replayRef ?? replayRefOf(p.index), durationMs: performance.now() - t0 }) as EpisodeResult };
  }
  const transport = o.transport!;
  const tier = tierOf(p.tier);
  const scn = initScenario(p, blindingKey);
  const kind: FrameKind = p.scenarioId === 'grid_tactics' ? 'duel' : p.scenarioId === DIPLOMACY ? 'diplomacy' : 'raid';
  const episodeId = newEpisodeId();
  const runAt = o.runDeadline?.at ?? Infinity;
  if (performance.now() >= runAt) throw deadlineExceededError(p, 0, o.runDeadline!.iso, performance.now() - runAt, false);
  let session;
  try {
    session = await transport.openEpisode(episodeId, Math.min(performance.now() + tier.hardDeadlineMs, runAt));
  } catch (e) {
    if (performance.now() >= runAt) throw deadlineExceededError(p, 0, o.runDeadline!.iso, performance.now() - runAt, false);
    throw unreachableError(e, o);
  }
  try {
    while (!scn.terminal()) {
      const seat = scn.targetSeats()[0];
      const nonce = newNonce();
      let frame: Record<string, unknown>;
      let expect: { id: string; turnId: number; nonce: string; power?: PowerSeat };
      if (kind === 'duel') {
        const obs = duelObservationFrame(scn.observe(seat) as Observation, { nonce });
        frame = obs as unknown as Record<string, unknown>;
        expect = { id: obs.match_id, turnId: obs.turn_id, nonce };
      } else if (kind === 'diplomacy') {
        const body = scn.observe(seat) as DiplomacyObservationBody;
        frame = diplomacyObservationFrame(body, { episodeId, nonce });
        expect = { id: episodeId, turnId: body.turn_id, nonce, power: body.power };
      } else {
        const body = scn.observe(seat) as EvalRaidObservationBody;
        frame = evalRaidObservationFrame(body, { episodeId, nonce });
        expect = { id: episodeId, turnId: body.turn_id, nonce };
      }
      // Retry-After: nothing goes out inside the window (bounded by --max-retry-after, checked on receipt).
      // The wait is before `sent`, so it never enters the latency the engine sees.
      if (o.state.pauseUntil > performance.now()) {
        const wait = Math.min(o.state.pauseUntil - performance.now(), o.state.maxRetryAfterMs);
        await new Promise((r) => setTimeout(r, wait));
      }
      const sent = performance.now();
      if (sent >= runAt) throw deadlineExceededError(p, scn.currentTick(), o.runDeadline!.iso, sent - runAt, false);
      // G-54: a decision never runs past the run's wall-clock deadline.
      const deadline = Math.min(sent + tier.hardDeadlineMs, runAt);
      const cutByRun = deadline === runAt;
      let answer: Answer;
      try {
        answer = await session.decide(frame, deadline);
      } catch (e) {
        answer = { kind: 'unreachable', error: e };
      }
      for (let guard = 0; ; guard++) {
        const latencyMs = Math.max(0, Math.round(performance.now() - sent));
        let sub: Submission;
        try {
          sub = toSubmission(answer, kind, expect, latencyMs, o.state, o.transportName);
        } catch (e) {
          if (e instanceof CliError) throw e;
          if (!o.state.everAnswered) throw unreachableError(e, o);
          // A target that answered before and is now unreachable misses the decision (hard);
          // three in a row forfeit the episode, exactly as a hung agent would.
          warnOnce(o.state, 'unreachable', `lost the target over ${o.transportName} (${describeError(e).message}); decisions are recorded as hard misses`);
          sub = { kind: 'miss', severity: 'hard' };
          if (performance.now() < deadline) await new Promise((r) => setTimeout(r, Math.min(250, deadline - performance.now())));
        }
        if (cutByRun && performance.now() >= runAt && sub.kind === 'miss') {
          // The decision was cut by the run deadline, not by Dh: record the hard miss, then abort the episode.
          scn.act(seat, sub);
          throw deadlineExceededError(p, scn.currentTick(), o.runDeadline!.iso, performance.now() - runAt, true);
        }
        const receipt = scn.act(seat, sub);
        reportDeadline(o.state, p, scn.currentTick(), sub, receipt.accepted, latencyMs);
        // WS only: a stale or garbled message does not consume the decision; wait for the next one until Dh.
        const retry = !receipt.accepted && sub.kind === 'rejected' && session.more && guard < 16 && performance.now() < deadline && sub.reason !== 'too_large';
        if (!retry) break;
        answer = await session.more!(deadline);
        if (answer.kind === 'timeout' || answer.kind === 'unreachable') {
          if (answer.kind === 'timeout') scn.act(seat, { kind: 'miss', severity: 'hard' });
          break;
        }
      }
      if (performance.now() >= runAt) throw deadlineExceededError(p, scn.currentTick(), o.runDeadline!.iso, performance.now() - runAt, cutByRun);
      scn.tick();
    }
    const record = scn.record();
    if (kind !== 'duel') {
      try {
        const endFrame = kind === 'diplomacy' ? diplomacyEpisodeEndFrame(record, episodeId) : evalEpisodeEndFrame(record, episodeId);
        await session.end(endFrame, performance.now() + Math.min(1000, tier.hardDeadlineMs));
      } catch {
        /* the terminal notice is opt-in for the target; never a failure */
      }
    }
    return {
      record,
      result: toEpisodeResult(record, { episodeIndex: p.index, replayRef: p.replayRef ?? replayRefOf(p.index), durationMs: performance.now() - t0 }) as EpisodeResult,
    };
  } finally {
    session.close();
  }
}

/** Deadline misses name the tier budget and the overshoot (house rule); the first few per run, then only counted. */
const MAX_DEADLINE_WARNINGS = 5;
function reportDeadline(st: TargetRunState, p: EpisodePlan, tick: number, sub: Submission, accepted: boolean, latencyMs: number): void {
  const t = tierOf(p.tier);
  let line: string | null = null;
  if (sub.kind === 'miss' && sub.severity === 'hard') {
    const consequence = p.mode === 'power' ? 'no intent, no press, every unit Holds' : 'the units Hold';
    line = `episode ${p.index} tick ${tick}: no action frame within the hard deadline Dh ${t.hardDeadlineMs} ms (${p.tier} tier); ${consequence} (hard miss, ${t.hardMissForfeit} in a row forfeit${p.mode === 'power' ? ': the power goes into civil disorder' : ''})`;
  } else if (accepted && latencyMs > t.softDeadlineMs) {
    line = `episode ${p.index} tick ${tick}: answered in ${latencyMs} ms, ${latencyMs - t.softDeadlineMs} ms over the soft deadline Ds ${t.softDeadlineMs} ms (${p.tier} tier); the action applies but counts as a soft miss`;
  }
  if (!line) return;
  st.deadlineWarnings++;
  if (st.deadlineWarnings <= MAX_DEADLINE_WARNINGS) warn(line);
  else if (st.deadlineWarnings === MAX_DEADLINE_WARNINGS + 1) warn('further deadline misses are counted in the report budget block, not printed');
}

export function replayRefOf(index: number): string {
  return replayRefFor(REPORT_BASE, index);
}

function unreachableError(e: unknown, o: RunEpisodeOptions): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof NetBlockedError) return new CliError(e.message, 3);
  const d = describeError(e);
  return runError(
    `could not reach the target over ${o.transportName} at ${o.targetLabel}: ${d.message}.`,
    o.unreachableHint ??
      (o.targetLabel.includes('127.0.0.1') || o.targetLabel.includes('localhost') || o.targetLabel.includes('[::1]')
        ? 'start it first, e.g. `npm run target:reference -- --port 8080`, or check --target and --transport.'
        : 'check that the agent is running and reachable from this machine, and that --transport matches what it serves.'),
  );
}

/** A one-line human summary of where the target is (never the credential; URL already redacted). */
export function describeTarget(transport: string, url: string): string {
  return `${transport} ${url}`;
}

export { info };
