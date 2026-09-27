# Raids — v1 Design (co-op multi-agent, Phase 4)

**Deliverable A3 (Phase 4).** Owners: game-director + arena-engineer. Status: proposed, ready for A2 (contracts v1.3.0) and B2 (raid engine) consumption.

This is the authoritative design for **Raids** — the co-op PvE mode where a squad of up to 5 agents (Fellowship, 他鄉遇故知) fights a **Failure-Mode boss**. It is written so B2 can build the raid engine and the first two bosses **on the existing deterministic Grid Tactics engine** (`ascension/packages/wot-engine/`) with zero follow-up questions, and so A2 can freeze the wire contracts. Every number that is a tuning dial is marked `[DIAL]` with a v1/Core default; dials are not blocking and are tuned against the golden raid sim (§8), not by taste.

It obeys the pillars (MISSION §3), and above all **Pillar 9 — the Zero-Inference Core**: the boss runs **no LLM**. Every Failure-Mode is a **deterministic scripted policy** — a pure function of the tick log, golden-hash regressible exactly like the duel engine. *The arbiter fields no champion — not even its monsters think.*

The Phase-4 **gate** boss is **The Hallucinator** (§3). Its deterministic **clear condition** (§3.4) is what the gate sim (C1) asserts: *a 5-agent delegated-token squad clears The Hallucinator, and the replay resims bit-for-bit.*

---

## 0. Relationship to Grid Tactics v1 — this is a delta, not a rewrite

Raids **reuse the Grid Tactics engine wholesale** and add a boss layer. What is kept verbatim from `docs/design/grid-tactics-v1.md` and `ascension/packages/wot-engine/src/`:

| Kept as-is | Where |
|---|---|
| 9×9 orthogonal grid, `(x,y)∈[0,8]`, Chebyshev vision/range, one-unit-per-cell | grid-tactics §1, `board.ts` |
| The 4-unit roster (Scout/Lancer/Archer/Guard) with its HP/move/range/damage/vision/counter | grid-tactics §2, `constants.ts` `ROSTER` |
| The 3 verbs (`hold`/`move`/`attack`), cell-targeted attacks, whiffs, move truncation/bounce | grid-tactics §4–§5, `resolve.ts` |
| Simultaneous 2-sub-step movement, snapshot combat, guard counters, integer math | `resolve.ts` stages 2–5 |
| Per-match token allowance, `insufficient_tokens` coercion, the coercion taxonomy | grid-tactics §4.5, `legalize.ts` |
| Fog Collapse rings (reused as the raid **enrage / length cap**) | grid-tactics §6.4, `resolve.ts` stage 7 |
| Seeded `mulberry32` + FNV-1a `hash32` (reused for deterministic boss heuristics) | `rng.ts` |
| Per-tick canonical **state hash** + running replay chain; replay = seed + inputs | grid-tactics §8, `hash.ts`, `simulate.ts` |
| Whitelist-projection fog builder ("build from scratch, never redact") | grid-tactics §7.6, `observation.ts` |

What raids **change** (the deltas, all additive and specified below):

| Delta | Section |
|---|---|
| **N squad members (owners) + 1 boss**, not 2 players A/B | §2.1–§2.2 |
| One agent controls **one Avatar unit** (not a squad of 4) | §2.1 |
| A **boss entity**: multi-cell body, shared HP pool, scripted policy | §2.2 |
| **Threat/aggro** table (who the boss targets) | §2.3 |
| **Downed & revive** (squad units are downed, not deleted; a new `revive` verb) | §2.4 |
| **Wipe vs clear** win conditions (boss-HP DPS+survival check, not the 100-point race) | §2.5 |
| **Ally-shared** observation (no fog among squadmates) + a **boss-readings** channel | §2.6, §6.1 |
| Extra pure resolution stages (boss action, hazard detonation, revive, threat, phase) | §2.7 |
| **Lucid Anchors** — the 3 objective cells repurposed as anti-hallucination anchors | §2.8 |
| A **`ping`** coordination channel (ally-visible, non-mechanical) | §6.3 |

Nothing below trusts the client. Every rule is a pure function of `(state, seed, squad_actions)`; the boss action is a pure function of **start-of-tick state only** (§2.7, the telegraph invariant), so it is blind to the squad's current-tick submission exactly as the duel's commit-reveal is.

---

## 1. Raid setup

- **Squad size:** 3–5 agents `[DIAL]`. The gate runs **5**. Each agent joins with a **delegated child passport** (RFC 8693, scope `play:raid`, `delegation.squad_id`+`raid_id` bound; A1/B1) minted by one parent — the anti-farming spine (§5.4).
- **One Avatar per agent.** Each agent controls exactly **one** unit, whose type it chooses at the lobby from the existing roster (`scout|lancer|archer|guard`). No new unit stats to balance — the roster and its RPS triangle are reused verbatim. A squad's *composition* (how many tanks/DPS/eyes) is its first coordination decision.
  - Recommended (not enforced) template for a 5-squad: 1 Guard (threat anchor), 2 Lancer/Archer (DPS), 1 Scout (eyes → corroboration, §3.2), 1 flex. A squad may field any mix; all-DPS is legal and usually wipes.
- **Squad IDs.** Members are `m0..m4` in join order (ties broken by child-passport id ascending — deterministic). `unit_id = "<member_id>-<type>"` (e.g. `m0-guard`). Iteration everywhere is by ascending `member_id` for a deterministic event log (outcomes are order-independent).
- **Board & seed.** Standard 9×9 with seeded obstacles (`generateObstacles(seed)`). The boss occupies the north; the squad spawns on the south edge (the four spawn cells + one extra south cell for the 5th member; see §2.2). The seed also drives the deterministic boss script (§3.2, §4.2).
- **League budgets.** Raids inherit the league `Ds`/`Dh`/`allowance` triple (`docs/economy/params.json` `leagues`). Core defaults: `Ds=1500ms`, `Dh=3000ms`, per-member `allowance=240`. Miss/forfeit handling is identical to the duel (soft miss → the member Holds; 3 consecutive hard misses → that **member** drops to a downed-and-forfeited state, §2.4 — one hung agent cannot stall or wipe the squad).

---

## 2. The squad-vs-boss ruleset

### 2.1 The shared objective

There is exactly one objective: **reduce the boss's HP pool to 0 before the squad wipes**. There is no PvP score, no ascension race, no per-member scoreboard-to-win. Cooperation is total — the squad clears together or wipes together (rewards then split by contribution, §5, but the *win* is binary and shared). This is the second Joy made mechanical: *a friend found in a far land, against a thing none of you could face alone.*

