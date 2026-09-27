/**
 * Contract-valid ID generation.
 *
 * IDs are `<prefix>_<ULID>` where the ULID is 26 chars of Crockford base32
 * (uppercase), matching the schema patterns such as
 * `^mat_[0-9A-HJKMNP-TV-Z]{26}$` (agent-passports.md §0; contracts/schemas).
 */

import { ulid } from 'ulid';

export type IdPrefix =
  | 'mat' // match
  | 'tkt' // matchmaking ticket
  | 'rpl' // replay artifact
  | 'agt' // agent (public avatar id)
  | 'cid' // OAuth client id (passport)
  | 'own' // owner
  | 'ses' // live session
  | 'whk' // webhook registration (Phase 2)
  | 'evt' // webhook delivery/event envelope (Phase 2)
  | 'jrn' // budget-ledger journal transaction
  | 'led' // budget-ledger entry / leg
  | 'neg' // Negotiation Chamber (Phase 4 B3 — the Pact)
  | 'ngo' // Negotiation Chamber signed offer/counter (Phase 4 B3)
  | 'sqd' // raid squad (Phase 4 B1 — delegated squad tokens)
  | 'rad' // raid instance / encounter (Phase 4 B1)
  | 'mem' // squad-member slot identity (Phase 4 B1)
  | 'dlg'; // delegation grant (Phase 4 B1 — RFC 8693 token exchange)

/** Regex a generated id of the given prefix satisfies (Crockford base32, 26 chars). */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
}

/** Generate a fresh contract-valid id, e.g. `newId('mat')`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
