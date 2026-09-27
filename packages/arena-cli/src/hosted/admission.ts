/**
 * Hosted episode caps (contracts 2.10.0, signing.md §3.2 rules A6 and M10), checked by the runner
 * before any I/O. The control plane applies the same rules at admission (`plan_limit_exceeded`,
 * `detail.limit` `extended_episodes_per_run` / `diplomacy_episodes_per_run`, whatever the plan), so a
 * run it admits is never refused here for these reasons.
 *
 *  A6   `budget_tier: extended` ⇒ `episodes` = 1. Dh is 30 s: one Diplomacy episode at horizon 1908
 *       (103 ticks) can take about 51.5 minutes, and a `sixi_run_token` run ends within 55 minutes of
 *       minting (C3). One cap for every credential mode, until a run-token refresh path exists.
 *       Refusal: `run_spec_invalid` (`episodes`).
 *  M10  a Diplomacy-family run (`diplomacy_standard`, or an `sx_` variant whose base is it) has
 *       `episodes` ≤ 50, and `episode_secret_commitments.count` = `episodes` (the schema caps count at
 *       50; the per-episode secret delivery is bounded by the secret store's version-add rate).
 *       Hosted only: the open CLI keeps the RunSpec limit of 1000.
 *       Refusal: `hosted_context_invalid` (`episode_secret_commitments`).
 *
 * The two compose: an extended Diplomacy run plays 1 episode, a Diplomacy run at another tier ≤ 50.
 */

import { misconfig, type CliError } from '../errors.ts';
import type { HostedContextContract, RunSpecContract } from '../generated/contracts.ts';
import { invalid } from './manifest.ts';

/** signing.md §3.2 A6: episodes of a hosted `extended` run. */
export const HOSTED_EXTENDED_MAX_EPISODES = 1;
/** signing.md §3.2 M10 (OQ-18): episodes of a hosted Diplomacy-family run, whatever the plan. */
export const HOSTED_DIPLOMACY_MAX_EPISODES = 50;

const specInvalid = (field: string, message: string, next: string): CliError => misconfig(`run_spec_invalid (${field}): ${message} Nothing was sent.`, next);

/** A6. Runs right after the RunSpec is bound to the manifest, before scenario resolution. */
export function assertHostedTierEpisodes(spec: Pick<RunSpecContract, 'budget_tier' | 'episodes'>): void {
  if (spec.budget_tier === 'extended' && spec.episodes !== HOSTED_EXTENDED_MAX_EPISODES) {
    throw specInvalid(
      'episodes',
      `a hosted run at the extended tier plays exactly ${HOSTED_EXTENDED_MAX_EPISODES} episode (Dh 30 s; one episode can take about 51.5 minutes and a run token lives 55 minutes; signing.md §3.2 A6), got ${spec.episodes}.`,
      'the control plane must admit an extended run with episodes 1 (one RunSpec per episode) until a run-token refresh path exists.',
    );
  }
}

/** M10. `diplomacyFamily`: the resolved base scenario is `diplomacy_standard`. */
export function assertHostedDiplomacyEpisodes(m: Pick<HostedContextContract, 'episode_secret_commitments'>, spec: Pick<RunSpecContract, 'episodes'>, diplomacyFamily: boolean): void {
  if (!diplomacyFamily) return;
  if (spec.episodes > HOSTED_DIPLOMACY_MAX_EPISODES) {
    throw invalid(
      'episode_secret_commitments',
      `a hosted Diplomacy-family run plays at most ${HOSTED_DIPLOMACY_MAX_EPISODES} episodes (signing.md §3.2 M10), the RunSpec plays ${spec.episodes}.`,
      `the control plane must refuse more than ${HOSTED_DIPLOMACY_MAX_EPISODES} episodes at admission (plan_limit_exceeded, diplomacy_episodes_per_run), whatever the plan.`,
    );
  }
  const c = m.episode_secret_commitments;
  if (c && c.count !== spec.episodes) {
    throw invalid('episode_secret_commitments', `the manifest commits to ${c.count} episode secret(s), the RunSpec plays ${spec.episodes} episode(s) (signing.md §3.2 M7, M10).`);
  }
}
