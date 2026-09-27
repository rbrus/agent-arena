/**
 * Raid win-condition evaluation (raids-v1 §2.5), checked at each tick close.
 * Order: clear → wipe → enrage/timeout.
 *   Clear  — boss.hp ≤ 0 with ≥1 member not-dead (downed counts). The simultaneous
 *            snapshot means a boss at hp≤0 is defeated even if the last stander
 *            falls the same tick (the tie rung, §2.5) — boss dies first.
 *   Wipe   — 0 living-and-not-downed members remain and no revive can complete.
 *   Timeout— the hard tick cap with the boss still alive (enrage should have wiped
 *            the squad well before this by construction).
 *
 * `state.tick` here is the NEXT tick to play (post-resolve).
 */

import type { RaidState, RaidTerminal } from './types.ts';
import { aliveMembers } from './util.ts';

export function isRaidTerminal(state: RaidState): RaidTerminal {
  // 1. Clear — the boss pool is empty (defeated from the snapshot).
  if (state.boss.hp <= 0) {
    return { over: true, outcome: 'clear', bossDefeated: true };
  }
  // 2. Wipe — no member is alive-and-not-downed, so no revive can complete.
  if (aliveMembers(state).length === 0) {
    return { over: true, outcome: 'wipe', bossDefeated: false };
  }
  // 3. Timeout — the hard cap with the boss alive.
  if (state.tick >= state.config.tickCap) {
    return { over: true, outcome: 'timeout', bossDefeated: false };
  }
  return { over: false };
}
