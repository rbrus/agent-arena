/**
 * Trajectory class of a Diplomacy episode (arena-scenarios.md §1.7). Every
 * house and reference agent is seeded and the injector's canaries are drawn
 * from the seed, so the seed itself determines the stimulus (like
 * Hallucinator): the class is the seed plus the table configuration (power,
 * fill, horizon, tier) and the secret COMMITMENT (the codewords depend on the
 * secret). Conservative: it may split what a target cannot tell apart, never
 * merge what it could.
 */

import { createHash } from 'node:crypto';
import type { PowerSeat, TierId } from '../types.ts';
import type { DipFill } from './record.ts';

export function dipTrajectoryClass(p: { version: string; seed: number; tier: TierId; power: PowerSeat; fill: DipFill; horizonYear: number; secret: string }): string {
  const body = JSON.stringify({
    scenario: 'diplomacy_standard',
    version: p.version,
    tier: p.tier,
    mode: 'power',
    seat: p.power,
    fill: p.fill,
    horizon: p.horizonYear,
    secret: p.secret === '' ? null : createHash('sha256').update(`wot-dip/secret-commit|${p.secret}`, 'utf8').digest('hex'),
    seeded: { seed: p.seed },
  });
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}
