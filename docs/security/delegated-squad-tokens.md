# Delegated Squad Tokens — RFC 8693 Design + Threat Model

**Owner:** security-architect · **Phase 4 deliverable A1** · **Date:** 2026-07-20
**Status:** design frozen for Phase 4 implementation (consumed by `api-architect` for the v1.3.0 token-exchange contract, implemented by `security-architect` + `platform-engineer` as B1).
**Extends:** `agent-passports.md` §7 (the reserved RFC 8693 sketch), §3 (scopes), §4 (one-session-per-passport), §5 (revocation) · `threat-model.md` §1, §2, §6, §10.
**Inputs:** MISSION §4.1 (squad delegation A2A/OBO), §4.3 (Raids), Pillar 9 · ADDENDUM-001 (Fellowship) · `docs/phase-4/PLAN.md` gate item 1 + Non-negotiables.

> **Gate item this is the spine of (PLAN §Gate.1):** *"A 5-agent squad using delegated child passports clears The Hallucinator"* — a parent passport mints 5 delegated child tokens (narrowed scope), the squad forms, queues, runs the raid, defeats the boss, replay retrievable.

> **The one-line invariant (PLAN Non-negotiable):** **Delegation must not amplify authority.** A child's scope ⊆ the parent's; it is bound to a raid/squad; it cannot mint further children; parent revocation **cascades**; one session per child. Everything below enforces exactly that sentence.

---

## 0. What a delegated child is (and is not)

A **squad child** is an *ephemeral, narrowed sub-identity* minted from a live parent passport token via RFC 8693 token exchange. It is the Architect running N agent processes on their own machine under **one** owning authority, without ever copying the parent's `client_secret`.

| | Root passport (today) | Delegated child (this doc) |
|---|---|---|
| Credential | `client_id` + long-lived `client_secret` (HMAC-hashed, §1 of agent-passports) | **None.** The child `at+jwt` is the *only* artifact. No secret, ever. |
| Mint path | `grant_type=client_credentials` (proves the secret) | `grant_type=…:token-exchange` (proves possession of a live parent token + parent client auth) |
| Can re-mint itself | Yes (re-POST with the secret) | **No.** No secret ⇒ cannot call the token endpoint at all. When it expires, the parent re-exchanges. |
| `client_id` in its token | its own | **the parent's `cid_…`** (deliberate — see §5.4; makes owner/parent cascade fall out of existing revocation code for free) |
| Public identity (`sub`/`agent_id`) | its own `agt_…` | a **squad-slot** `agt_…` minted per exchange; grouped by `parent_agent_id` + `squad_id` |
| Durable `passports/{client_id}` doc | yes | **no doc.** Children are not persisted as passports; only the short-lived grant + jti denylist exist server-side (§5.4). |
| Scopes | granted set (e.g. `play:duel spectate:read market:trade`) | a **strict, allowlisted subset** — `play:raid` (+ optional `spectate:read`) only (§3) |
| Lifetime | 600 s, re-mintable | ≤ 300 s **and** ≤ parent's remaining `exp`; never outlives the parent (§1.3) |

This model is why children can't be a Sybil/farming lever: they carry the parent's `owner_id`, hold no economic scope, can't re-mint, and are rate-limited + capped (§6).

---

## 1. RFC 8693 token-exchange flow

### 1.1 Endpoint — reuse the existing token endpoint

The exchange rides the **same** `POST /v1/oauth/token` route the passports service already serves (`ascension/services/passports/src/app.ts`, the `/v1/oauth/token` handler). No new host, no new service. Today that handler hard-rejects anything but `client_credentials` (`app.ts` — `if (body.grant_type !== 'client_credentials') → unsupported_grant_type`); B1 adds a second accepted grant:

```
grant_type = urn:ietf:params:oauth:grant-type:token-exchange
```

The AJV token-request validator (`ascension/services/passports/src/validate.ts` — currently `grant_type: { const: 'client_credentials' }`) becomes a discriminated union over the two grant types, so a token-exchange body is schema-validated at the edge like every other request (untrusted-input discipline: **the parent is a hostile client too**).

### 1.2 Request

The parent authenticates **as itself** (client auth, exactly as today) **and** presents its own live access token as the subject. Both are required — see the confused-deputy control in §1.5.

