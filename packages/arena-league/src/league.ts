/**
 * League league composition (HOSTED-PROFILE §6.3, §6.4): which models sit at
 * which table on which power, as a pure function of the league manifest.
 *
 *  - Seeds come from the manifest, one per table, in order (Sixi draws and
 *    publishes them; nothing here draws a seed).
 *  - Round-robin: with N models and k seats per table, table i seats models
 *    (i*k + j) mod N for j < k (every model sits equally often when N divides
 *    the number of tables times k).
 *  - Powers: a Latin-square rotation keyed by the league seed. Slot j of table
 *    i plays POWERS[(offset + i + j) mod 7], offset = leagueSeed mod 7, so over
 *    any 7 consecutive tables every slot plays every power once. The power is
 *    NEVER chosen from a model's provider (no "home" power exists here).
 *  - Unseated powers are house diplomats (runTable fills them).
 */

import { POWERS, type Power } from 'wot-engine';

export interface LeagueManifest {
  /** `^[a-z0-9][a-z0-9_-]{0,40}$`, e.g. `s2026-10`. */
  league: string;
  league_seed: number;
  /** One table per seed. */
  seeds: readonly number[];
  /** Model keys (`provider/model`), in a fixed published order. */
  models: readonly string[];
  /** Peers per table, 1..7 (default min(7, models.length)). */
  seats_per_table?: number;
}

export interface LeagueTable {
  table_id: string;
  seed: number;
  seats: { power: Power; model: string }[];
}

const LEAGUE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function composeLeague(m: LeagueManifest): LeagueTable[] {
  if (!LEAGUE_RE.test(m.league)) throw new Error('league must match ^[a-z0-9][a-z0-9_-]{0,40}$');
  if (!Number.isInteger(m.league_seed) || m.league_seed < 0 || m.league_seed > 0xffffffff) throw new Error('league_seed must be a uint32');
  if (m.models.length < 1 || new Set(m.models).size !== m.models.length) throw new Error('models must be a non-empty list of distinct model keys');
  const k = m.seats_per_table ?? Math.min(7, m.models.length);
  if (!Number.isInteger(k) || k < 1 || k > 7 || k > m.models.length) throw new Error('seats_per_table must be 1..min(7, models)');
  const n = m.models.length;
  const offset = m.league_seed % 7;
  return m.seeds.map((seed, i) => {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`seeds[${i}] must be a uint32`);
    const seats = Array.from({ length: k }, (_x, j) => ({ power: POWERS[(offset + i + j) % 7] as Power, model: m.models[(i * k + j) % n] }));
    return { table_id: `${m.league}-t${String(i + 1).padStart(3, '0')}`, seed, seats };
  });
}
