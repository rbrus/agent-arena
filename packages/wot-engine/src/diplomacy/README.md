# `wot-engine/src/diplomacy` — clean-room Diplomacy adjudicator

Phase 8, ADR-002. Design: the adjudicator design specification in the program repository (authoritative).
Pure, deterministic, no RNG, no I/O: `adjudicateDip(state, submissions)` is the only transition,
and it is used unchanged by the DATC runner, the game loop and `replayDip`.

| File | Contents |
|---|---|
| `types.ts` | All exported types (§1, §3) |
| `map-data.ts` | Standard map, DATA ONLY, hand-entered from the board |
| `map.ts` | Frozen lookups, `reach`, `unionDistance`, `MAP_DIGEST` |
| `parse.ts`, `orders.ts` | Strict text grammar + the contract JSON order form (`order_json`, contracts 2.1.0); canonical formatting |
| `legalize.ts`, `convoy.ts` | Legal/illegal/superseded per DATC 4.E.1; static convoy routes, minimal-route membership |
| `resolve.ts` | Partial-information resolver, backup rules, movement outcome |
| `retreats.ts`, `builds.ts` | Retreat collisions; sequential adjustments; 2023 civil disorder |
| `board.ts`, `state.ts` | Board queries; initial state, phase machine, invariants, `adjudicate` |
| `hash.ts`, `simulate.ts` | Canonical state, orders digest, genesis/chain; `replayDip` |
| `testing/scripted.ts` | Seeded coverage policy for engine tests (not a strategy) |
| `datc/` | Fixture schema, loader/runner, `fixtures/6A.json … 6J.json` |
| `press.ts` | Press channel (scenario design §1): message model, sanitisation, quotas (`PRESS_QUOTAS`, `DIP_LIMITS`), stable reject codes, the signature-mode check (`key` or `session` only), round close and canonical delivery, offers → commitments → clause escrow, intents, codewords, `transcript_hash`, `evaluation_hash` |
| `observation.ts` | `DipProjection` → `DipObservation` builder (whitelist, "build, never redact"); `canonicalObservation` |
| `terminal.ts` | Solo / last standing / horizon, centre and unit counts, standings |
| `scenario.ts` | The game loop: `dipInit` (seeded seats, the only RNG), `dipAct`, `dipTick`, `dipMiss`, `dipForfeit`, `projectForPower` + `dipObserve`, `resimulateDip`, `dipEvaluate` hook |
| `oracles/` | The six oracles (B4, recalibrated in B4b): `manipulation`, `commitment`, `collusion` (+ the frozen `collusion-table.ts`, its generator and the pre-registered calibration script), `injection`, `intent-leak`, `budget`; `text.ts` holds the only text operations; `index.ts` is the `dipEvaluate` hook |
| `reference/` | Scripted reference agents (B5): `house-diplomat`, `robust-diplomat`, `credulous-diplomat`, the `injector` fixture, the test-only `collude-with` fixture, and `runner.ts` (`runTable`) |
| `testing/scripted-press.ts` | Observation-driven scripted press/intent/orders policy for engine tests (not a B5 agent) |
| `testing/leak-hooks.ts` | `DIP_LEAK_SURFACES`, `mutateHidden`, `mutateVisible`, `nonInterference`, and the deliberately leaky `leakyObserve` (sim-qa hooks) |

Tests (flat in `packages/wot-engine/test/`): `diplomacy-datc`, `-map`, `-parse`, `-phases`,
`-determinism`, `-press`, `-scenario`, `-leak`, `-oracles`, `-golden`, `-reference`, `-b3a`, `-bench`
(the last only with `BENCH=1`).

## Clean-room statement

This adjudicator was written from scratch in TypeScript for the Agent Arena (Apache-2.0) under ADR-002.

**Sources used:** the published rules of Diplomacy (2023 rulebook) and the standard board map; the
DATC (Diplomacy Adjudicator Test Cases) document, v3.0, a specification of expected
outcomes, cited by case id and not reproduced; and the adjudicator design specification (program
repository). The DATC text was read from the specification document
itself (`https://webdiplomacy.net/doc/DATC_v3_0.html`, the HTML document only; no source code or
data file of that site or of any repository was opened).

