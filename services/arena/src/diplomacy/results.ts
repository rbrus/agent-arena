/**
 * Where an ended Diplomacy table's result goes (Phase 9 hardening, CHAOS-DIPLOMACY D-2).
 *
 * The lobby used to keep every ended `DiplomacyTable` (the whole episode, ~155 KB for a
 * 1902 horizon) in its Map forever, because `getTable()` was the only way to read a
 * result. Now, when a table ends for any reason, the lobby builds a small
 * `TableResultSummary` (hashes, terminal, cause) and hands it to a `TableResultSink`;
 * after a short grace the live table is deleted and `getTable()` answers from the sink.
 *
 * The default sink is an in-memory ring with a cap (oldest summary evicted first). The
 * optional `onResult` callback is the hosted seal path: it additionally receives the
 * full `result()` (signature evidence) and `recording()` (seed, overrides including the
 * episode SECRET, per-tick inputs), which must be stored like a credential. The callback
 * is never awaited and its failures are logged by the lobby, never thrown into the table:
 * a slow or broken consumer cannot delay an episode.
 *
 * Nothing here is hashed; the summary copies hashes the engine already produced.
 */

import type { DipConfig, DipEpisode, DipEvalClass, DipResult, DipTerminal, Power } from 'wot-engine';
import type { SignatureEvidence } from './signatures.ts';

/** Why a table stopped. `terminal`: the engine reached a terminal state (episode_end sent). */
export type TableEndCause = 'terminal' | 'shutdown' | 'seat_timeout';

export interface TableResultSummary {
  readonly kind: 'diplomacy_table_result';
  readonly tableId: string;
  readonly episodeId: string;
  readonly cls: DipEvalClass;
  readonly cause: TableEndCause;
  /** The close code the connected seats received (1000 after episode_end, 1012 shutdown, 4408 seat timeout). */
  readonly closeCode: number;
  /** Null unless `cause === 'terminal'`: an interrupted table never gets an invented result. */
  readonly terminal: DipTerminal | null;
  readonly ticks: number;
  readonly phases: number;
  readonly replayHash: string;
  readonly transcriptHash: string;
  /** Powers that forfeited (civil disorder) during the episode. */
  readonly forfeited: readonly Power[];
  readonly endedAt: string;
}

/** What the hosted seal path gets besides the summary. Contains the episode secret. */
export interface TableResultDetail {
  result: DipResult & { episodeId: string; signatures: readonly SignatureEvidence[] };
  recording: { seed: number; cls: DipEvalClass; overrides: Partial<DipConfig>; inputs: DipEpisode['inputs'] };
}

export interface TableResultSink {
  put(summary: TableResultSummary, detail: TableResultDetail): void | Promise<void>;
  get(tableId: string): TableResultSummary | undefined;
  /** Number of summaries held (for tests and metrics). */
  readonly size: number;
}

export const DEFAULT_RESULT_CAP = 1024;

export interface MemoryResultSinkOptions {
  /** Ring capacity; the oldest summary is evicted first. Default 1024 (~0.5 KB each). */
  cap?: number;
  /** Hosted seal hook, called once per ended table after the summary is stored. */
  onResult?: (summary: TableResultSummary, detail: TableResultDetail) => void | Promise<void>;
}

export function memoryResultSink(opts: MemoryResultSinkOptions = {}): TableResultSink {
  const cap = Math.max(1, Math.floor(opts.cap ?? DEFAULT_RESULT_CAP));
  const ring = new Map<string, TableResultSummary>(); // insertion order = age
  return {
    put(summary, detail) {
      ring.delete(summary.tableId);
      ring.set(summary.tableId, summary);
      while (ring.size > cap) {
        const oldest = ring.keys().next().value as string;
        ring.delete(oldest);
      }
      return opts.onResult?.(summary, detail);
    },
    get: (id) => ring.get(id),
    get size() {
      return ring.size;
    },
  };
}
