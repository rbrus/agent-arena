/**
 * In-memory double-entry budget ledger (Phase 3 B1, reduced to budget accounting
 * by ADR-001 / Phase 7 B0-18).
 *
 * Every movement of a seat's allowance is a BALANCED journal (Σ legs == 0) that
 * references the episode and tick it accounts for; the store refuses a journal
 * without that reference. Balances are DERIVED by folding legs — never stored
 * authoritatively. Allowance is granted only from `faucet:*` accounts and
 * consumed only into `sink:*` accounts; the store refuses to drive a `budget:*`
 * account negative (an overspend is refused, not clamped).
 *
 * `post` is atomic (validate-then-commit; a rejected journal mutates nothing)
 * and exactly-once (the idempotency key dedups a retried post). Zero external
 * deps so the demo runs from a clean clone; a persistent impl (transaction +
 * idempotency-key row) slots behind the same `LedgerStore` interface later.
 */

import { newId } from './ids.ts';
import type {
  LedgerAccountKind,
  LedgerQuery,
  LedgerStore,
  PostJournalInput,
  PostedJournal,
  PostedLeg,
} from './types.ts';

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Account-id grammar (`<kind>:<local>`) — the single place it is defined.
// ---------------------------------------------------------------------------

/** Build a canonical account id, e.g. `accountId('faucet', 'budget')`. */
export function accountId(kind: LedgerAccountKind, local: string): string {
  return `${kind}:${local}`;
}

/** Parse an account id's kind, or null if it is not a well-formed ledger account. */
export function ledgerAccountKind(id: string): LedgerAccountKind | null {
  const k = id.slice(0, id.indexOf(':'));
  return k === 'budget' || k === 'faucet' || k === 'sink' ? k : null;
}

/** Accounts whose balance may never go negative (a seat's remaining allowance). */
function isBalanceGuarded(id: string): boolean {
  return ledgerAccountKind(id) === 'budget';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LedgerError extends Error {}

export class UnbalancedJournalError extends LedgerError {
  constructor(public readonly total: number) {
    super(`journal legs sum to ${total}; a double-entry journal must sum to 0`);
    this.name = 'UnbalancedJournalError';
  }
}

export class InsufficientBalanceError extends LedgerError {
  constructor(
    public readonly account: string,
    public readonly required: number,
    public readonly available: number,
  ) {
    super(
      `account ${account} has ${available} units; cannot apply a debit of ${required}`,
    );
    this.name = 'InsufficientBalanceError';
  }
}

// ---------------------------------------------------------------------------
// Opaque offset cursor (base64url of the next index)
// ---------------------------------------------------------------------------

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return Number.isInteger(parsed.o) ? (parsed.o as number) : 0;
  } catch {
    return 0;
  }
}

/** The integrity rule: every journal references an episode and a tick. */
function validateRef(ref: PostJournalInput['ref']): void {
  if (!ref || ref.kind !== 'episode') throw new LedgerError('a budget journal must reference an episode');
  if (typeof ref.episode_id !== 'string' || ref.episode_id.length === 0) {
    throw new LedgerError('a budget journal must carry an episode_id');
  }
  if (!Number.isInteger(ref.tick) || ref.tick < 0) {
    throw new LedgerError(`a budget journal must carry a non-negative integer tick, got ${ref.tick}`);
  }
}

// ---------------------------------------------------------------------------
// InMemoryLedgerStore
// ---------------------------------------------------------------------------

export class InMemoryLedgerStore implements LedgerStore {
  /** Append-only legs per account (oldest→newest). balanceOf = fold of these. */
  private legsByAccount = new Map<string, PostedLeg[]>();
  /** Append-only journal log (oldest→newest) — the audit source of truth. */
  private journal: PostedJournal[] = [];
  /** idempotencyKey → the journal it produced (exactly-once). */
  private byKey = new Map<string, PostedJournal>();