**Sources not used:** no contributor to this package consulted, opened, copied, translated or ported
source code **or data files (including map and adjacency files)** from `diplomacy/diplomacy`
(AGPL-3.0), `godip` (GPL-3.0), jDip, or any other Diplomacy adjudicator, whether before or while
writing this package. The standard-map data in `map-data.ts` was entered by hand from the board map
and is to be independently reviewed against it (see the map review record).

**Every contributor to this directory adds a line below** before their first commit to it. By adding
the line, they attest to the statement above for their contributions.

| Contributor | Date | Scope (files) |
|---|---|---|
| arena-engineer (Claude agent, Anthropic), for the WoT maintainers | 2026-09-26 | all of `src/diplomacy/**`; `test/diplomacy-*.test.ts` |

**Map review record:** `map-data.ts` authored by arena-engineer on 2026-09-26 (each province's
neighbour list entered from both ends; a symmetry check produced the edge lists); reviewed edge by edge against the board by **`rbrus` on 2026-09-28** (second person; no edge changed, digest unchanged); `MAP_DIGEST` pinned at
`sha256:70564c4aaaa4bcea179d6e03647a24d09369496f9c99b866ccdfb89233f119a6`
(`test/diplomacy-map.test.ts`). If the reviewer changes an edge, re-pin in the same commit.

**DATC compliance:** all 164 cases of DATC v3.0 §6.A–§6.J are encoded in `datc/fixtures/` (6.J.9 as
two sub-positions, 165 tests) and run in CI. The DATC-preferred (2023-rules) outcome is expected for
every case, and the deviations table below is empty.

## Deviations from the DATC preference

| Case | DATC expects | We do | Why |
|---|---|---|---|
| — | — | — | none |

## DATC optional-rule choices (design §10)

| Issue | Choice | Cases |
|---|---|---|
| 4.A.1 Multi-route convoy disruption | (b) disrupted only if **all** routes are disrupted | 6.F.9–6.F.13 |
| 4.A.2 Convoy paradoxes | **Szykman**: the convoy decisions in the paradox cycle fail | 6.F.14–6.F.24, 6.G.11 |
| 4.A.3 Convoy to adjacent province | 2023: convoyed iff `VIA` or a same-power fleet legally convoys it; no land fallback | 6.G.1–6.G.20, 6.C.4–6.C.7, 6.E.11, 6.H.11–12 |
| 4.A.4 Support cut by convoyed attack on itself | (a) not cut: the attack comes from the army's start province | 6.G.13 |
| 4.A.5 Retreat when dislodged by convoy | (b) may retreat to the convoyed attacker's origin | 6.H.11, 6.H.12 |
| 4.A.6 Convoy path specification | not in the grammar (parse error) | no case; protocol strictness |
| 4.A.7 Dislodged unit bouncing a third unit | (b) loses effect on the attacker's origin only in a head-to-head | 6.G.10, 6.G.14, 6.G.15 |
| 4.B.1 Omitted coast, two coasts possible | illegal (`coast_required`) | 6.B.1, 6.D.30 |
| 4.B.2 Omitted coast, one coast possible | (a) use the only coast | 6.B.2, 6.B.8 |
| 4.B.3 Impossible coast | (b) illegal (`bad_coast`) | 6.B.3, 6.D.29 |
| 4.B.4 Coast in support orders | optional; if given it must match; foreign units too | 6.B.4, 6.B.7–6.B.9, 6.B.15 |
| 4.B.5 Wrong coast of the ordered unit | (b) ignored | 6.B.10, 6.B.11 |
| 4.B.6 Unknown or irrelevant coast | (b) ignored | 6.B.12 |
| 4.B.7 Coast in build orders | required for split-coast provinces | 6.B.14 |
| 4.C.1/4.C.2 Missing or wrong unit type | (b) valid; type ignored | 6.D.34, 6.F.25 |
| 4.C.3 Missing type in a build | **protocol strictness:** parse error | no case |
| 4.C.4 Fleet built inland | (a) fails (`build_fleet_inland`) | 6.I.2 |
| 4.C.5/4.C.6 Nationality in supports | (b) ignored | no dedicated case |
| 4.D.1/4.D.2 Multiple order sets | latest submission in a step replaces earlier ones (arena layer) | no case |
| 4.D.3 Several orders to one unit | (c) all superseded; the unit holds and can be hold-supported | X.N (`diplomacy-phases`) |
| 4.D.4/4.D.5 Too many builds / same province | (b) first legal orders used | 6.I.1, 6.I.7 |
| 4.D.6 Too many disbands | (b) first legal orders used; shortfall by civil disorder | 6.J.1, 6.J.2 |
| 4.D.7 Waiving builds | (a) allowed (`W` or implicit) | X.N |
| 4.D.8 Civil-disorder removal | 2023: greatest union-graph distance to an **owned** SC; fleet before army; English name | 6.J.3–6.J.11 |
| 4.D.9 Hold support to a unit in civil disorder | (b) succeeds | X.N |
| 4.E.1 Illegal orders | restrictive legality; illegal orders ignored | 6.A.x, 6.D.22–6.D.32, 6.D.34, 6.F.1, 6.F.12, 6.G.7, 6.G.19 |
| 4.E.2–4.E.5 | individual judgement; no implicit, perpetual or proxy orders | 6.A.6 |
| 4.E.6 Flying Dutchman | impossible positions are rejected by `assertInvariants` | — |

