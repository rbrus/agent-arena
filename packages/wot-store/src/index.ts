/**
 * wot-store — storage interfaces + in-memory implementations (ADR-000,
 * interface-first). After the ADR-001 cut it keeps the stores the arena needs:
 * owners/passports/delegations (identity), tickets, match summaries, replays and
 * the durable match event log (runs + replays), webhooks, negotiation chambers,
 * the budget ledger, and the budget-tier table.
 */

export { newId, idPattern, type IdPrefix } from './ids.ts';

export type {
  League,
  OwnerStatus,
  OwnerRecord,
  OwnerStore,
  PassportStatus,
  PassportRecord,
  PassportSigningKeyRecord,
  CreatePassportInput,
  CreatePassportResult,
  PassportStore,
  TicketStatus,
  TicketRecord,
  CreateTicketInput,
  TicketStore,
  MatchLifecycle,
  MatchSummaryPlayer,
  MatchSummary,
  MatchStore,
  SaveReplayInput,
  ReplayRecord,
  ReplayStore,
  WebhookEventType,
  WebhookStatus,
  WebhookRecord,
  CreateWebhookInput,
  CreateWebhookResult,
  WebhookStore,
  LedgerEntryType,
  LedgerRefKind,
  LedgerRef,
  LedgerAccountKind,
  JournalLegInput,
  PostJournalInput,
  PostedLeg,
  PostedJournal,
  LedgerQuery,
  LedgerStore,
  MatchSideReliability,
  MatchAgentSide,
  MatchFinishRecord,
  Stores,
  CreateStoresOptions,
} from './types.ts';

export { passportKeyResolver, activeSigningKey, toSigningKeyRecord, SigningKeyError } from './signing-keys.ts';

export {
  createStores,
  InMemoryOwnerStore,
  InMemoryPassportStore,
  InMemoryTicketStore,
  InMemoryMatchStore,
  InMemoryReplayStore,
  InMemoryWebhookStore,
} from './memory.ts';

export {
  InMemoryLedgerStore,
  accountId,
  ledgerAccountKind,
  LedgerError,
  UnbalancedJournalError,
  InsufficientBalanceError,
} from './ledger.ts';

export {
  signWebhook,
  verifyWebhookSignature,
  WebhookDeliverer,
  type WebhookDelivererOptions,
  type MatchEventPlayer,
  type MatchFoundEvent,
  type MatchEndEvent,
} from './webhooks.ts';

// Guarded outbound HTTP for webhook delivery (threat-model-arena G-3).
export {
  guardedPost,
  checkEgressUrl,
  isForbiddenAddress,
  EgressRefused,
  type EgressOptions,
  type EgressResponse,
} from './egress.ts';

// The ONE outbound address blocklist (G-25). Also exported dependency-free as
// `wot-store/net-blocklist` so the CLI can import it without the store graph.
export {
  NET_BLOCKLIST,
  classifyAddress,
  type AddressClass,
  type BlocklistEntry,
} from './net-blocklist.ts';

// Budget tiers (leagues): the contract-fixed evaluation-class limits
export {
  LEAGUES,
  budgetTierLimits,
  leagueBudget,
  type BudgetTierLimits,
  type LeagueBudget,
} from './leagues.ts';

// Negotiation Chambers: two-party A2A offer/counter/accept/withdraw thread over
// scenario-scoped commitments + the agreement receipt of a bound offer.
export {
  InMemoryNegotiationStore,
  type NegotiationStore,
  type NegotiationRecord,
  type NegotiationOfferRecord,
  type NegotiationCommitment,
  type NegotiationCommitmentTerm,
  type NegotiationAgreement,
  type CreateNegotiationInput,
  type NegotiationTopic,
  type NegotiationStatus,
  type NegotiationOfferAction,
  type NegotiationOfferStatus,
} from './negotiations.ts';

// Delegated squad tokens: the RFC 8693 grant record + child-jti denylist that
// anchor scope-narrowing, one-session-per-child, and revocation cascade (Phase 4 B1).
export {
  InMemoryDelegationStore,
  type DelegationStore,
  type DelegationGrant,
  type DelegationGrantStatus,
  type OpenOrGetGrantInput,
} from './delegations.ts';

// Durable match event log + lifecycle manifest (recoverable match state, the CAS
// that decides the outcome exactly once) (Phase 5 B5).
export {
  InMemoryMatchEventStore,
  type MatchEventStore,
  type MatchManifest,
  type MatchManifestSide,
  type MatchTickRecord,
  type MatchLifecycleStatus,
  type CasResult,
  type CasPatch,
} from './matchevents.ts';