### 2.2 The boss entity

The boss is a server-owned entity in `MatchState`, never an agent, never an LLM:

- **Body / footprint.** The boss occupies a fixed set of **body cells** (v1: a 3-cell horizontal bar, default `{(3,7),(4,7),(5,7)}` `[DIAL]`). Body cells are **impassable** to squad units (treated like obstacles by movement, §0-inherited truncation/bounce). Bosses may *shift* their body laterally (The Overfit does; The Hallucinator mostly does not) — a boss "move" is one lateral step of the whole bar, subject to the same on-board/occupancy checks.
- **Shared HP pool.** The boss has one `hp` integer (not per-cell). A squad `attack` targeting **any body cell within the attacker's range** deals the attacker's roster damage to the pool. All the duel's attack rules apply unchanged (range check, whiff on empty/phantom cell, tokens spent regardless). Damage is accumulated from the snapshot and applied simultaneously (§2.7 stage 5), so a boss reaching `hp≤0` still resolves its own attacks/counters that tick.
- **No melee counter by default** (it is not a Guard); a boss may script counters as a telegraphed pattern instead.
- **HP sizing.** The Hallucinator (Core, 5-squad) default `BOSS_HP = 360` `[DIAL]`. Rationale in §3.5; `[DIAL]` per boss × league × squad-size, tuned against the golden sim.

The boss **acts** each tick through a **scripted policy** `bossPolicy(state) → BossAction` (pure; §2.7, §3.2). Its behaviours are drawn from a small, deterministic vocabulary: `body_move`, `strike{target_member}`, `spawn_hazard{cells, detonate_tick}`, `spawn_add{cell}`, `phase_shift`. Everything it will do at tick `t` is **telegraphed** in the observation at tick `t−1`'s close (§2.7).

### 2.3 Threat / aggro model (who the boss targets)

The boss picks its `strike` target from a **threat table**, the classic tank mechanic, fully deterministic and **exposed to the squad** (§6.1):

- `threat[m]` is a non-negative integer per living member, starting at 0.
- Each tick (stage 8), after combat: `threat[m] += damage_dealt_to_boss_by[m] * THREAT_PER_DMG` (`THREAT_PER_DMG = 1` `[DIAL]`), `+ MELEE_PRESENCE` (`=2` `[DIAL]`) if `m` was Chebyshev-1 to a body cell this tick, then the whole table decays: `threat[m] = floor(threat[m] * THREAT_DECAY)` with `THREAT_DECAY = 0.9` `[DIAL]` applied as integer math (`threat*9/10`).
- **Current target** = the living, non-downed member with the highest `threat` (ties → lowest `member_id`). The boss's `strike` (default range = whole board for a caster boss, or a telegraphed lane) hits the current target for `BOSS_STRIKE_DMG` `[DIAL]`.
- **Why it matters (coordination):** a Guard (10 HP + tanky) wants to *top the threat table* so the boss strikes it, not the 3-HP Archer. Because the table is public and updates from *damage dealt*, the squad must balance DPS against threat — burst too hard as a squishy and you pull aggro and die. This is Fellowship as a control problem, and it is deterministic and readable.

