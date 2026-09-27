import type { Power } from 'wot-engine';
import { fakePeer, runTable, type Peer, type RunTableOptions, type TableRun, type TableSpec } from '../src/index.ts';

export const FIXED_NOW = (): Date => new Date('2026-10-05T08:00:00.000Z');
export const ZERO_CLOCK = (): number => 0;

/** Deterministic options: a frozen wall clock and zero latency. */
export function detOpts(extra: Partial<RunTableOptions> = {}): RunTableOptions {
  return { gameBudgetChf: 10, clock: ZERO_CLOCK, now: FIXED_NOW, ...extra };
}

export interface Seat {
  power: Power;
  peer: Peer;
}

export function table(id: string, seed: number, seats: Seat[], over: Partial<TableSpec> = {}): { spec: TableSpec; peers: Partial<Record<Power, Peer>> } {
  const peers: Partial<Record<Power, Peer>> = {};
  for (const s of seats) peers[s.power] = s.peer;
  return { spec: { table_id: id, seed, tier: 'core', horizon_year: 1902, seats: seats.map((s) => ({ power: s.power })), ...over }, peers };
}

/** The standard three-model test table: three `target` seats of three providers (contracts 2.8.0: every Neutral Ground seat is a target). */
export async function threeModelTable(seed = 20261115, extra: Partial<RunTableOptions> = {}): Promise<TableRun> {
  const t = table('t-three', seed, [
    { power: 'germany', peer: fakePeer('robust', { provider_id: 'alpha', model_id: 'alpha-m1' }) },
    { power: 'france', peer: fakePeer('credulous', { provider_id: 'beta', model_id: 'beta-m1' }) },
    { power: 'italy', peer: fakePeer('house', { provider_id: 'gamma', model_id: 'gamma-m1' }) },
  ]);
  return runTable(t.spec, t.peers, detOpts(extra));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