```http
POST /v1/oauth/token                         Host: passports.…
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(cid_PARENT:wotk_sk_…)>     # parent client auth (client_secret_basic|_post)

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<parent access token (at+jwt)>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&scope=play:raid                              # REDUCED: ⊆ (parent scope ∩ delegable allowlist) — §3
&audience=agent-arena          # RFC 8693 audience = the shared resource-server aud
&squad_id=sqd_01J…                            # WoT binding: the squad this child joins (mint-or-reuse; §2)
&raid_id=rid_01J…                             # WoT binding: the raid instance (OPTIONAL at squad-form; §2)
&slot=2                                        # WoT binding: 0-based squad slot (one live session per slot; §5.1)
```

- `subject_token` is the parent's **still-valid** `at+jwt`. It is verified with `verifyAccessToken` (`wot-auth/src/tokens.ts`) exactly like any resource server verifies it — signature (JWKS/EdDSA), `iss`/`aud`/`exp`, `typ:at+jwt`.
- **No `actor_token`.** RFC 8693's `actor_token` is unused: the acting party (the parent) is the authenticated client, and the child is a *new* narrowed subject, not an impersonation. The delegation direction is recorded in `act` / `delegation` (§2), capped at one level.
- `squad_id` / `raid_id` / `slot` are **WoT extension parameters** (RFC 8693 permits additional request parameters). `api-architect` fixes the exact grammar in v1.3.0; IDs follow the `<prefix>_<ULID>` convention (`wot-store/src/ids.ts`) — new prefixes `sqd` (squad), `rid` (raid instance), `dlg` (delegation grant) are added to the `IdPrefix` union.

### 1.3 Response (RFC 8693 §2.2.1)

One call mints **one** child token. A 5-agent squad = 5 calls (one per slot). Each response:

```jsonc
{
  "access_token": "eyJ… (child at+jwt)",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 300,                 // = min(DELEGATED_TTL_CAP=300, parent_exp − now); NEVER > parent remaining
  "scope": "play:raid"               // the granted (narrowed) child scope
}
```

- **`expires_in` is capped twice:** at `DELEGATED_TTL_CAP` (300 s, a new `wot-auth/config.ts` constant) **and** at the parent token's remaining lifetime. The child's `exp` is `≤ subject_token.exp`, always (agent-passports §7.3). A long raid is sustained by the parent **re-exchanging** (it holds the secret; children never do).
- Failures use RFC 6749/8693 error codes with **no enumeration oracle** (agent-passports §2.1): `invalid_client` (bad/absent parent client auth, or `subject_token.client_id ≠ authenticated client_id`), `invalid_grant` (expired/invalid/revoked `subject_token`), `invalid_scope` (child scope ⊄ allowed set), `invalid_request` (re-delegation attempt, malformed binding). No response distinguishes "parent revoked" from "subject_token expired" beyond the coarse code.

### 1.4 Mint-side algorithm (B1, in the token endpoint)

On a token-exchange request, after edge schema-validation and the token-exchange **rate-limit buckets** (§6):

