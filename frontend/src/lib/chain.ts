// Local hash-chain check of a replay file (replay-format.ts). A consistency
// check of the FILE against the replay hash the report committed to, never a
// re-simulation (that is `agent-arena verify`).
//
// Phase 7 modes (duel / squad / member): fold the per-tick state hashes from
// initial_state_hash, fold(p, h) = "sha256:" + hex(sha256(p + ":" + h)).
//
// Power mode (diplomacy_standard; arena-cli src/replay-file.ts): each entry's
// state_hash is the HEAD of the adjudicator chain after that engine step,
// initial_state_hash is its genesis head (wot-engine diplomacy/hash.ts:
// chain_k = fold(fold(chain_{k-1}, ordersDigest_k), stateHash(next_k)), two
// folds per adjudication, none for intent or press steps). The fold inputs
// (every power's settled-orders digest and the full board-state hash) are not
// in the replay file, so the browser cannot recompute a fold; it checks what
// the file does commit to: heads unchanged across every intent and press step,
// a new head at every adjudication (orders / retreat / adjustment), the event
// log agreeing with that, and the last head equal to the report's replay hash.
import type { ReplayFile, ReplayTick } from './replay-format.ts';

export type ChainStatus = 'checking' | 'ok' | 'mismatch' | 'unavailable';

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type DipStepKind = 'intent' | 'press' | 'orders' | 'retreat' | 'adjust';
export interface DipStep {
  phase: string;
  kind: DipStepKind;
  round?: number;
  /** An adjudication step: the chain folds (orders digest, state hash) here. */
  adjudicates: boolean;
}

const STEP = /^([SF]19\d\d[MR]|W19\d\dA):(intent|r[1-9]|orders)$/;

/** Classify one power-mode entry from its `step` engine event (the CLI writes `<phase>:<intent|rN|orders>`). */
export function dipStepOf(t: ReplayTick): DipStep | null {
  const ev = t.engine_events.find((e) => e.type === 'step');
  const m = ev && typeof ev.step === 'string' ? STEP.exec(ev.step) : null;
  if (!m) return null;
  const [, phase, s] = m;
  if (s === 'intent') return { phase, kind: 'intent', adjudicates: false };
  if (s.startsWith('r')) return phase.endsWith('M') ? { phase, kind: 'press', round: Number(s.slice(1)), adjudicates: false } : null;
  return { phase, kind: phase.endsWith('M') ? 'orders' : phase.endsWith('R') ? 'retreat' : 'adjust', adjudicates: true };
}

/** Power mode: null if the file is consistent with `expected`, else the first problem (for display). */
export function dipChainProblem(replay: ReplayFile, expected: string): string | null {
  let head = replay.initial_state_hash;
  let last = -1;
  for (const t of replay.ticks) {
    if (t.tick <= last) return `step ${t.tick}: steps out of order`;
    last = t.tick;
    const step = dipStepOf(t);
    if (!step) return `step ${t.tick}: no recognisable step event`;
    const marked = t.engine_events.some((e) => e.type === 'adjudicated');
    if (!step.adjudicates) {
      if (t.state_hash !== head) return `step ${t.tick} (${step.kind}): the chain head changed on a step that is never folded`;
      if (marked) return `step ${t.tick} (${step.kind}): an adjudication event on a step that does not adjudicate`;
    } else {
      if (t.state_hash === head) return `step ${t.tick} (${step.kind}): an adjudication that did not advance the chain`;
      if (!marked) return `step ${t.tick} (${step.kind}): the chain advanced without an adjudication event`;
      head = t.state_hash;
    }
  }
  if (head !== replay.replay_hash) return 'the last chain head is not the replay hash of the file';
  if (head !== expected) return 'the last chain head is not the replay hash the report committed to';
  return null;
}

export async function checkChain(replay: ReplayFile, expected: string): Promise<ChainStatus> {
  if (replay.mode === 'power') return dipChainProblem(replay, expected) === null ? 'ok' : 'mismatch';
  if (typeof crypto === 'undefined' || !crypto.subtle) return 'unavailable';
  try {
    let chain = replay.initial_state_hash;
    for (const t of replay.ticks) chain = `sha256:${await sha256Hex(`${chain}:${t.state_hash}`)}`;
    return chain === replay.replay_hash && chain === expected ? 'ok' : 'mismatch';
  } catch {
    return 'unavailable';
  }
}