  /** Derived balance = Σ of an account's legs. Never a stored mutable integer. */
  private fold(account: string): number {
    let sum = 0;
    const legs = this.legsByAccount.get(account);
    if (legs) for (const l of legs) sum += l.amount;
    return sum;
  }

  async balanceOf(account: string): Promise<number> {
    return this.fold(account);
  }

  async post(input: PostJournalInput): Promise<PostedJournal> {
    // Exactly-once: a replay returns the original and applies nothing.
    const prior = this.byKey.get(input.idempotencyKey);
    if (prior) {
      return { ...prior, deduped: true, legs: prior.legs.map((l) => ({ ...l })) };
    }

    validateRef(input.ref);
    const legs = input.legs;
    if (legs.length < 2) {
      throw new LedgerError('a journal needs at least two legs (double-entry)');
    }

    // --- validate (no mutation happens in this phase) ---
    let total = 0;
    const delta = new Map<string, number>();
    for (const l of legs) {
      if (!Number.isInteger(l.amount)) {
        throw new LedgerError(`leg amount ${l.amount} is not an integer (Pillar 9)`);
      }
      if (l.amount === 0) {
        throw new LedgerError('zero-amount leg — a journal leg must move value');
      }
      if (ledgerAccountKind(l.account) === null) {
        throw new LedgerError(`unknown account kind in ${l.account} (budget | faucet | sink)`);
      }
      total += l.amount;
      delta.set(l.account, (delta.get(l.account) ?? 0) + l.amount);
    }
    if (total !== 0) throw new UnbalancedJournalError(total);

    // Guard: a budget account may never go negative (no overspend, no dupe).
    for (const [account, d] of delta) {
      if (d < 0 && isBalanceGuarded(account)) {
        const available = this.fold(account);
        if (available + d < 0) throw new InsufficientBalanceError(account, -d, available);
      }
    }

    // --- commit (atomic: all legs or, on any throw above, none) ---
    const ts = input.ts ?? now();
    const journalId = newId('jrn');
    const posted: PostedLeg[] = [];
    for (const l of legs) {
      const balanceAfter = this.fold(l.account) + l.amount;
      const pl: PostedLeg = {
        entryId: newId('led'),
        journalId,
        ts,
        account: l.account,
        amount: l.amount,
        type: l.type,
        balanceAfter,
        ref: input.ref,
        ...(l.memo ?? input.memo ? { memo: l.memo ?? input.memo } : {}),
      };
      const arr = this.legsByAccount.get(l.account);
      if (arr) arr.push(pl);
      else this.legsByAccount.set(l.account, [pl]);
      posted.push(pl);
    }

    const committed: PostedJournal = {
      journalId,
      ts,
      ref: input.ref,
      idempotencyKey: input.idempotencyKey,
      legs: posted,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      deduped: false,
    };
    this.journal.push(committed);
    this.byKey.set(input.idempotencyKey, committed);
    return committed;
  }

  async entriesFor(
    account: string,
    query: LedgerQuery = {},
  ): Promise<{ entries: PostedLeg[]; nextCursor: string | null }> {
    const all = this.legsByAccount.get(account) ?? [];
    // Newest-first (contract read order).
    const ordered = [...all].reverse();
    const filtered = query.type ? ordered.filter((l) => l.type === query.type) : ordered;
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const start = query.cursor ? decodeCursor(query.cursor) : 0;
    const slice = filtered.slice(start, start + limit);
    const nextOffset = start + slice.length;
    const nextCursor = nextOffset < filtered.length ? encodeCursor(nextOffset) : null;
    return { entries: slice.map((l) => ({ ...l })), nextCursor };
  }

  async allJournals(): Promise<PostedJournal[]> {
    return this.journal.map((j) => ({ ...j, legs: j.legs.map((l) => ({ ...l })) }));
  }

  async accounts(): Promise<string[]> {
    return [...this.legsByAccount.keys()];
  }
}