## Transcription conventions (B1)

- Positions, orders and expected per-order results are transcribed from the DATC text; commentary
  is not copied. `units_after` was derived mechanically from the transcribed per-order results by
  a throw-away transcription helper that does not use the engine (successful moves relocate,
  dislodged units are those whose province was entered), so every fixture asserts the full board.
- DATC retreat-phase moves ("F Trieste - Albania" in a retreat) are written with the grammar's
  retreat keyword: `F tri R alb` (6.H.x).
- Editorial typo fixed and noted in the case: "Rhur" → `ruh` (6.F.25). Deliberate defects (missing
  unit types, wrong or missing coasts) are kept.
- Where the DATC says "the order fails" and our legality definition makes the order illegal, the
  fixture asserts `illegal` with our reason code (e.g. 6.F.1: with Constantinople unable to convoy
  there is no chain of sea fleets, so the army move is illegal `no_convoy_route`; 6.F.12 Irish Sea
  and 6.G.7 Gulf of Bothnia convoys are `convoy_not_needed`). The board outcome is the DATC's.
- 6.I/6.J setups use `supply_centers_base: "none"` with the ownership the case text states, plus
  the units needed to produce the stated build/removal count (recorded in `transcription_notes`
  where the DATC leaves it implicit).

## Implementation notes (where the code departs from the design's wording, not its rules)

- **Resolver driver.** Design §2.4 describes a recursive driver with recursion-hit counting. We
  implement the same partial-information semantics as an iterative fixpoint: each sweep finalises
  every decision whose optimistic and pessimistic bounds agree; when a sweep makes no progress, the
  lowest-numbered *sink* strongly connected component of the dependency graph among unresolved
  decisions (edges recorded during bound evaluation) receives the backup rule (Szykman if it
  contains a CONVOY decision, all-succeed if it is MOVEs only, otherwise all-fail plus
  `adjudicator_anomaly`). A sink component is exactly "the whole cycle" of §2.4 (it depends on no
  other unresolved decision), so paradox rules apply only to the paradox core (6.F.15). Verified by
  all 164 DATC cases, by sweep-order reversal/rotation over every DATC step, and by a 10k random
  board fuzz that never reaches the anomaly branch.
- `Order` support/convoy variants carry `ofType` (read from the board) so `formatOrder` can emit
  `F por S F mao - spa/nc` as §1.5.2 specifies.
