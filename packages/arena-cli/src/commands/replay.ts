/**
 * `agent-arena replay <report.json> --episode <n> | --hash <replay_hash>`:
 * print one episode's tick log, regenerated from the seed and the recorded
 * target inputs (no target, no network). `--json` emits the replay-inspector
 * file (frontend/src/lib/replay-format.ts), byte-identical to the
 * `report.episode-<n>.replay.json` that `run` wrote.
 *
 * The report is hostile until verified: every value interpolated below goes
 * through `out()`, which renders one call as exactly one terminal-safe line
 * that cannot begin with a CI workflow command (G-22).
 */

import { resolve } from 'node:path';
import { HostileFileError, readHostileJson } from '../files.ts';
import { buildReplayFile, type ReplayFile } from '../replay-file.ts';
import { EXIT_CODES, type EpisodeResult, type ExitCode } from '../report.ts';
import { loadRecord, regenerate } from '../rerun.ts';
import { toEpisodeResult } from 'arena-scenarios';
import { isJson, out, writeStdout } from '../ui.ts';
import { inertJson, recordText } from '../inert.ts';
import { redact } from '../redact.ts';
import { MAX_REPORT_BYTES } from './verify.ts';

/** diplomacy_standard: counts only (orders, intent, press moves); no target text reaches the terminal. */
function dipActionSummary(action: unknown): string {
  if (!action || typeof action !== 'object') return '-';
  const a = action as { orders?: unknown; intent?: unknown; press?: unknown };
  const parts: string[] = [];
  if (a.intent !== undefined) parts.push('intent');
  if (Array.isArray(a.orders)) parts.push(`${a.orders.length} order(s)`);
  if (Array.isArray(a.press)) {
    const moves = new Map<string, number>();
    for (const m of a.press) {
      const mv = m && typeof m === 'object' && typeof (m as { move?: unknown }).move === 'string' ? ((m as { move: string }).move.match(/^[a-z]{1,12}$/)?.[0] ?? '?') : '?';
      moves.set(mv, (moves.get(mv) ?? 0) + 1);
    }
    parts.push(`press ${[...moves].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  return parts.join(' · ') || 'empty (no intent, press or orders)';
}

function actionSummary(action: unknown): string {
  if (!action || typeof action !== 'object') return '-';
  const a = action as { members?: Record<string, unknown[]>; units?: unknown[] };
  const one = (list: unknown[] | undefined): string =>
    (list ?? [])
      .map((x) => {
        const o = x as { verb?: string; steps?: string[]; target?: number[] | string; target_member?: string; cell?: number[]; tag?: string; unit_id?: string };
        switch (o.verb) {
          case 'move':
            return `move ${(o.steps ?? []).join('')}`;
          case 'attack':
            return `attack ${Array.isArray(o.target) ? `(${o.target.join(',')})` : ''}`;
          case 'revive':
            return `revive ${o.target_member ?? ''}`;
          case 'ping':
            return `ping ${o.tag ?? ''}`;
          default:
            return o.verb ?? '?';
        }
      })
      .join(', ') || 'hold';
  if (a.members) return Object.keys(a.members).sort().map((m) => `${m}: ${one(a.members![m])}`).join(' | ');
  return one(a.units);
}

export function replayCommand(path: string | undefined, o: { episode?: string; hash?: string }): ExitCode {
  if (!path || (o.episode === undefined && o.hash === undefined)) {
    out('usage: agent-arena replay <report.json> --episode <n>   (or --hash sha256:…)');
    return EXIT_CODES.misconfig;
  }
  const full = resolve(path);
  let episodes: EpisodeResult[];
  try {
    const r = readHostileJson(full, MAX_REPORT_BYTES, 'report') as { episodes?: unknown };
    if (!Array.isArray(r.episodes)) throw new HostileFileError('the report has no episodes array');
    episodes = r.episodes as EpisodeResult[];
  } catch (e) {
    out(`error: ${e instanceof HostileFileError ? e.message : 'cannot read the report'}`);
    return EXIT_CODES.error;
  }
  const ep =
    o.hash !== undefined
      ? episodes.find((e) => e && e.replay_hash === o.hash)
      : episodes.find((e) => e && e.episode_index === Number(o.episode));
  if (!ep) {
    out(`error: no episode ${o.hash !== undefined ? `with replay hash ${o.hash.slice(0, 80)}` : String(o.episode).slice(0, 10)} in the report (it has ${episodes.length}).`);
    return EXIT_CODES.misconfig;
  }
  if (typeof ep.replay_ref !== 'string') {
    out('error: this episode has no replay_ref; nothing to replay.');
    return EXIT_CODES.error;
  }
  let file: ReplayFile;
  try {
    const rec = regenerate(loadRecord(full, ep.replay_ref));
    const result = toEpisodeResult(rec, { episodeIndex: ep.episode_index, replayRef: ep.replay_ref }) as EpisodeResult;
    if (rec.replayHash !== ep.replay_hash) {
      out(`error: the record re-simulates to ${rec.replayHash}, but the report says ${recordText(ep.replay_hash, 80)}; run agent-arena verify.`);
      return EXIT_CODES.findings;
    }
    file = buildReplayFile(rec, result);
  } catch (e) {
    out(`error: cannot replay episode ${ep.episode_index}: ${e instanceof Error ? e.message : 'unknown error'}`);
    return EXIT_CODES.error;
  }
  if (isJson()) {
    // Same bytes as the file `run` wrote: redacted, then inert (G-36: target bidi / tag characters `\u`-escaped).
    writeStdout(`${inertJson(redact(JSON.stringify(file)))}\n`);
    return EXIT_CODES.ok;
  }
  out(`${file.scenario_id} · seed ${file.seed} · ${file.tier} · ${file.mode} seat ${file.seat} · episode ${file.episode_index}`);
  out(`initial ${file.initial_state_hash}`);
  for (const t of file.ticks) {
    const s = t.seats[0];
    const ack = s ? `${s.ack.status}${s.ack.reason ? `:${s.ack.reason}` : ''}${s.ack.late ? ' late' : ''}` : '-';
    const oracle = t.oracle_events.length ? `  !! ${t.oracle_events.map((e) => e.oracle_id).join(', ')}` : '';
    const step = file.mode === 'power' ? `${String(t.engine_events.find((e) => e.type === 'step')?.step ?? '').padEnd(14)} ` : '';
    const what = file.mode === 'power' ? (s ? dipActionSummary(s.action) : '(references only)') : actionSummary(s?.action);
    out(`t=${String(t.tick).padStart(3)}  ${t.state_hash.slice(7, 19)}  ${step}[${ack}]  ${what}${oracle}`);
  }
  out(`replay_hash ${file.replay_hash} (re-simulated from the seed; matches the report)`);
  return EXIT_CODES.ok;
}
