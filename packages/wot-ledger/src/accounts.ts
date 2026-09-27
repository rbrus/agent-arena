/**
 * Account model — ergonomic constructors over the `<kind>:<local>` account-id
 * grammar that `wot-store` enforces.
 *
 *   budget(episodeId, seat) — one seat's remaining allowance in one episode.
 *                             Never negative: an overspend is refused.
 *   BUDGET_FAUCET           — `faucet:budget`, the ONLY source of allowance.
 *   CONSUMED_SINK           — `sink:consumed`, the ONLY destination of spend.
 *
 * The faucet and the sink are the declared boundary: allowance enters an episode
 * only by a grant and leaves it only by consumption.
 */

import { accountId } from 'wot-store';

/** Episode ids and seats are opaque but must not contain the account separators. */
const LOCAL_PART = /^[A-Za-z0-9_-]{1,64}$/;

export function assertLocalPart(name: string, v: string): void {
  if (!LOCAL_PART.test(v)) throw new RangeError(`${name} '${v}' must match ${LOCAL_PART}`);
}

/** A seat's allowance account for one episode (`budget:<episode_id>/<seat>`). */
export function budget(episodeId: string, seat: string): string {
  assertLocalPart('episodeId', episodeId);
  assertLocalPart('seat', seat);
  return accountId('budget', `${episodeId}/${seat}`);
}

/** The declared budget faucet — the only place allowance is issued. */
export const BUDGET_FAUCET = accountId('faucet', 'budget');

/** The declared consumption sink — the only place spent allowance goes. */
export const CONSUMED_SINK = accountId('sink', 'consumed');