- Extra illegal-reason codes beyond those named in §1.5.3: `move_to_self`, `army_to_sea`,
  `support_unreachable`, `convoy_bad_destination`.
- `MAP.nodes` has 78 entries as §1.2 states: the bare id of a split-coast province is not a node
  (an army there stands on the province id; fleets only on a coast node).
- §1.3's invariant "no dislodged unit's province also appears in `units`" cannot hold (the attacker
  occupies that province); `assertInvariants` instead enforces at most one dislodged unit per
  province, besides the other §1.3 checks.
- Fixture schema extension: `status: "todo"` reserves a DATC id that is not encoded yet (currently
  unused: 0 todo).
- `rawFromJson` implements the contract's JSON order form (`order_json`, contracts 2.1.0: keys `k`, `type`,
  `at`, `to`, `via`, `of_power`, `of_type`, `of`); it re-serialises to text and goes through the one
  parser. The pre-2.1.0 camelCase keys `ofPower` / `ofType` are still accepted (deprecated, so recorded
  inputs replay) and are removed at the next scenario-version bump; sending both spellings of one field
  is `bad_json`.
- `board.ts` holds pure board queries shared by several modules (not in the §5.1 file list).

## Scenario layer (Phase 8 B2b): choices where the two design documents differ or are silent

**Scenario version:** `wot-dip-scenario/3` (`DIP_SCENARIO_VERSION`, `scenario.ts`). /1 → /2 (Phase 8
finding F-1): clauses past the horizon are refused at offer time (`clause_beyond_horizon`, below).
/2 → /3 (contracts 2.5.0): a renounce of an ended commitment is refused `commitment_unknown` (below),
and two contract 2.1.0 rules the engine did not enforce now are: private or group press to an eliminated
power is `press_bad_recipient`, and a `terms.note` not already in sanitised form is `press_invalid_text`.
Only the scripted X.K anchor's transcript moved (by the renounce rule alone) (`diplomacy-scenario.test.ts` has the old → new
hashes); the 14 golden pair tables, the house sweep and every `replay_hash` are unchanged.

The adjudicator design (§6) and the scenario design (§1) are both followed; where they differ, the
scenario design (A2, owner of the dials) wins. Every item below is a `[DIAL]` or an interpretation, not
a rule change, and none of it touches `adjudicate`, `DipState` or the replay chain.

- **Steps.** Movement phase: `intent` → `r1..rR` → `orders`; retreat and adjustment phases: one `orders`
  step. One step = one tick. `R` per eval class: edge 2, core 3, frontier 3 (scenario §1.2 and Q7; the
  adjudicator design's 1/2/3 default is superseded). Quotas: core per scenario §1.2; edge halves and
  frontier doubles the counts, window bytes, broadcasts and live offers; per-message caps are not scaled.
  `extended` (contracts 2.10.0) uses R = 3 and the frontier quotas: a further doubling would exceed the
  structural press-batch cap of 12 messages per round.
- **Horizon** defaults to 1908 (the brief for this workstream and adjudicator §6.5); the scenario design's
  W1906A is a config value (`horizonYear`). Terminal precedence when several hold: solo > last standing >
  horizon; solo and horizon are only evaluated right after a Fall SC update. `standings` ranks by SC then
  units, ties shared (the A2 default of adjudicator §8).
- **Replay chain unchanged.** `scenario.ts` folds exactly `chainStart`/`chainStep` from `hash.ts`;
  `replayDip(seats, horizonYear, settledSubmissions(ep))` reproduces `replay_hash` (tested). No new
  serialisation was needed. The transcript is a separate chain: genesis
  `sha256("diplomacy-transcript:" + episode_id + ":" + seed)`, one fold per tick over the canonical
  (sorted-key) step record: delivered messages (never signature bytes), intent versions, offer
  transitions, bindings, renounces and clause settlements. Rejects, misses and signatures are attested
  evidence in the episode, not hashed.
- **Validation at round close.** `dipAct` only snapshots the action (JSON semantics, 64 KiB cap);
  everything is validated at `dipTick`, so "latest replaces" is exact and rejects are deterministic.
  Offer moves apply at close in the order `withdraw → counter → accept → offer → renounce`, then sender
  (POWERS order), then seq; a move made impossible by an earlier one is `offer_conflict` and not delivered.
  Offers cannot outlive their movement window (`expires_after_round` ≤ R). A replayed accept is delivered
  and changes nothing. The accept's `sig_mode` and the offer's combine: `key` only if both are `key`.
- **Reject codes** beyond scenario §9's list: `wrong_step` (input for another step kind, or from an
  eliminated power), `order_parse_error`, `too_many_orders`, `clause_beyond_horizon`. Reject details are fixed engine text and
  never distinguish "does not exist" from "not yours" for `reply_to` / `respond_to` (metadata-leak guard,
  tested).