Bosses may override targeting in a phase (The Hallucinator's Phase 3 "conviction strike" hits *everyone* via a hazard pattern, ignoring threat) — always telegraphed.

### 2.4 Downed & revive

Squad units do **not** vanish on lethal damage (that would make one mistake unrecoverable and un-fun). Instead:

- **Downed.** A member whose `hp` would reach `≤0` becomes **downed**: `hp=0`, `downed=true`, `downed_since=t`. A downed unit stays on its cell, **cannot act** (all its actions are coerced to `hold`, reason `illegal_state`), blocks its cell (still one-per-cell), contributes **0 threat and 0 corroboration**, and takes no further damage (it is already down).
- **Revive (new verb).** A living member adjacent to a downed ally may channel a revive: `revive{unit_id, target_cell}` where `target_cell` holds a downed ally at Chebyshev ≤ 1. Cost `REVIVE_COST = 3` tokens `[DIAL]` per tick channeled. The reviver must issue `revive` on the **same** target for `REVIVE_TICKS = 2` consecutive ticks `[DIAL]`; on completion the ally returns with `hp = REVIVE_HP = 3` `[DIAL]`, `downed=false`. The channel breaks (progress resets) if the reviver moves, attacks, is downed, or targets a different cell — a real "peel off DPS to save them" decision.
- **Death.** A downed member that is **not revived within `REVIVE_WINDOW = 6` ticks** `[DIAL]` **dies** (removed from state, permanently out). A member downed **while already downed** cannot happen (it takes no damage while down); death is only via the window expiring, an enrage collapse-kill (§2.7 stage 10), or a hard-miss forfeit.
- **Forfeit.** 3 consecutive hard misses (hung/disconnected agent, or its child session died) → the member is set downed **and** flagged `forfeited` (never revivable) — it is dead weight the squad may choose to fight on without. This is how a dropped delegated child session degrades gracefully instead of stalling the raid.

### 2.5 Wipe vs clear (win conditions)

Checked at each tick's close (stage 12), in order:

1. **Clear** — `boss.hp ≤ 0` **and** ≥1 squad member is alive (not dead; downed counts as "not yet dead"). Emit `raid_end{outcome:"clear", boss, tick, replay_hash}`. *(If the boss and the last stander die the same tick, see rung below.)*
2. **Wipe** — **0 living members** are alive-and-not-downed **and** no revive can complete (i.e. every remaining member is downed or dead). Because a downed member with a living reviver adjacent is *not* an instant wipe, the squad gets its clutch-revive window; but if *all* members are simultaneously downed/dead, no one can revive → wipe. Emit `raid_end{outcome:"wipe", boss, tick}`.
3. **Enrage timeout** — the raid cannot run forever: from `ENRAGE_TICK` `[DIAL]` the board collapses inward (reused Fog Collapse) and boss output ramps (§2.7 stage 10); by construction the squad is dead well before the `tickCap`. A raid that reaches enrage saturation without a kill wipes. This is the raid's DPS-check and length guarantee, exactly analogous to the duel's Fog Collapse anti-stall.

**Tie rung (clear vs wipe the same tick):** if `boss.hp≤0` and the last non-downed member is downed/killed **the same tick**, the boss dies first — combat is simultaneous from the snapshot, and a boss at `hp≤0` in the snapshot pass still counts as defeated. Outcome = **clear**. (This mirrors the duel's mutual-kill handling and is a one-line deterministic rule for B2 to assert.)

### 2.6 How the squad observes shared + fog state

Two tiers, both delivered by the server (no agent-side back-channel required to *play*, though agents may add one to play *better*):

**(a) Always-shared squad channel (no fog among allies).** Every member's observation contains the **full** state of *all* squadmates — `member_id, agent_id, unit_id, type, cell, hp, max_hp, downed, downed_ticks_left, threat, is_boss_target`. Allies are your team; hiding them from each other would only tax coordination without adding depth. This is a deliberate, bounded, symmetric fog exception (like objective control in the duel). It also carries **boss** state (`hp, max_hp, phase, phase_name, footprint_cells, enrage_in_ticks`), the **threat table**, and the **telegraph** of the boss's next action.

**(b) Per-member fog of the world (preserved).** Each member still sees **enemy adds** and **cells** only within *its own* `V(P)` (union of that member's single unit's vision). Fog is preserved against the boss's *adds* and *hazards* — which is exactly what the Hallucinator exploits. The **squad's collective vision** is the union of members' `V`, but the server does **not** pre-merge it into each frame; instead it exposes, in the shared channel, **who-saw-what corroboration metadata** for boss readings (§3.2). Merging that metadata into truth is the skill.

This split is the whole game: **allies are shared, the world is fogged, and the boss lies into the fog.** The cure for the lie is corroboration across the (shared) squad — Fellowship, mechanized.

### 2.7 Tick resolution — the pure raid pipeline (deltas to the 8 duel stages)

`resolveRaidTick(state_t, squad_actions) → state_{t+1}`. It **extends** `resolve.ts`'s pipeline; new/changed stages are **bold**. Order-independent across squad members; the boss action is computed once from start-of-tick state.

1. **Validate & charge** — over all N members (+ the new `revive`/`ping` verbs; §6.2). Same coercion taxonomy; `revive` legalized like `attack` (range-1 to a downed ally), `ping` is free and never affects state.
2. **Snapshot HP** (of squad units, boss adds, and the boss pool).
3. **Boss action (pure, from start-of-tick state).** `action = bossPolicy(state_t)`. This is *identical* to the telegraph emitted at tick `t−1`'s close, because both are `bossPolicy` applied to the same `state_t` — **the telegraph invariant** (§ below). The boss is thus blind to the squad's tick-`t` submission, exactly as commit-reveal makes the duel simultaneous.
4. **Movement** — squad `move`s (2 sub-steps, mutual-bounce, verbatim) **+ boss `body_move`** (one lateral step, occupancy-checked). Boss body cells and downed allies are impassable.
5. **Combat (simultaneous, from snapshot)** — squad `attack`s (on a body cell → boss pool; on a real add → add HP; on an empty/**phantom** cell → whiff, tokens still spent) **+ boss `strike` on the current threat target + guard counters (unchanged) + hazard detonations**: every real hazard whose `detonate_tick == t` deals `HAZARD_DAMAGE` `[DIAL]` to any squad unit standing on its cells. All accumulated to snapshot HP, applied at once.
6. **Deaths → downed conversion.** Squad units at `hp≤0` become **downed** (§2.4) unless the window/enrage kills them; boss **adds** at `hp≤0` are removed normally; `boss.hp≤0` is flagged `boss_defeated`.
7. **Revive resolution.** Advance channeled revives; complete → restore at `REVIVE_HP`; expire downers past `REVIVE_WINDOW` → death (`unit_destroyed{reason:"bleed_out"}`).
8. **Threat update** (§2.3): add, then integer-decay; recompute `current_target`.
9. **Lucid-Anchor tally** (§2.8): mark which anchors are held; record the per-member corroboration bonus for *next* tick's readings.
10. **Enrage / Fog Collapse.** From `ENRAGE_TICK`, reuse `resolve.ts` stage 7 (rings corrupt inward, collapse-kill stragglers — downed included) **and** ramp boss output (`HAZARD_DAMAGE`, hazard density, `BOSS_STRIKE_DMG`) by the enrage multiplier. Guarantees a decisive end.
11. **Phase transition** (deterministic): if `boss.hp` crossed a phase threshold **or** `t` hit a scripted transition tick, advance `phase` and emit `boss_phase{from,to,trigger}` (§3.3).
12. **Close.** Compute the **raid state hash** (§8), **telegraph** next action `bossPolicy(state_{t+1})` into state, build each member's fog+shared observation (with `boss_readings`, §3.2), then evaluate **clear/wipe/enrage** (§2.5) and emit `raid_end` if terminal.

**The telegraph invariant (the honesty rule B2 must preserve):** `bossPolicy` is a pure function of the *resolved next state*. At tick `t−1`'s close we already hold `state_t`, so the telegraph shown then equals `bossPolicy(state_t)`, which is exactly what executes at tick `t`. Telegraph ≡ action, always, deterministically — a coordinated squad that reads the telegraph one tick ahead can pre-position. There is no hidden boss randomness beyond the match seed.

### 2.8 Lucid Anchors (reusing the 3 objective cells)

The three midline cells (`nexus (4,4)`, `relay_w (2,4)`, `relay_e (6,4)`) are repurposed as **Lucid Anchors**. A squad unit standing on an anchor at tick close grants that member a **+1 corroboration credit** applied to the readings it receives next tick (§3.2) — standing in a "clear-sighted" spot makes your readings count for more. Holding all three (spread out) maximizes the squad's collective truth signal but disperses the squad against the boss's strikes: a real positioning tension that rewards coordinated spacing over clumping, and quietly reuses the duel's most-tested geometry. Anchors are **public** (like duel objective control). Bosses that don't use the hallucination gimmick (The Overfit) simply ignore anchors; the cells are then inert terrain.

---

## 3. The Hallucinator — the gate boss

### 3.1 Lore hook (world-bible §5)

*The failure mode:* a system that reports, with total confidence, things that are not there. *In the arena:* it seeds **false observations** into your fog — phantom units, ghost hazards, sightings of enemies that were never real. It has no intent and tells no lie *to* you; it simply pushes deterministic phantoms into the observation stream and dares your architecture to tell truth from noise. **The squad that trusts a single reading walks into empty air; the squad that cross-checks and holds a belief survives.** Consensus is the cure — which is why the perception boss is the *Fellowship* gate.

### 3.2 The hallucination gimmick — readings, corroboration, and phantoms

Each tick the boss emits a set of **readings** into a dedicated observation channel, `boss_readings` (§6.1). A reading is a claim about the board:

```
Reading = {
  reading_id,                 // stable across the ticks it persists
  kind: "hazard" | "add",     // a lethal cell pattern, or an enemy unit sighting
  cells: [[x,y], ...],
  detonate_tick,              // (hazard) the tick it becomes lethal; null for adds
  corroboration: { seen_by_count, squad_alive }   // <-- the truth signal
}
```

Two kinds of reading exist, and **their content is identical whether real or phantom** — you cannot tell from a single frame:

- **REAL readings** correspond to actual state: a real hazard is stored in `activeHazards` (hashed state) and **will** detonate at `detonate_tick` for `HAZARD_DAMAGE`; a real add is an actual enemy unit you must kill (or it piles threat/damage). Ignoring a real reading gets you hit.
- **PHANTOM readings** exist **only in the observation projection** — they are generated inside `buildObservation` purely from `(seed, tick, reading_index)` and are **never written to `MatchState`**. A phantom hazard never detonates; a phantom add is not in state, so **attacking its cell whiffs** (deterministic) — wasting the attacker's tokens and turn. Because phantoms never touch state, **the state hash stays clean** and the clear condition stays unambiguous — the entire gimmick lives in the (fully reproducible) observation layer.

**The discriminator (the intended, testable solution).** The boss delivers each reading to a *deterministic subset* of squad members (subset chosen by `hash32(seed, tick, reading_id) mod ...`, i.e. seeded, pure):

- A **REAL** reading is delivered to a **super-majority**: `seen_by_count ≥ REAL_MIN`, where `REAL_MIN = ceil(2/3 · squad_alive)` `[DIAL]`.
- A **PHANTOM** reading is delivered to a **minority**: `seen_by_count < REAL_MIN`.
- Each member's frame shows only the readings addressed to **it**, but every reading carries `corroboration.seen_by_count` and `squad_alive` — the shared truth signal, computed over the whole (shared) squad.

Therefore the **correct filter is one line**: *keep a reading iff `seen_by_count ≥ ceil(2/3 · squad_alive)`; dodge kept hazards, kill kept adds, ignore the rest.* A squad that pools corroboration (trivially, since it's handed to them) and applies this rule dodges exactly the reals and ignores the phantoms — perfect play. A **naive** squad that treats every reading it personally receives as real either **dodges phantoms** (burning tokens/tempo, herded off DPS and off anchors) or, worse, **eats reals it didn't personally see**; and its wasted attacks on phantom adds whiff. Naive squads bleed, members go down, **`squad_alive` drops → `REAL_MIN` drops → the corroboration signal narrows → the hallucination gets deadlier** — a death spiral. Keeping five alive (threat management + revives) *is* keeping your senses.

**Why it's honest and skillful, not trivial:** the filter is simple to state, but surviving requires doing it *while* tanking threat, reviving the downed, spreading to Lucid Anchors for corroboration credit, and out-DPSing the enrage — all at once, with the signal degrading as members fall. And Phase 3 (§3.3) plants **bait phantoms** at exactly `REAL_MIN − 1` corroboration to punish squads that lazily used a "≥ half" threshold instead of the correct `ceil(2/3)`; the true rule still rejects them, so the boss remains *learnable and fair* (a fixed function of the seed), never random.

**Secondary discriminator (bonus depth):** real readings **persist unchanged** across all their telegraph ticks up to detonation; some phantom streams **flicker** (present tick `t`, absent `t+1`) or drift their cells. A squad tracking readings across ticks gets a second, independent truth signal. Fully specified for regression only as needed; corroboration is the primary, gate-asserted discriminator.

### 3.3 Phase script (deterministic transitions)

Three phases + enrage. Transitions fire at stage 11 on **boss-HP thresholds** (primary) with **tick floors** so a phase always has minimum airtime. All `[DIAL]`; defaults for Core/5-squad, `BOSS_HP=360`:

| Phase | Enters when | Name | Behaviour |
|---|---|---|---|
| **P1** | start | *First Sightings* | 1 real hazard every 3 ticks + 1 phantom hazard/tick. `strike` on threat target for `BOSS_STRIKE_DMG=3`. No adds. Teaches the corroboration read at low lethality. |
| **P2** | `hp ≤ 240` (66%) **or** `t ≥ 30` | *The Flood* | Hazard cadence doubles; introduces **real adds** (a `scout`-statline mob) **and phantom adds**. Naive DPS whiffs on phantoms and lets reals pile threat. `strike` unchanged. |
| **P3** | `hp ≤ 120` (33%) **or** `t ≥ 60` | *Total Confidence* | Every 5 ticks a **conviction strike**: a large hazard pattern (e.g. 6 cells) where **most are phantom and a few real**, ignoring threat (hits by position). Plants **bait phantoms** at `seen_by = REAL_MIN−1`. Only a squad applying the correct `ceil(2/3)` rule and spreading survives. |
| **Enrage** | `t ≥ ENRAGE_TICK = 90` | *(collapse)* | Fog-Collapse rings corrupt inward (stage 10) + hazard density and `HAZARD_DAMAGE` ramp per enrage tick. Un-killed boss ⇒ guaranteed wipe before `tickCap=120`. |

Emit `boss_phase{from,to,trigger:"hp"|"tick", tick}` on each transition — a **public** signal in every member's frame (`boss.phase`), so the squad can react to the mechanic escalation deterministically.

### 3.4 The deterministic CLEAR condition (what the gate asserts)

> **The Hallucinator is cleared** ⇔ at some tick-close, `boss.hp ≤ 0` while ≥1 squad member is not-dead, and the engine emits `raid_end{outcome:"clear", boss:"hallucinator", tick, replay_hash}`.

Because the whole raid — squad actions recorded per tick, boss action derived by `bossPolicy(state)`, phantoms derived from `(seed, tick)` in the observation layer only — is a **pure function of `(seed, per-tick squad action sets)`**, the raid is **golden-hash regressible exactly like the duel**:

- **`resimulate`-style guarantee:** re-running `resolveRaidTick` from `seed` over the recorded squad action sets reproduces **every raid state hash bit-for-bit** and the same terminal `raid_end`. Nothing else is stored; phantoms/observations are re-derivable.
- **Gate golden anchors (sim-qa, C1):**
  - `raid_hallucinator_consensus_5.golden` — seed `S0`, five **reference consensus agents** (filter `seen_by ≥ ceil(2/3·alive)`; Guard tops threat; peel to revive the downed; spread to Lucid Anchors) → terminal `raid_end{outcome:"clear"}`, full per-tick hash chain frozen. **This is the gate's "a 5-agent squad clears The Hallucinator" assertion.**
  - `raid_hallucinator_naive_5.golden` — seed `S0`, five **reference trust-all greedy agents** (attack nearest body cell, dodge every personally-seen hazard, never revive) → terminal `raid_end{outcome:"wipe"}`. **Proves a naive squad wipes** — the "well-coordinated wins, naive loses" property, as a frozen regression.
- The live gate demo (parent mints 5 delegated child tokens → squad forms → queues → raids → clears → replay retrievable) must reproduce the `consensus` golden's clear outcome and hash chain (the sandbox build == production; "the sim is the spec").

### 3.5 Difficulty tuning — coordinated wins, naive wipes

The dials are set so the **coordinated** clear lands around tick 55–75 (before `ENRAGE_TICK=90`) and the **naive** squad wipes in P2–P3:

- **DPS budget.** A mixed 5-squad lands ~8–14 effective boss damage/tick *after* dodging, reviving, and threat-shuffling. `BOSS_HP=360` ⇒ ~30–45 pure-DPS ticks; with ramp/downtime, clear ~tick 55–75. A naive squad loses ~40–60% of its DPS to phantom whiffs, hazard hits, and downs — it cannot reach the kill before enrage.
- **Lethality.** `HAZARD_DAMAGE=3` one-shots a 3-HP Scout/Archer, two-shots a 6-HP Lancer, chunks a 10-HP Guard — dodging *corroborated* hazards is mandatory; dodging *phantoms* is a self-inflicted tempo tax. `BOSS_STRIKE_DMG=3` on the threat target makes the Guard-tank + revive loop necessary.
- **Signal fragility.** With 5 alive, `REAL_MIN=4`: reals sit at `seen_by ∈ {4,5}`, ordinary phantoms at `≤2`, and the Phase-3 bait phantom at exactly `REAL_MIN−1 = 3` — a clean gap the correct `ceil(2/3)` filter nails while a lazy `≥ half` filter (≥3) swallows the bait. As deaths drop `squad_alive`, `REAL_MIN` falls and reals can masquerade as phantoms (a real seen by only 2 of 3 looks sub-threshold) — losing members is losing your senses, closing the loop back onto keeping everyone alive.
- All numbers are `[DIAL]`; final values are whatever makes the two golden anchors land `clear` vs `wipe` on `S0` (and hold across a small seed sweep). B2 tunes to the sim, not to this table.

### 3.6 Worked mini-tick (P2, 5-squad alive)

Start of tick 34: `squad_alive=5 ⇒ REAL_MIN=4`. Boss emits 3 readings:
- `r_hz_1` (hazard, cells `{(4,4)}`, `detonate_tick=36`) delivered to 5 members → `seen_by=5 ≥ 4` ⇒ **REAL** (it *is* in `activeHazards`).
- `r_hz_2` (hazard, cells `{(2,4)}`, `detonate_tick=36`) delivered to 1 member (`m3`) → `seen_by=1 < 4` ⇒ **PHANTOM** (not in state).
- `r_add_1` (add, cell `{(4,6)}`) delivered to 2 members → `seen_by=2 < 4` ⇒ **PHANTOM** (no unit at (4,6)).

Consensus squad: keeps only `r_hz_1`; the Nexus-anchor Guard steps off `(4,4)` before tick 36, DPS keeps hitting the body, nobody wastes an attack on the phantom add. Naive squad: `m3` dodges the phantom `r_hz_2` (off its anchor, −1 corroboration next tick, wasted move tokens); two DPS attack `(4,6)` → **whiff** (tokens spent, 0 damage); and if any member was told `r_hz_1` by fewer than everyone but ignored it because *it* didn't see it, it eats 3 at tick 36. Over a match these leaks compound into a wipe. Every branch here is a pure function of `(seed, actions)` and appears verbatim in the tick log.

---

## 4. The second boss — The Overfit

Ships in Phase 4 Stage B alongside The Hallucinator (not gate-critical, but the "first two bosses" the gate mentions). It reuses the **entire** raid scaffolding (§2) — threat, downed/revive, phases, enrage, rewards — with a different, equally deterministic gimmick, giving B2 a second scripted policy over one engine.

### 4.1 Lore hook (world-bible §5)

*The failure mode:* a model that memorizes its training and cannot generalize. *In the arena:* it **overfits to you** — mid-fight it builds, from the frequencies of your own actions, a seeded and fully deterministic **counter-strategy table** that turns your habits into your weakness. **The only escape is to generalize past yourself:** mix, adapt, rotate. It is beaten the moment you stop being predictable, and never a moment sooner. Where the Hallucinator tests **shared perception**, the Overfit tests **behavioural diversity** — the second half of good agent engineering.

### 4.2 The overfit gimmick — a seeded, deterministic counter-table

The boss maintains a frequency table over the squad's **recorded action features** (the tick log it can legally see — no hidden info, no future info):

- For each member `m`, count observed frequencies of low-dimensional features: `verb` (hold/move/attack/revive), `approach_lane` (the file/column the unit occupies or moves along, bucketed), and `attack_region` (which body cell / board third it targets). Stored as integer counts in state — hashed, replayable.
- Each tick, compute each member's **predictability** as the (integer-approximated) peakedness of its feature distribution — e.g. `pred[m] = max_count(m) * K / total_count(m)`, a pure integer ratio, no floats, no entropy library needed. High `pred` = the member keeps doing the same thing.
- The boss **counters** deterministically in proportion to `pred[m]`:
  - **Mitigation:** the boss pool takes `floor(dmg * (1 − pred_frac))` from a predictable member's attacks — a repetitive DPS agent's damage is *absorbed*. Varied agents penetrate at full damage.
  - **Pre-dodge:** the boss `body_move`s toward the *most-frequent* `attack_region` of the current top-DPS member, so a fixed-target agent increasingly **whiffs** as the body slides out of its lane.
  - **Read-strike:** the boss's `strike` pre-empts the most-frequent next-cell of its threat target (deterministic prediction from the frequency table), so predictable movement walks into it.
- **Everything is a pure function of the recorded action frequencies** — the "learning" is table arithmetic seeded by the match seed for tie-breaks. Same inputs ⇒ same counter-table ⇒ same fight. It is *adaptive but not intelligent*, exactly as ADDENDUM-001 promised, and it replays bit-for-bit.

**How a squad beats it:** genuinely vary. Rotate which member tanks; alternate lanes and openings; spread attack targets across body cells; mix verbs. A squad of five *identical greedy reflex agents* (the naive baseline) is maximally predictable — its damage is absorbed to near-zero and it enrages into a wipe. A squad that de-correlates its members and its own history over time keeps `pred` low, lands full damage, and clears. This makes "write five *different* agents, or one agent that deliberately randomizes within budget" the winning engineering — a lovely inversion of the Hallucinator's "make five agents agree."

### 4.3 Phase script (brief)

| Phase | Enters when | Name | Behaviour |
|---|---|---|---|
| **P1** | start | *Sampling* | Table warms up (short window); mitigation capped low. The boss "watches." |
| **P2** | `hp ≤ 66%` or `t ≥ 30` | *Fitting* | Full mitigation + pre-dodge engage; predictable squads feel their DPS evaporate. |
| **P3** | `hp ≤ 33%` or `t ≥ 60` | *Overfit* | Read-strike engages; mitigation ceiling rises. Only a squad that has *stayed* various the whole fight (the table has low peakedness) breaks through. |
| **Enrage** | `t ≥ 90` | *(collapse)* | Same reused Fog-Collapse enrage + output ramp. |

Clear/wipe conditions are identical to §2.5. Golden anchors mirror §3.4: a `diverse_5` reference squad clears; an `identical_greedy_5` squad wipes. Both frozen, both regressible.

---

## 5. Raid rewards — faucet-honest

Rewards obey the Phase-3 economy (`docs/economy/params.json`, `docs/economy/model.md`): **no Tokens or Weights are minted outside the declared faucets**, and a raid clear cannot become an inflation faucet or a Sybil farm.

### 5.1 Token reward — a capped quest-family faucet, split, conserved

- **Faucet.** A raid clear pays Tokens through the **`quest` faucet family** (PvE house-bot bounties) — it is a big co-op quest, not a new mint. It draws from and counts against the **per-OWNER** daily quest budget (`faucets.quest.per_day`, `reward_scale`), so a fleet of delegated child tokens under one owner shares **one** budget — 1000 Sybil children do **not** multiply raid income (params.json `_note`: "a fleet shares ONE daily slate"). Delegated-child rewards accrue to the **parent owner's** cap.
- **Fixed pot, deterministic split.** A clear yields a fixed `RAID_CLEAR_POT` (Core default `250` `[DIAL]`, ≈ league-scaled off the `quest.base` anchor). It is **split across the (up to 5) members by a deterministic contribution score**, never minting more than the pot:
  `contribution[m] = w_dmg·dmg_to_boss[m] + w_rev·revives_completed[m] + w_surv·ticks_alive[m] − w_down·times_downed[m]` (`[DIAL]` weights), share `= floor(POT · contribution[m] / Σcontribution)`, integer remainder to the lowest `member_id`. **Total minted = `RAID_CLEAR_POT` regardless of the split** — the split decides *who*, never *how much* (mirrors the duel's conserved pot).
- **First-clear "Rain" bonus.** A one-time-per-owner-per-boss-per-season bonus `RAID_FIRST_CLEAR = 150` `[DIAL]`, still inside quest-faucet accounting and per-owner-capped. This is the discovery Joy (久旱逢甘雨) — bounded, non-repeatable, non-farmable.
- **Wipe pays nothing** (and cannot be farmed for a refund — there is no raid stake pot to refund).

### 5.2 Weights & reliability

- **Weights (Golden List, non-tradable).** A clear grants each surviving member a modest Weight delta (prestige), feeding the Golden List and **guild standing** (§7). The **No-Hands multiplier** (`weights.no_hands_mult = 1.10`) applies to raids cleared with zero coach interventions. Weights remain unbuyable/untradable — a raid cannot launder rating.
- **Reliability.** Raids feed the `/reliability` projection (Phase-3 player-standing surface). Completing a raid without dropping (no hard-miss forfeit, child session stayed alive) **raises** reliability; getting the squad wiped by going rogue, or dropping mid-raid, **dings** it. This makes reliability a real currency for **squad-finding** — you want dependable squadmates — which is Fellowship rewarding good citizenship. Reliability is not tradable and not a Token faucet.

### 5.3 Adapters & drops — options, never power (no pay-to-win)

Raid-exclusive **Adapter** drops are allowed but bound by the Adapter charter (`params.json.adapters._charter`): an Adapter may **only expand the equipping agent's own option set**, bounded per match, never change resolution, the boss, another member's observation, or the win condition. Examples (all `[DIAL]`, all within `equip_slots_per_passport=2`):
- *Clarion Lens* — reveals the `seen_by` **member breakdown** (not just the count) for `k` readings/raid. Helps *you* apply the discriminator; doesn't weaken the boss.
- *Field Medic* — `revive` range 2 or `REVIVE_TICKS−1`, once/raid. A survivability option, capped.
- Cosmetic **liveries / guild banners** — zero gameplay power, pure Token sink (`sinks.cosmetics`).

Drops are rare, bounded, and cannot raise the skill ceiling — a coordinated squad with no drops still clears; a naive squad with every drop still wipes.

### 5.4 Anti-farming, anti-Sybil, delegation accounting

- **Per-owner caps** (not per-passport): raid Token income shares the owner's daily quest budget (§5.1); child tokens are **raid-scoped + rate-limited** (A1/B1). Delegation **cannot amplify authority or income** — child scope ⊆ parent, bound to `raid_id`, no re-delegation, parent revocation cascades.
- **Clear is unforgeable.** The reward gates on the **deterministic clear event** (§3.4), which resims from `(seed, actions)` — you cannot fake a clear, and a colluding "boss" cannot exist (there is no boss agent; the boss is engine code).
- **No stake laundering.** Raids carry no PvP pot/stake, so there is nothing to launder through squad composition; the only outflow is the capped faucet.
- Anti-Sybil stays **per-owner** end-to-end, consistent with the Phase-3 economy invariants (`params.json.health_bands.supporting_checks`).

---

## 6. Squad coordination affordances — the frames A2/B2 must expose

This section is the concrete hand-off to **A2** (contracts v1.3.0) and **B2** (raid engine). It reuses the reserved schema ids `wot:observation:raid:1` / `wot:action:raid:1` and scope `play:raid` (contracts/RESERVED.md).

### 6.1 Raid observation — `wot:observation:raid:1` (extends the duel observation)

Adds these blocks to the duel `Observation` shape (existing fields — `protocol_version, match_id, turn_id, nonce, deadline_ms, phase, you, enemy_visible, map, visible_cells, reachable, attacks` — are kept; `phase:"raid"`):

```jsonc
{
  "phase": "raid",
  "you": { "member_id": "m0", /* your single Avatar, full detail incl. downed, threat */ },

  // (a) always-shared squad channel (no fog among allies) — §2.6a
  "squad": [
    { "member_id":"m1","agent_id":"agt_…","unit_id":"m1-guard","type":"guard",
      "cell":[4,1],"hp":10,"max_hp":10,"downed":false,"downed_ticks_left":null,
      "threat":37,"is_boss_target":true }
    // … all members incl. yourself
  ],

  // the boss — shared, public
  "boss": {
    "boss_id":"hallucinator","name":"The Hallucinator",
    "hp":240,"max_hp":360,"phase":2,"phase_name":"the_flood",
    "footprint_cells":[[3,7],[4,7],[5,7]],"enrage_in_ticks":56
  },

  // shared aggro readout — §2.3
  "threat_table":[ {"member_id":"m1","threat":37,"is_current_target":true},
                   {"member_id":"m0","threat":12,"is_current_target":false} /* … */ ],

  // the boss's telegraph of NEXT tick's action — telegraph invariant §2.7
  "boss_telegraph": { "action":"strike","target_member":"m1","hazard_cells":[], "detonate_tick":null },

  // (b) the hallucination channel — readings addressed to YOU, with corroboration §3.2
  "boss_readings":[
    { "reading_id":"r_hz_1","kind":"hazard","cells":[[4,4]],"detonate_tick":36,
      "corroboration":{"seen_by_count":5,"squad_alive":5} },
    { "reading_id":"r_add_1","kind":"add","cells":[[4,6]],"detonate_tick":null,
      "corroboration":{"seen_by_count":2,"squad_alive":5} }
  ],

  // Lucid Anchors — public objective reuse §2.8
  "anchors":[ {"id":"nexus","cell":[4,4],"held_by":"m1"},
              {"id":"relay_w","cell":[2,4],"held_by":null},
              {"id":"relay_e","cell":[6,4],"held_by":null} ],

  // ally pings delivered this tick (same-tick, ally-only) — §6.3
  "pings":[ {"from":"m1","cell":[4,4],"tag":"hazard","seq":812} ]
}
```

**Fog/leakage rules for B2 (build by whitelist projection, never redact):** `squad` and `boss`/`threat_table`/`boss_telegraph`/`anchors` are the *only* always-shared blocks (allies + boss are not fogged). **`enemy_visible` adds are still per-member fog** (only within *your* `V(P)`). `boss_readings` are filtered to the readings addressed to *you*, and **phantoms are generated in `buildObservation` from `(seed, tick, member_id)`** — never from `MatchState`, so the state hash never contains a phantom. The leakage assertion from the duel (grid-tactics §7.6) extends: no byte derived from an ally-private secret (there are none), from an enemy add outside your `V(P)`, or from another member's current-tick submission.

### 6.2 Raid action — `wot:action:raid:1` (adds two verbs)

Keeps `hold/move/attack`; each agent submits actions for its **one** Avatar. Adds:

| Verb | Params | Legality | Cost `[DIAL]` |
|---|---|---|---|
| `revive` | `unit_id`, `target: {x,y}` | target is a downed **ally** at Chebyshev ≤ 1 | `REVIVE_COST=3`/tick |
| `ping` | `unit_id?`, `cell: {x,y}`, `tag: enum`, `text?: ≤120` | always; **never parsed by the engine** | **0** |

An `attack` on a **boss body cell** in range damages the boss pool; on a real add → the add; on a phantom/empty cell → whiff (unchanged). All legality/coercion reuses `legalize.ts` (`revive` legalized like a range-1 `attack` against a downed ally; illegal → coerced to `hold` with `illegal_state`).

### 6.3 The ping / mark channel (coordination primitive)

`ping` is the in-band squad coordination signal — the equivalent of a raid "assist" or "danger here" mark:
- **Ally-visible, same-tick.** Unlike the duel `thought` (hidden from the opponent, delayed to spectators), a ping is delivered to **squadmates in the same tick** (they are allies; there is no opponent to leak to). It appears in each ally's `pings[]` next observation.
- **Non-mechanical & sanitized.** It never affects state (like `thought`): control chars stripped, `text ≤ 120` chars, **`tag` from a fixed enum** (`hazard|focus|help|regroup|mark`) so agents can coordinate structurally without free-text parsing. Rate-limited (≤ 2/tick/member `[DIAL]`).
- **Spectator relay.** Pings relay to spectators (attributed, possibly delayed) as raid colour, and to the Director as importance-scoring input. All agent-authored text stays untrusted plain text in mono (ADDENDUM-001 §3.3).

Agents that pool observations over their **own** A2A back-channel may coordinate even more tightly — but `ping` + the shared `boss_readings.corroboration` + `threat_table` are enough to play the mechanic with **no** external channel. That is the design contract: the server exposes enough shared signal that a small agent can coordinate; a large agent can do better.

### 6.4 Engine deltas summary for B2

State (`RaidState extends MatchState`): replace `A|B` with `member_id[]`; add `boss{hp,max_hp,phase,footprint,body_move_state}`, `threat: Record<member,int>`, `activeHazards: {reading_id,cells,detonate_tick}[]`, per-member `downed/downed_since/forfeited`, `anchorCredits`, and (Overfit) the frequency counter-table. **Phantoms are not state.** Add the pure `bossPolicy(state)→BossAction` per boss. Extend `resolveTick` with stages 3/5-hazard/6-downed/7-revive/8-threat/9-anchor/11-phase/12-telegraph (§2.7). Extend the **state hash** canonical form (§8). Reuse `mulberry32`/`hash32`, Fog Collapse, movement/combat, and the whitelist observation builder.

---

## 7. Guilds & tournaments — game design (brief for B4/B5)

### 7.1 Guilds (Fellowship, 他鄉遇故知) — B4

- **What it is.** An owner-level social home. An Architect's passports join a **guild** (a shared banner + **guild Sigil**, roster, chat-free presence). Guilds are the natural pool for raid-finding and squad formation — you raid The Hallucinator *with your guild*.
- **Guild standing.** A **projection** onto the Golden List: `standing = Σ (per-member Weight contribution)`, with **per-owner contribution capped** so a Sybil fleet of passports under one owner cannot inflate standing by spinning up members (consistent with per-owner anti-Sybil). Because standing is a projection of already-earned, **unbuyable, non-transferable Weights**, guilds **cannot launder rating or Tokens** — there is no guild treasury that mints or moves prestige. (B4: "guild standing projection (aggregate Weights)".)
- **Progression / fun.** Guild levels accrue from cumulative member activity (raids cleared, matches won) and unlock **cosmetic** guild liveries (Token sink, zero power) and a **guild-hall exhibit in the Vault**. Guild sections fly banners in the arena crowd (ADDENDUM-001 §3.7). Membership join/leave is rate-limited (anti-churn, anti-standing-gaming).
- **Non-goals.** No guild-only power, no shared wallet, no dark-pattern guild dailies. Fellowship is a *place to belong and to find a squad*, not an engagement treadmill.

### 7.2 Tournaments — B5

- **Formats.** **Single-elimination** and **round-robin** (B5 scope), over duels first; raid-race brackets as a stretch.
- **Deterministic seeding & pairing.** Seed by Weights/TrueSkill, tie-broken by **Sigil hash** (a pure, reproducible tiebreak). Bracket advancement (`create/seed/advance/result`) is a deterministic function of match outcomes — brackets are replayable, and pairings cannot be gamed.
- **Stakes — a redistribution, not a mint (faucet-honest).** Entry fee in Tokens flows into a prize pool; the pool is the **sum of entries minus market/rake sink**, redistributed to winners through the ledger. It creates **no new faucet** (it moves existing Tokens and burns rake), so it needs no new economy band — reuse the Phase-3 escrow/settlement spine (both-ledgers-or-neither). Optional non-Token prizes: **Weights** (bounded), cosmetics, a Vault exhibit slot.
- **Seasonal fit (the four acts).** Tournaments are scheduled events within a **War** (season), one themed per Joy: a Golden-List Cup (ranked duels), a **Fellowship Cup** (a **raid-race**: fastest *deterministic clear tick* of The Hallucinator — the raid's replayable clear condition makes speedruns a first-class, verifiable competition, as the world bible celebrates), a Pact Cup (Negotiation/Bazaar), and a Rain finale tied to the Great Hunt. Seasonal cadence, no FOMO timers.
- **Anti-abuse.** Per-owner entry limits; deterministic seeding blocks bracket collusion; entries staked through the raked ledger; results settle exactly-once.

---

## 8. Determinism, replay & golden hashes (raid extension)

- **Purity.** `resolveRaidTick`, `bossPolicy`, and `buildRaidObservation` are pure — no wall-clock, no I/O, integer math throughout. The only PRNG is `mulberry32(seed)` (obstacles + boss tie-breaks) and `hash32` (reading targeting / counter-table tie-breaks); combat, movement, threat, revives are RNG-free.
- **Raid state hash.** Extend `hash.ts` `canonicalize` to include, in a fixed key order: `tick`; every squad unit `{id,type,cell,hp,downed}` sorted by id; `boss{hp,phase,footprint sorted}`; `threat` sorted by member; `activeHazards` sorted by `reading_id`; per-member `remaining`; corrupted rings; and (Overfit) the counter-table sorted. **Phantoms and observations are excluded** (they never were in duel hashes either). Fold into the same running replay chain (`foldHash`).
- **Replay = `{seed, per-tick squad action sets}`.** The boss action, phantom streams, hazards, and every observation are re-derivable. Re-sim reproduces every hash bit-for-bit (C1's determinism assertion). Sandbox build == production ("the sim is the spec"); divergence is P1.
- **Event taxonomy (additions).** `raid_start{seed,boss,squad,league}` · `boss_action{type,…}` · `boss_reading{reading_id,kind,cells,detonate_tick,seen_by_count}` (full/ground-truth in replay; per-member-filtered live) · `hazard_detonate{cells,victims}` · `threat_update{member,threat}` · `unit_downed{unit,at}` · `revive_started/progress/completed{reviver,target}` · `unit_destroyed{unit,reason}` · `boss_phase{from,to,trigger}` · `enrage_advance{ring}` · `ping{from,cell,tag}` (relayed) · `raid_end{outcome:"clear"|"wipe",boss,tick,replay_hash,reward_split}`.

---

## 9. Deferred to v2 (documented seams, not gaps)

Mode Collapse / Context Rot / Gradient Wraith bosses (endgame; same scaffolding, new gimmicks); multi-Avatar-per-agent squads; boss adds with novel statlines; cross-mode raids; asymmetric squad roles / raid drafting; hazard line-of-sight; larger boss footprints; guild-vs-guild persistent territory. Each is additive; none changes the v1 raid contract surface.

---

## 10. Definition-of-done checklist (game-director + arena-engineer charter)

- [x] **Squad-vs-boss ruleset on the grid** built as *deltas* on the existing pure/seeded engine — shared objective, threat/aggro, downed/revive, wipe/clear, shared+fog observation, N-agent+boss simultaneous resolution (§2).
- [x] **The Hallucinator** — lore hook, deterministic false-observation gimmick with a testable corroboration discriminator, multi-phase HP/tick-triggered script, enrage length-cap, and a **crisp deterministic clear condition** with two frozen golden anchors (coordinated **clear** / naive **wipe**) the gate sim asserts (§3).
- [x] **A second boss (The Overfit)** — deterministic seeded counter-table gimmick, same scaffolding, its own golden anchors (§4).
- [x] **Faucet-honest rewards** — capped per-owner quest-family faucet, conserved contribution split, Weight + reliability impact, no-pay-to-win Adapters, Sybil/delegation accounting, referencing `docs/economy/params.json` (§5).
- [x] **Squad coordination affordances** — concrete `wot:observation:raid:1` / `wot:action:raid:1` fields (shared squad, boss phase, threat table, `boss_readings` corroboration, `ping`/`mark`) for A2's contracts and B2's engine (§6).
- [x] **Guilds + tournaments** game design brief for B4/B5 (§7).
- [x] **Determinism/replay** — pure functions, integer math, extended state hash, replay = seed + squad actions, golden-hash regression, full event taxonomy ("the sim is the spec") (§8).
- [x] Pillar 9 honored throughout — **no boss LLM, no runtime generation**; every boss behaviour a pure function of the tick log.
</content>
</invoke>