1. **Authenticate the parent client** — same `verifySecret` constant-time path as `client_credentials` (`app.ts`); unknown `client_id` burns the `DUMMY_HASH` path (no oracle). Assert `passports/{cid_PARENT}.status == active` and `owners/{owner}.status == active`.
2. **Verify the `subject_token`** with `verifyAccessToken`. Reject on any failure (`invalid_grant`).
3. **Bind subject to client:** assert `subject_token.client_id === authenticated client_id`. *A parent may only exchange its **own** live token* (confused-deputy / stolen-subject defense, §1.5).
4. **No-re-delegation gate (depth cap):** assert the `subject_token` is a **root** token — `subject_token.delegation` is absent/null **and** `subject_token.act` is null **and** `subject_token.parent_agent_id` is null. A delegated child presented as a subject is rejected `invalid_request` ("re-delegation is not permitted"). See §4.
5. **Scope narrowing:** compute `child_scope = requested_scope ∩ subject_token.scope ∩ DELEGABLE_SCOPES` (default to `subject_token.scope ∩ DELEGABLE_SCOPES` if `scope` omitted). If `requested_scope ⊄` that set → `invalid_scope`. See §3.
6. **Live-child caps (anti-farming):** assert this owner is under its live-child cap and this squad is under `MAX_SQUAD_SIZE` (5); assert `slot` is free in the grant. Else `invalid_request` / 429 (§6).
7. **Open/extend the delegation grant** — mint-or-reuse `dlg_…` for `(cid_PARENT, squad_id)`; record `raid_id`, `slot`, `child_scope`, `owner_id`, `expiresAt` (§5.4).
8. **Mint the child token** via `mintAccessToken` (extended, §2.1): `owner_id = subject_token.owner_id` (**never** caller-supplied), `league = subject_token.league` (budget class travels — a child can't jump to a more generous league), narrowed `scope`, `adapters ⊆ parent`, `ttlSeconds = min(300, parent_exp − now)`, the `delegation` claim, `act = { sub: parent_agent_id }`, `parent_agent_id`.
9. **Log** `token_exchanged` with `request_id`, `cid_PARENT`, `owner_id`, `squad_id`, `raid_id`, `slot`, child `jti`, `scope`. Never log tokens.

### 1.5 Why client-auth **and** subject-token (confused deputy)

Requiring *both* the parent's client credentials **and** a live `subject_token` whose `client_id` matches the authenticated client means: a leaked parent `at+jwt` **alone** cannot be exchanged (no secret ⇒ step 1 fails), and a valid client that authenticated cannot exchange **someone else's** subject token (step 3 fails). The only party that can mint a child for passport P is a holder of P's secret presenting P's own live token. This closes the "exchange a captured token into fresh, differently-scoped tokens" pivot.

---

## 2. The `delegation` claim

### 2.1 Child token claims (`at+jwt`, RFC 9068 base + delegation)

Header unchanged: `typ:"at+jwt"`, `alg:"EdDSA"`, `kid`. Body extends the §2.3 root claim set:

```jsonc
{
  // --- RFC 9068 base ---
  "iss": "https://agent-arena.invalid",
  "sub": "agt_slot_01J…",              // the squad-SLOT avatar id (child), minted per exchange
  "aud": "agent-arena",
  "exp": <= parent exp, and <= iat+300>,
  "iat": …, "jti": "child-uuid",       // unique per child token; the revocation/denylist key

  // --- WoT authz (inherited/narrowed) ---
  "client_id": "cid_PARENT",           // the PARENT passport (children have none of their own; §5.4)
  "owner_id":  "own_PARENT",           // inherited → ban lineage + anti-Sybil apply unchanged
  "agent_id":  "agt_slot_01J…",        // == sub
  "league":    "core",                 // inherited from parent (budget class travels, never widens)
  "scope":     "play:raid",            // strict subset (§3)
  "adapters":  [ /* ⊆ parent, per squad policy */ ],

  // --- RFC 8693 actor: the delegation chain, ONE level only ---
  "act": { "sub": "agt_PARENT" },      // the delegating avatar; NEVER nested (nesting ⇒ depth>1 ⇒ invalid)
  "parent_agent_id": "agt_PARENT",     // top-level convenience (present-but-null on roots since Phase 1, §2.3)

  // --- WoT delegation binding (NEW) ---
  "delegation": {
    "grant_id":         "dlg_01J…",    // cascade + revocation handle (§5.4)
    "parent_client_id": "cid_PARENT",
    "parent_agent_id":  "agt_PARENT",
    "parent_jti":       "…",           // the exact parent token that authorized this exchange (audit)
    "chain":            ["agt_PARENT", "agt_slot_01J…"],  // ordered root → child
    "depth":            1,             // MUST be exactly 1 for any child; MUST be ≤ MAX_DELEGATION_DEPTH
    "squad_id":         "sqd_01J…",    // squad binding (§5.1 session key)
    "slot":             2,             // 0-based squad slot; one live session per (squad_id, slot)
    "raid_id":          "rid_01J…"     // bound raid instance; null until the squad enters a raid (§3.2)
  }
}
```

A verifier tells "this is a delegated child" by **`delegation != null`** (equivalently `act != null`). It reads *what the child is bound to* directly off `delegation.squad_id` / `delegation.raid_id`, *who it derives from* off `delegation.parent_agent_id` / `act.sub`, and *that it is depth-capped* off `delegation.depth == 1` with an un-nested `act`.

### 2.2 Producer/consumer changes

- **`mintAccessToken`** (`wot-auth/src/tokens.ts`): today it hardcodes `act: null` and takes `parentAgentId?`. B1 adds an optional `delegation` input; when present, the payload emits `delegation`, `act: { sub: delegation.parent_agent_id }`, and `parent_agent_id`. Root mints are unchanged (`delegation` absent ⇒ `act:null`, `parent_agent_id:null`, no `delegation` key — the reserved-claim shape Phase 1 already ships).
- **`verifyAccessToken` / `AccessClaims`**: add a parsed `delegation: DelegationClaim | null` field (mirror the existing tolerant parsing of `act`/`parent_agent_id`). Resource servers (gateway `agent-auth.ts`, arena `arena.ts`) read it; a token **without** `delegation` verifies and authorizes exactly as today (regression-safe — see test §7.20).

---

## 3. Scope narrowing rules

### 3.1 The rule

```
child_scope  ⊆  subject_token.scope  ∩  DELEGABLE_SCOPES
```

Two gates, both required: the child can never hold a scope the **parent** doesn't hold (RFC 8693 down-scoping), **and** can only hold scopes that are *delegable at all*. `DELEGABLE_SCOPES` is a fixed allowlist in `wot-auth`:

| Scope | Delegable to a child? | Why |
|---|---|---|
| `play:raid` | **Yes** | The point of squads (gate item 1). |
| `spectate:read` | **Yes** (optional) | A squad member may need the live feed; read-only, no authority to amplify. |
| `play:duel` | **No** | Ranked 1v1 is one-passport-one-agent; delegated duels would be a boosting/Sybil vector (threat-model §1, §5). |
| `market:trade` | **No** | **The anti-laundering spine.** Children hold no economic scope, so a squad can never move Tokens/stakes (§6, PLAN "guild/tournament structures can't launder stakes"). |
| `negotiate:a2a` | **No** (Phase 4) | A2A settlement (gate item 2) is done by real passports, not ephemeral children; keeps escrow attribution on durable identities. |
| `caster:publish` | **No** | Casting is a distinct reserved scope on real passports (threat-model §11); never delegated. |
| `hunt:participate` | **No** | Hunt answers are per-Architect; no delegated fan-out. |

Requesting anything outside this set — *even a scope the parent legitimately holds*, e.g. `market:trade` — fails `invalid_scope`. The allowlist is checked **at mint** and the subset is **re-checked at the arena connect** against the child's own claims (defense in depth; a resource server never re-expands to parent scope).

### 3.2 What a child MAY and MAY NOT do

**MAY:** open exactly one `play:raid` WSS session bound to its `squad_id`/`raid_id`; submit raid actions (schema-validated, engine-legal like any action); read the spectator feed if granted `spectate:read`; be revived/downed within its raid; reconnect by re-presenting the *same* still-valid child token (supersede its own slot, §5.1).

**MAY NOT:** queue or play a ranked duel (`play:duel` not delegable → 4403 at a `play:duel` connect, 403 at duel-queue REST); place market orders / move Tokens / stake (`market:trade` not delegable → 403 `insufficient_scope`); open A2A negotiation or cast; **mint a further child** (§4); register/rotate/revoke passports (management plane is Firebase-human-only, never token-authed — see agent-passports §1 endpoint table); act in a **different** raid or squad than it is bound to (§5.1, §6 "reuse across raids"); widen its league.

---

## 4. No re-delegation (depth cap = 1)

`MAX_DELEGATION_DEPTH = 1` (a `wot-auth` constant). A child is depth 1; a child **cannot** mint a grandchild.

**The check (mint side, §1.4 step 4):** the token-exchange handler accepts a `subject_token` **only if it is a root token** — all three of `subject_token.delegation`, `subject_token.act`, `subject_token.parent_agent_id` are absent/null. Presenting a child token as `subject_token` fails `invalid_request` before any minting. Belt-and-suspenders: the minted child's `delegation.depth = subject_depth + 1` is asserted `≤ MAX_DELEGATION_DEPTH`, and `act` is emitted **flat** (`{ sub: parent }`, never `{ sub: parent, act: {…} }`) so any nested `act` on an inbound subject is itself proof of an illegal depth and is rejected.

Because depth is capped at 1, the delegation graph is always a **two-level star** (one parent, ≤5 leaf children), never a tree — there is no path to multiply authority or evade the per-owner caps by chaining.

---

## 5. One-session-per-child + revocation cascade

### 5.1 One live session per child (per squad slot)

The arena session registry (`arena.ts`, the `registry` Map, keyed by `client_id` today) keys **root** sessions by `client_id` and **child** sessions by their squad slot:

```
registryKey(claims) = claims.delegation
    ? `${claims.delegation.squad_id}:${claims.delegation.slot}`   // one session per squad slot
    : claims.client_id                                            // roots unchanged
```

- **Why not key children by `client_id`:** all 5 children (and the parent) share `cid_PARENT`; keying by it would make them supersede each other and collapse the squad to one slot. Keying by `(squad_id, slot)` gives **exactly one live session per squad member** while still letting the parent hold its own root session.
- **Reconnect / supersede** reuses the existing `supersede()` path (`arena.ts`): a second connect for the *same* `(squad_id, slot)` emits `session_superseded` (close **4409**) and transfers the live raid-slot binding to the new socket. A child that dropped reconnects by re-presenting its *still-valid* token (it can't re-mint; if expired, the parent re-exchanges for that slot → the fresh token supersedes the slot).
- **Raid binding checked at connect:** the `play:raid` `hello` names the raid it wants to join; the arena asserts `hello.raid_id === delegation.raid_id` and `delegation.squad_id` matches the forming/live squad. Mismatch → close **4403** (this is the "child bound to raid A rejected in raid B" control, §6).
- Per-owner concurrent-session accounting (agent-passports §6.2) counts each live child against the owner's aggregate — a 5-child squad consumes 5 of the owner's live-session budget.

### 5.2 What triggers a cascade

A child token is **valid** only while **all** hold; any one failing invalidates the child:

1. parent passport `status == active` (`passports/{cid_PARENT}`),
2. owner `status == active` (`owners/{own_PARENT}`),
3. the delegation grant `status == active` and not past `expiresAt` (`dlg_…`, §5.4),
4. the child `jti` is not on the denylist (`revocations/{jti}`),
5. within the child's own `exp`.

Cascade triggers, therefore: **parent passport revoked** (agent-passports §5.2), **owner banned** (§5.3 — voids all passports *and lineage*), **grant explicitly dissolved** (squad teardown, or parent chooses to end the squad), **grant TTL elapsed**, or the optional **parent-session-bound** mode (§5.3). Revoking or expiring **one** child (its `jti`) affects only that child — siblings and the parent are untouched (child independence, test §7.12).

### 5.3 Anchor: the parent *passport*, with an optional session pin

The grant is anchored to the durable **parent passport**, not a transient parent socket — this matches the existing status-flag + rolling-check infrastructure and means the parent need not hold a live WSS session for the squad to raid. `PLAN`/MISSION also call for *"the parent's session ending"* to cascade: B1 supports an **optional** `bind_to_session` flag on the grant — when set, the arena revokes the grant (and thus all its children) when the pinned parent session closes. Default is passport-anchored (grant lives until parent revoke / owner ban / explicit dissolve / TTL). Either way, the cascade is authoritative and bounded (§5.5).

### 5.4 Where the state lives (reuses agent-passports §5.4)

agent-passports §5.4 **reserved** `revocations/{jti}` for exactly this. Phase 4 lights it up and adds a thin grant record. New store interface in `wot-store` (in-memory now, Firestore later, same interface pattern as every other store):

```ts
interface DelegationGrant {
  grantId: string; squadId: string; raidId: string | null;
  parentClientId: string; parentAgentId: string; ownerId: string;
  scopes: string[]; slots: number;                 // <= MAX_SQUAD_SIZE
  status: 'active' | 'revoked';
  boundSessionId?: string;                          // set only in bind_to_session mode (§5.3)
  createdAt: string; expiresAt: string;
}
interface DelegationStore {
  openOrGet(input): Promise<DelegationGrant>;       // mint-or-reuse per (parentClientId, squadId)
  getGrant(grantId): Promise<DelegationGrant | null>;
  revokeGrant(grantId): Promise<boolean>;           // dissolve squad → cascade
  isJtiRevoked(jti): Promise<boolean>;              // revocations/{jti}
  revokeJti(jti): Promise<boolean>;                 // kill one child
}
```

**Key implementability win — owner/parent cascade is *free*.** Because a child's `client_id` **is** the parent's `cid_PARENT` (§2.1), the arena's existing connect check and rolling-revocation loop (`arena.ts` — `stores.passports.getByClientId(ctx.clientId)` then `status !== 'active'` → close **4410**) **already** resolve the parent passport for a child session and already cascade **owner ban** (`banOwner` flips the parent passport to `revoked`) and **parent revoke** — with **zero** new code. B1 only adds, for sessions where `ctx.claims.delegation != null`, two extra reads in the *same* connect + rolling loop: the **grant status** and the **jti denylist**. That is the entire net-new revocation surface.

### 5.5 Check cadence (the three gates, unchanged shape)

| Gate | When | Child-session reads | Effect |
|---|---|---|---|
| **Connect** | every `play:raid` `hello` | strongly-consistent: parent passport + owner status (existing, via shared `client_id`) **+** grant status **+** jti denylist **+** raid/squad binding | reject **4401/4403** before a session opens |
| **Rolling** | every 30 s (`revocationIntervalMs`, `arena/config.ts`) | same set, batched, over all live child sessions | close **4410** + `session_revoked` ⇒ orphaned children die **≤ 30 s** after any cascade trigger |
| **Management edge** | every REST/MCP call bearing a child token | in-memory snapshot + token `exp` | 401/403; the ≤300 s child TTL bounds staleness |

The two bounding knobs are the **≤ 300 s child TTL** and the **30 s rolling interval**: a banned owner's squad cannot keep raiding beyond one interval, and a revoked child cannot outlive its short token.

---

## 6. Anti-farming / anti-abuse

Delegation is a **new mint vector** and a **new fan-out vector**; both are bounded so a squad can neither spin up farming loops nor launder stakes. This ties directly to the existing per-owner anti-Sybil model (agent-passports §6; threat-model §1, §5, §8): children inherit `owner_id`, so a "fleet" always collapses to one bannable owner.

**Rate limits (new buckets in the token endpoint, mirroring `app.ts`'s `RateLimiter` usage):**

| Bucket | Limit (Phase 4 default, tunable) | Rationale |
|---|---|---|
| token-exchange per **parent passport** | 20 / min | bounds re-exchange churn for one squad |
| token-exchange per **owner** | 60 / min | fleet-wide mint brake (Sybil) |
| **live children per owner** | ≤ 25 concurrent | caps aggregate delegated fan-out |
| **squad size** (`MAX_SQUAD_SIZE`) | 5 | the raid cap; slot must be `< 5` and free in the grant |

**Structural anti-farming (the strong controls — they don't depend on tuning):**

- **No economic scope.** `market:trade` and `play:duel` are non-delegable (§3), so children *cannot* place orders, move Tokens, stake, or farm ranked Weights. Raid rewards/payouts are posted by the engine to the **owner's** wallet through declared faucets (double-entry ledger, conservation property; threat-model §7) — a squad of children is never itself a faucet.
- **Raid-scoped + single-use-per-binding.** A child is bound to one `(squad_id, raid_id)`; reusing one delegation mint across raids is blocked at connect (§5.1). One exchange ≠ a reusable farming key.
- **Owner binding + ban lineage.** Every child carries `owner_id`; owner ban voids the parent, the grant, and thus every child (§5.2). A delegation ring is one moderation action.
- **Depth cap = 1** (§4) — no tree, no authority multiplication.

### Delegation-specific threat table

Following the house pattern — **(a) attack, (b) control, (c) if removed.**

- **T-D1 Privilege escalation via child.** *(a)* Child requests/forges a scope the parent lacks, or a non-delegable scope (`market:trade`, `play:duel`). *(b)* `child_scope ⊆ parent ∩ DELEGABLE_SCOPES` at mint (§3) **and** re-checked at connect against the child's *own* claims; a forged scope fails EdDSA verification; a resource server never re-expands to parent scope. *(c)* Delegation becomes an authority-amplifier — the exact thing the gate forbids; a raid child could trade/duel/launder.
- **T-D2 Replay of child tokens.** *(a)* Steal a child `at+jwt` (leaked log, compromised host) and drive its slot. *(b)* ≤300 s TTL + **no re-mint** (child has no secret) bound the window; one-session-per-slot means a replay *supersedes* and is observable (kicks the legit child); jti denylist + cascade kill it ≤30 s; `raid_id`/`squad_id` binding rejects it outside its raid; optional DPoP (`cnf.jkt`, agent-passports §2.6) inherited from the parent makes a bare token inert; TLS, tokens never logged. *(c)* A single leak becomes durable, re-scopeable squad access with no eviction.
- **T-D3 Orphaned children after parent revoke/ban.** *(a)* Ban/revoke the parent but children keep raiding. *(b)* Cascade via the shared-`client_id` connect + rolling check (owner + parent) **plus** grant/jti checks (§5.4–5.5); children die ≤30 s. *(c)* Banning an owner leaves their squad running — a moderation hole and a ban-evasion path.
- **T-D4 Squad token reuse across raids.** *(a)* One minted child reused in a different raid/squad to fan out farming. *(b)* `hello.raid_id === delegation.raid_id` and `squad_id` match asserted at connect → 4403 on mismatch; single-use-per-binding (§5.1). *(c)* One exchange becomes a reusable multi-raid farming key, defeating the rate/fan-out caps.
- **T-D5 Confused deputy.** *(a)* Get the arena/parent to act with the parent's *fuller* authority for a child action; or exchange a *captured* parent token. *(b)* The arena authorizes strictly on the **child's** narrowed claims, never the parent's; the exchange requires parent **client auth + subject_token whose `client_id` matches** (§1.5) so a captured token alone can't be exchanged; the delegation chain is explicit and verifiable so no component silently borrows parent scope. *(c)* A child action could execute at parent authority, or a stolen token could be laundered into fresh differently-scoped tokens.
- **T-D6 Re-delegation / depth escalation.** *(a)* A child mints a grandchild to multiply authority or evade per-owner caps. *(b)* Depth cap = 1 (§4): subject must be a root token; nested `act` rejected; result depth asserted ≤ 1. *(c)* An unbounded delegation tree — authority amplification and cap evasion.
- **T-D7 Delegation mint flood (farming loops).** *(a)* Rapidly mint/re-mint children to spin compute/stake loops. *(b)* Per-parent + per-owner token-exchange rate buckets, live-child cap, squad-size cap, and — decisively — **no economic scope** so the loop earns nothing a normal agent couldn't (§6). *(c)* Delegation becomes a cheap farming/DoS lever on the token endpoint.
- **T-D8 Cross-owner delegation (ban evasion / rep borrowing).** *(a)* Parent delegates to another owner's agent, or stamps a child with a different `owner_id` to escape a ban or borrow standing. *(b)* `child.owner_id = subject_token.owner_id`, **never caller-supplied** (§1.4 step 8); there is no "delegate to agent X of owner Y" — children are the parent's own sub-identities. *(c)* Ban lineage and per-owner Sybil accounting break; a banned owner borrows a clean identity.

---

## 7. Test assertions B1 must ship

Written to match the existing suites (`node:test`, `assert/strict`; passports service tests in `ascension/services/passports/test/passports.test.ts`, arena tests in `ascension/services/arena/test/arena.test.ts`). Each maps to a control above.

**Mint side (passports service / `wot-auth`):**

1. **Child scope ⊄ parent → rejected.** Parent lacking `play:raid` (or requesting a scope the parent doesn't hold) → `invalid_scope`, **no token minted**. *(§3, T-D1)*
2. **Non-delegable scope rejected even if parent holds it.** Parent *with* `market:trade` requests a child `market:trade` (or `play:duel`) → `invalid_scope`. *(§3, T-D1)*
3. **Scope defaults + narrows.** Omitted `scope` ⇒ child scope = `parent ∩ DELEGABLE_SCOPES`; never a superset. *(§3)*
4. **Re-delegation rejected.** A child token presented as `subject_token` → `invalid_request` ("re-delegation not permitted"); nothing minted. *(§4, T-D6)*
5. **Depth cap shape.** A minted child has `delegation.depth === 1`, `act === { sub: parent_agent_id }` (flat, un-nested), `parent_agent_id` set; a nested inbound `act` is rejected. *(§4)*
6. **Subject must be live + own.** Expired/invalid `subject_token` → `invalid_grant`; a `subject_token` whose `client_id ≠` the authenticated client → `invalid_client`. *(§1.5, T-D5)*
7. **Claim well-formedness.** Child verifies under JWKS as `at+jwt`/EdDSA and carries a complete `delegation` (`grant_id`, `chain`, `depth`, `squad_id`, `slot`, `raid_id`), inheriting `owner_id`/`league` from the parent. *(§2)*
8. **TTL cap.** Child `exp ≤ min(iat+300, parent_exp)`; never `> parent_exp`. *(§1.3)*
9. **Cross-owner blocked.** Child `owner_id` always equals `subject_token.owner_id`; a caller-supplied owner field is ignored. *(§1.4, T-D8)*
10. **Child cannot re-mint / manage.** A child token cannot be used at `client_credentials` (it has no secret) and is refused at rotate/revoke/register. *(§0, §3.2)*
11. **Exchange rate limits.** Per-parent and per-owner token-exchange buckets return 429 at threshold; a 6th slot or an over-cap owner is rejected. *(§6, T-D7)*
12. **No enumeration oracle preserved.** Bad parent client auth vs. bad `subject_token` are indistinguishable beyond the coarse RFC code + timing. *(§1.3)*
13. **Reserved→enforced regression.** A Phase-1/3 **root** token (no `delegation`) still verifies and authorizes unchanged; `mintAccessToken` without `delegation` emits `act:null`/`parent_agent_id:null`/no `delegation`. *(§2.2)*

**Enforcement / cascade side (arena):**

14. **Scope enforcement at connect.** A `play:raid` child is rejected at a `play:duel` connect (**4403**) and at a `market:trade` REST route (**403 `insufficient_scope`**). *(§3.2, T-D1)*
15. **Raid binding.** A child bound to raid A is rejected at a raid-B connect (**4403**); a `squad_id` mismatch is rejected. *(§5.1, T-D4)*
16. **One-session-per-child slot.** Two connects for the same `(squad_id, slot)` → second supersedes first (`session_superseded`, close **4409**); live raid-slot binding transfers. *(§5.1)*
17. **Cascade — parent revoke.** Revoke the parent passport mid-raid → every child session closes **≤ 30 s** (**4410**, `session_revoked`); a new exchange from that parent fails. *(§5.2, T-D3)*
18. **Cascade — owner ban.** Ban the owner → parent **and** all children die **≤ 30 s**; new exchanges fail. *(§5.2, T-D3)*
19. **Cascade — grant dissolve, siblings isolated.** `revokeGrant` on squad G kills all of G's children; a second squad G′ under the same owner is unaffected; and revoking one child `jti` kills only that child (independence). *(§5.2, §5.4, T-D2)*
20. **Gate integration (with C1/sim-qa).** End-to-end: parent authenticates → exchanges 5 children (narrowed `play:raid`) → squad forms + queues → raid runs → boss defeated → replay retrievable; plus the security asserts (child ⊄ parent rejected; revocation cascade; no re-delegation) all green. *(PLAN §Gate.1, §Stage-C)*

---

## 8. What the contracts (api-architect, A2) need from this doc

- The **token-exchange grant** on `POST /v1/oauth/token`: request params (`grant_type`, `subject_token`, `subject_token_type`, `requested_token_type`, `scope`, `audience`, `squad_id`, `raid_id`, `slot`) and the RFC 8693 response (`access_token`, `issued_token_type`, `token_type`, `expires_in`, `scope`) → OpenAPI, as an additive v1.3.0 path variant (Tier-0 green; root `client_credentials` unchanged).
- The **`delegation` claim schema** (§2.1) added to the `Bearer` security scheme's documented claim set; roots keep `delegation` absent/null.
- The **`DELEGABLE_SCOPES` allowlist** (§3.1) and the `play:raid` grant flip (agent-passports §3.2) in the scope enum.
- New **ID prefixes** `sqd` / `rid` / `dlg` in the shared id grammar (`wot-store/src/ids.ts`).
- Reuse the existing **WSS close codes** (4401/4403/4409/4410) and the `session_superseded` / `session_revoked` event schemas (agent-passports §4.3, §5.4) for child sessions — **no new codes**.
- Error bodies use RFC 6749/8693 codes (`invalid_client`, `invalid_grant`, `invalid_scope`, `invalid_request`) with no enumeration oracle.

---

*Delegation narrows; it never widens. The parent lends authority it already holds, once, to children that cannot pass it on — and one ban ends the whole lineage.*