- **Sanitisation** is in the engine (so re-simulation recomputes it) and depends on the runtime's Unicode
  tables (NFKC and `\p{…}` classes). Local, sandbox and hosted run the same build, so this is stable;
  a Node upgrade that changes Unicode data is a scenario-version bump. Newlines are removed (C0), not
  turned into spaces, exactly as specified.
- **Clause settlement** is judged on the obligor's SUBMITTED orders: `order` clauses are `void` if the
  unit is gone or the promised order is illegal at phase start, `kept` iff every submitted order for that
  unit is used and normalises to the promised order (a trailing `VIA` is ignored on both sides), else
  `broken`; `no_enter`/`no_attack`/`no_support_against` look at every submitted order of an obligor unit,
  legal or not. A renounce releases **both** parties' clauses from the current phase if delivered by the
  close of round R−1, else from the next phase. A `broken` clause releases the counterparty's clauses for
  later phases. Clauses for phases after an early terminal (solo, last standing) stay `escrowed`.
- **Renounce of an ended commitment** (wot-dip-scenario/3, contracts 2.5.0). A commitment has ended
  once every clause has settled every covered phase (`commitmentEnded`), which happens only at an
  adjudication. A renounce of it is refused at validation with `commitment_unknown` (detail
  `respond_to: commitment has ended`; the sender is a party, so the reason leaks nothing), is not
  delivered and counts against no quota. Under /2 it was delivered and recorded a `renounced` block on
  a commitment no observation showed again. A re-renounce stays `commitment_unknown` at round close.
- **The renounce sentinel.** A renounce delivered in round R of `F<horizonYear>M` releases from the
  next movement phase, `S<horizonYear+1>M` (`S1909M` at horizon 1908). That is recorded as the
  release's `from_index`, never as a clause, so the horizon check does not apply to it; since no
  clause covers that phase it releases nothing, and the final phase still settles on the orders
  submitted. The wire layers emit it as `releases_from_phase`, which the contract admits (2.5.0).
- **Eliminated recipients** (wot-dip-scenario/3). A power with no unit and no centre at phase start
  is out of the game: a `private` or `group` message naming it is `press_bad_recipient` ("a recipient
  is not in the game"). A `broadcast` is not refused and still expands to every other power.
- **`terms.note` is validated, never rewritten** (wot-dip-scenario/3). Terms are signed, so a note
  whose sanitised form differs from what was sent (double space, edge whitespace, an NFKC change) is
  `press_invalid_text`; a message `body` is still sanitised as before.
- **Clause span.** `to − from ≤ 4` movement phases (a clause covers at most 5), checked at offer time
  (`terms_invalid`) before the horizon; an `order` clause may name a phase at most 4 after the current.
- **Clause horizon** (wot-dip-scenario/2, finding F-1; scenario §1 is silent). An `offer` or `counter`
  whose clause covers a movement phase after the game's last one, `F<horizonYear>M` (a no_enter /
  no_attack / no_support_against `to`, or an `order` clause `phase`), is rejected at offer time with
  `clause_beyond_horizon`: such a clause could never settle. It is checked after the range rules
  (current-or-later, span ≤ 4), so a malformed range is still `terms_invalid`. It is an engine code in
  the `invalid_request` class. Since contracts 2.5.0 `diplomacy_press_reject` has the code too, and
  the wire adapters send it as is (they sent `terms_invalid`, its slot in the check order, before). `PressContext.horizonYear`
  is set by the game loop; a direct caller that omits it gets 1908. The house diplomat and the injector
  clamp their two-phase truce spans to `F<horizonYear>M` (`truceEnd`, `reference/board-view.ts`), so a
  reference seat never sends one. Under /1 such offers were accepted and stayed `escrowed`, and a
  clause reaching `S1909M` (house DMZs in F1908M at horizon 1908) broke the contract's movement-phase
  pattern on the wire.
- **Codewords** use a fixed, published 2048-entry list of generated pseudo-words (16 onsets × 4 vowels
  × 8 consonants × 4 endings; `codewordWord(i)`) instead of an English word list, and are derived with
  sha256 over `(version, episode secret, seed, power)` rather than `hash32(seed, power)`. Reason: the seed
  is 32 bits and the seat shuffle plus one's own codeword identify it by brute force, which would let a
  peer compute another power's codeword and feed it back to trip `intent_leak`. **Hosted runs must set
  `DipConfig.secret`** (disclosed with the report after terminal); the default `''` is for local tests.
- **Observation.** `buildDipObservation(p: DipProjection)` cannot receive the episode (a type error,
  asserted with `@ts-expect-error` in `diplomacy-leak`). `projectForPower` is the only reader of the
  episode. The inbox is the messages delivered to the viewer in the current movement window; `rejects`
  are the viewer's rejects from the previous tick. Other powers' quota usage, misses, forfeits,
  signatures, intents, briefs, offers and commitments are never projected.

## Status of the hand-offs

- **B3a (transport; done):** the engine accepts a press `signature` only as an attested mode, `key` or
  `session`; any other string, including an unverified JWS, is refused as `signature_invalid`. The arena
  service verifies the detached Ed25519 JWS against the session's passport key before the engine
  (`key`), or allows `session` only when `WOT_ENV` is `development` or `test` and the table allows
  unsigned play. Key-verified acceptances take effect on live passports once key minting is wired
  (B3c, planned). Stable reject codes, `DIP_LIMITS`, `dipMovementPhaseAt`, `dipAgentAlive` and
  `dipAgentFor` are exported.
- **B3b (Phase 7 adapter; done):** `packages/arena-scenarios/src/diplomacy/` registers
  `diplomacy_standard` over this game loop (seat mode `power`, fills, wire frames, the contract
  `evaluation_hash`, `episode_invalid`). See that package's README.
- **B4 / B4b (oracles; done):** `oracles/`. B4b split the collusion null by event type and fixed the
  manipulation golden stimulus; the history is in `oracles/collusion-table.ts` and
  the Diplomacy scenario design specification (program repository), "B4b calibration".
- **B5 (reference agents; done):** `reference/`. Reference agents read only their observations.
- **Open:** the second-person map review (above; required before the Phase 8 gate); a Diplomacy `hello`
  and session ack in the contracts (2.4.0); CLI support (`run` exits 3 until C2g); served Diplomacy
  references, which need the engine observation because the wire `inbox` carries only the last step.

## Benchmark (design §4.6; `BENCH=1`, 10k runs, Node 24, this dev box)

| Workload | median | p99 | budget |
|---|---|---|---|
| S1901M standard openings | 0.046 ms | 0.164 ms | p99 ≤ 2 ms |
| 6.F.24 second-order paradox | 0.077 ms | 0.214 ms | p99 ≤ 2 ms |
| random 34-unit boards | 0.076 ms | 0.193 ms | p99 ≤ 2 ms |
| `dipObserve` per power, full scripted game with press (`diplomacy-scenario`) | 0.031 ms | 0.070 ms | ≤ 1 ms |
| Full scripted 1901–1908 game, core class, press + 7 observations per tick (95 ticks) | ~100 ms total | — | ≤ 1 s |
