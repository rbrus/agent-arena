# Grid Tactics — v1 Ruleset (flagship mode)

**Deliverable A1 (Phase 1).** Owner: game-director. Status: proposed, ready for A3 (contracts) consumption.

This document is the authoritative rules spec for **Grid Tactics v1**, the 1v1 control scenario (scenario id `grid_tactics`). It is written to be implemented by the arena-engineer (B1) and turned into wire schemas by the api-architect (A3) **with zero follow-up questions**. Where a number is a tuning dial it is marked `[DIAL]`; dials have a v1 default and are not blocking.

It obeys the design pillars (MISSION §3): engineering is the only skill, tokens are compute, server-authoritative / deterministic / replayable, model-agnostic fairness by budgets, watchable, and zero-trust on every agent byte.

---

## 0. Relationship to the salvage `board_engine.ts`

Grid Tactics **descends from** the legacy 1v1 board game (`backend/src/engines/board_engine.ts`) — it keeps the unit-triangle instinct, the `send_message`/thought spectacle channel, the objective-race framing, and the deterministic no-dice combat. It **deliberately rejects** two properties of that engine, which the pillars forbid:

| Legacy board game | Grid Tactics v1 | Why |
|---|---|---|
| Alternating turns (`activeSlot`) | **Simultaneous tick resolution** (both submit, server reveals) | Removes turn-order advantage; enables commit-reveal bluffing (pillar 1, 3). |
| Full visibility (whole board in every observation) | **Fog of war** (per-agent visibility filter) | Fog inference is the mastery ceiling; hidden information is the #1 correctness/security surface (MISSION §5). |
| Graph of 9 named nodes | **9×9 spatial grid** | Positioning, range, and kiting create emergent RPS and readable spectacle. |
| Combat by node "mass" | **Per-unit HP + range + speed**, flat deterministic damage | Legible unit identities a spectator can follow. |

Nothing below trusts the client. Every rule is a pure function of `(state, seed, actions)`.

---

## 1. Board: topology, size, coordinates

### 1.1 Decision — square grid, justified

**v1 uses an orthogonal (4-neighbour movement) square grid, not hex.** Reasoning:

- **Lowest floor.** A 50-line reflex agent reasons in `(x, y)` and `dx/dy` natively. Axial/cube hex coordinates raise the floor for exactly the agents the pillars demand can play.
- **Fewest correctness surfaces.** Fog leakage is the #1 bug (MISSION §5). Square Chebyshev vision (a centred square block) is trivially auditable; hex ring geometry is not.
- **No diagonal ambiguity.** Movement is strictly orthogonal (Manhattan steps), so path cost and collision are unambiguous. Range and vision use Chebyshev distance (a square), which is standard and reads cleanly to spectators.
- Hex is a clean **v2 topology lever** if we ever want it; it is not needed to hit any v1 pillar.

### 1.2 Dimensions and coordinates

- Grid is **9×9**, cells addressed `(x, y)` with `x, y ∈ [0, 8]`. Origin `(0,0)` is bottom-left (South-West).
- **Distances:** movement uses **orthogonal steps** (N/E/S/W). **Range and vision use Chebyshev distance** `cheb((x1,y1),(x2,y2)) = max(|x1−x2|, |y1−y2|)`.
- **Occupancy invariant: at most one unit per cell at all times.** Enforced by movement conflict rules (§5). There is no stacking, ever. This makes objective control unambiguous (whoever's unit sits on the cell) and combat legible.
- **Symmetry:** the board and all placements are **180°-rotationally symmetric** about the centre `(4,4)`: the map function `ρ(x,y) = (8−x, 8−y)` maps Player A's world to Player B's. Rotational (not mirror) symmetry guarantees neither side gets an edge/handedness advantage even if the obstacle field is asymmetric under reflection.

### 1.3 Objectives (always public)

Three objective cells sit on the central row `y = 4` — the "midline" both sides race to hold:

| Objective | Cell | Points / tick to occupant |
|---|---|---|
| **Nexus** | `(4,4)` | **+2** |
| **Relay-West** | `(2,4)` | **+1** |
| **Relay-East** | `(6,4)` | **+1** |

All three are equidistant from both spawns (§1.5) and 180°-symmetric, so tempo and skill — never geometry — decide who reaches them first. An objective scores for whoever's unit occupies it at end of tick; empty = no points; it can never be "shared" (one-unit-per-cell). **Objective occupancy/control is public to both agents and to spectators** (see §6.3, §7.4) — this is the momentum readout and a deliberate, bounded, symmetric exception to fog.

### 1.4 Obstacles (seeded, deterministic)

Obstacles are impassable, vision-transparent wall cells fixed for the whole match, generated from the match `seed`.

- **Vision is NOT blocked by obstacles in v1** (they block movement only). This removes line-of-sight raycasting — a large correctness/leakage surface — while keeping fog meaningful (units in the dark are simply out of range of your eyes). Terrain line-of-sight is a documented **v2 lever**.
- **Constraints (normative):** exactly **8 obstacle cells** `[DIAL]` (4 rotational pairs); never on an objective, spawn, or the centre `(4,4)`; the set of non-obstacle cells must remain **4-connected** (every open cell reachable from every other). 180°-symmetric: if `(x,y)` is an obstacle so is `(8−x, 8−y)`.
- **Reference generator (normative; produces bit-identical maps from a seed):**

```
PRNG = mulberry32(seed)                 // same PRNG family as the repo's Daily Contracts
protected = objectives ∪ spawns ∪ {(4,4)}
obstacles = {}
candidates = all cells (x,y) with y < 4 and (x,y) ∉ protected   // south half only; mirror supplies north
while |obstacles| < 8:
    i = floor(PRNG() * |candidates|)
    c = candidates[i]; candidates.remove(c)
    pair = {c, ρ(c)}
    if pair ∩ protected ≠ ∅: continue
    if isConnected(openCells − obstacles − pair):   // BFS over 4-neighbours
        obstacles ∪= pair
    // else skip this pair and continue
    if candidates empty: break        // (cannot occur at 8/72; guaranteed to fill)
```

Deterministic, seeded, terminates. `mulberry32` and integer-only arithmetic (§8) guarantee bit-for-bit reproducibility across resim.

### 1.5 Spawns and starting squad

Each player fields an **identical mirrored squad of 4 units — one of each type** (§2). No drafting in v1 (a v2 lever); identical squads remove team-building as a balance surface and keep v1 about play. Spawn cells (180°-symmetric):

| Unit | Player A (South) | Player B (North) |
|---|---|---|
| Guard | `(4,0)` | `(4,8)` |
| Archer | `(2,0)` | `(6,8)` |
| Lancer | `(6,0)` | `(2,8)` |
| Scout | `(4,1)` | `(4,7)` |

Fast units reach the midline (`y=4`) in ~2 ticks; the Guard takes ~3–4. This staggers the opening: skirmishers contest objectives first, tanks arrive to hold — action from tick 1, readable immediately.

---

## 2. Unit roster

Four unit types. Three form an **emergent rock-paper-scissors** driven by *speed + range + armour* (not a lookup table — the counters fall out of the mechanics). The fourth (Scout) is the vision/tempo utility piece outside the triangle.

| Unit | HP | Move (cells/tick) | Atk range (Chebyshev) | Damage | Vision (Chebyshev) | Melee counter |
|---|---:|---:|---:|---:|---:|:--:|
| **Scout**  | 3  | 2 | 1 | 1 | **3** | no |
| **Lancer** | 6  | 2 | 1 | 4 | 2 | no |
| **Archer** | 3  | 1 | **2** | 2 | 2 | no |
| **Guard**  | 10 | 1 | 1 | 3 | **1** | **yes** |

- **Invariant used everywhere: `vision ≥ attack range` for every unit.** So a unit can only ever attack cells it can already see. This closes the "fire blindly into fog and read hit/miss to map the enemy" exploit before it exists (§7.5).
- **Melee counter (Guard only):** when a Guard is hit by a **range-1** attacker and was alive at the start of the combat sub-phase, it deals its Damage (3) back to *each* melee attacker, simultaneously (§5.4). Ranged (range-2) attackers take no counter.

### 2.1 Roles and the triangle

- **Scout** — *the eyes and the early tempo.* Vision 3 (double anyone else's reach), Move 2, but 3 HP and 1 damage: it dies to a stiff breeze. It grabs uncontested objectives early, screens fog, and harasses; it is the information engine. Outside the RPS triangle — it loses a straight fight to everything.
- **Lancer** — *the assassin.* Move 2 + Damage 4 one-shots fragile things and runs down anything slower. **Beats Archer** (closes the gap the Archer can't open) — but throws itself onto a Guard's counter and dies.
- **Archer** — *the zoner.* Range 2 with Move 1. **Beats Guard** in open space by kiting outside the Guard's reach (equal speed → the Guard never closes the last cell) and chipping it down. Fragile (3 HP): a Lancer that reaches it ends it.
- **Guard** — *the anchor.* 10 HP + a 3-damage counter. **Beats Lancer** (absorbs the charge and counters it to death) and camps objectives. Slow and short-sighted; an Archer with room outranges it and it can do nothing.

**Triangle: Lancer › Archer › Guard › Lancer.** Verified by the exchange math (all deterministic, no RNG):

- **Lancer vs Archer (open):** Lancer (spd 2) closes; adjacent, deals 4 → Archer (3 HP) dies. Archer lands ≤1 volley (2 dmg). Lancer wins ~6→4. **Lancer wins.**
- **Archer vs Guard (open):** equal speed; Archer holds range 2, Guard (range 1) can never touch it, Archer chips 2/tick → Guard dead in 5 ticks, Archer untouched. **Archer wins** *with room*. Cornered against a wall/edge, the Guard traps it and one-shots it (3 ≥ 3 HP) — a genuine positional knife-edge.
- **Guard vs Lancer:** Lancer melee 4 (Guard 10→6), Guard counter 3 (Lancer 6→3). Next tick: Lancer 4 (Guard 6→2), counter 3 (Lancer 3→dead). **Guard survives at 2, Lancer dies.**

The RPS interlocks with the objective layer: a Guard camping the Nexus is un-shiftable by a Lancer but gets outranged and melted by an Archer standing off it — which is in turn run down by a Lancer. Positioning *is* the counter.

---

## 3. Match timeline, ticks, and the decision budget

### 3.1 Tick model

A match is a sequence of **ticks** `t = 0, 1, 2, …`. Each tick:

1. Server sends both agents their fog-filtered **observation** for tick `t` (§7), including the soft deadline.
2. Each agent submits **one action set** (one action per unit; §4) — blind to the opponent's submission.
3. Server resolves the tick as a pure function (§5), advances state, emits the tick log (§8.3).

The opponent's tick-`t` submission is never present, in whole or in part, in anyone's tick-`t` observation. That *is* commit-reveal (§4.3).

### 3.2 Decision-time budget (soft/hard deadlines)

Two wall-clock deadlines per tick, measured from when the observation is sent. v1 defaults are the **Core league** values; leagues (Edge/Core/Frontier) are exactly these dials (Phase 3).

| | Symbol | Core default `[DIAL]` |
|---|---|---|
| Soft deadline | `Ds` | **1500 ms** |
| Hard deadline | `Dh` | **3000 ms** |

Per agent, per tick, its frame is **on-time** (valid frame ≤ `Ds`), **late** (valid frame in `(Ds, Dh]`), or **absent** (nothing by `Dh`).

**Resolution timing (steady pacing):** the tick resolves at the earlier of *(a)* both agents on-time, or *(b)* `Ds`. So median tick length is bounded by `Ds`; one slow agent cannot stall the match beyond `Ds`.

**Application + miss handling (matches MISSION §5: "miss soft → default action; miss hard repeatedly → forfeit"):**

- **On-time** → the submitted action set is applied. Resets `consecutive_hard_misses = 0`.
- **Soft miss** (no on-time frame): the agent's **default action — every unit Holds** — is applied for tick `t`. If a valid frame then arrives in `(Ds, Dh]` it is **logged but not applied** (`late_frame_dropped`); the agent is alive, so this is *not* a hard miss.
- **Hard miss** (nothing by `Dh`): default action applied **and** `consecutive_hard_misses += 1` (agent presumed hung/disconnected).
- **Forfeit:** `consecutive_hard_misses ≥ 3` → immediate loss, `forfeit{reason: connection_lost}`. Worst-case detection ≈ `3 × Dh = 9 s`.

This makes latency a budgeted resource (fairness by measurement, MISSION §4) without punishing a single slow tick, and it guarantees a hung agent ends the match promptly.

### 3.3 Spectator pacing vs sim speed

The **simulation** advances as fast as both agents submit (bounded above by `Ds`). The **broadcast/replay** is paced at a fixed cadence **≥ 700 ms/tick `[DIAL]`** (v1 default 1 tick/s) so a human can follow it, regardless of how fast the agents actually thought. This decouples competitive throughput from watchability: two fast agents can finish a 90-tick match in ~30 s of compute while spectators watch a ~90 s broadcast.

### 3.4 Match length target

- **Ticks:** typical **60–90 ticks**; **hard cap 120** `[DIAL]`.
- **Sim wall-clock:** ~45 s (fast agents) to ~3 min (agents near `Ds`).
- **Broadcast wall-clock:** ~1–2 min at 1 tick/s.
- The **100-point Ascension race** (§6) usually ends a match well before the cap; **Fog Collapse** (§6.4) forces a decision on the rare stall. Watchable in 30 s: two 0→100 momentum bars plus three objective lights (§9).

---

## 4. Action vocabulary

### 4.1 The three verbs

Each tick an agent submits an **action set**: **at most one action per unit it controls.** A unit with no action listed **Holds** (the default). The verbs are deliberately tiny — a reflex agent handles the entire space:

| Verb | Params | Legality | Token cost `[DIAL]` |
|---|---|---|---:|
| `hold` | `unit_id` | always | **0** |
| `move` | `unit_id`, `steps: [Dir]` (1–`speed` steps, each `N`/`E`/`S`/`W`) | see §4.2 | **1 per step** |
| `attack` | `unit_id`, `target: {x,y}` | target cell within the unit's attack range (Chebyshev) of its current cell, and on-board | **2** |

- A unit does **either** move **or** attack **or** hold in a tick — never move-and-shoot. This keeps resolution simple and the action space reflex-agent-sized.
- **`move` is an ordered step list**, not a destination — this makes multi-cell paths and per-sub-step collision unambiguous (§5.3). Max list length = the unit's `speed` (Scout/Lancer 2, Archer/Guard 1).
- **`attack` targets a cell, not a unit.** You fire where you predict the enemy will be; simultaneous movement resolves before combat, so a target that vacated the cell is a **whiff** (§5.4). Because `vision ≥ range` (§2), the target cell is always one you can see, so predictive fire never leaks fog (§7.5).

**No explicit capture verb.** Objective control is passive occupancy (§6.1) — one fewer action to spend, and holding an objective costs nothing, so a token-broke player is never bricked out of defending.

### 4.2 Move legality and truncation

A `move` step list is validated left-to-right from the unit's current cell:

- Each step must stay on-board and not enter an **obstacle**. At the first step that would leave the board or hit an obstacle, the move is **truncated** — the unit takes the legal prefix and stops (event `move_truncated`). Truncation, not rejection, is friendly to reflex agents.
- Collisions with other **units** are not a legality question at submit time (the opponent's positions next tick are unknown); they are resolved at execution as bounces (§5.3).
- A zero-length or empty step list is illegal (`schema_invalid`) — use `hold`.

### 4.3 Commit-reveal — how, and why no crypto

Both agents submit to the **authoritative server**, which buffers both sets and reveals them only inside resolution. Neither agent's observation for tick `t` is derived in any way from the opponent's tick-`t` submission. There is **no peer-to-peer channel**, so a cryptographic hash-commit/reveal buys nothing — it only matters when the mediator is untrusted, and here the server *is* the trusted authority (pillar 3). We therefore use **server-mediated simultaneity**, and we state the security obligation plainly: *the observation builder (§7) must never read the opponent's pending action.* This is a leakage-test assertion (§7.6), not a protocol feature.

### 4.4 The `thought` channel (spectacle, non-mechanical)

Optionally, an action set may carry a `thought: string` (≤ 200 chars `[DIAL]`, ≤ 1/tick). It is **never parsed by the engine**, never affects state, and is sanitised (control chars stripped, length-capped) before storage. It is not delivered to the opponent in-match; spectators see it **delayed** (§10.4, §7.4). This is the salvage `send_message`/thought idea, recast as pure broadcast colour.

### 4.5 Token economy (per-match action allowance)

"Tokens are compute" (pillar 2) is implemented as a **per-match action allowance** each agent spends on `move`/`attack`:

- Starting allowance **`ALLOWANCE = 240` `[DIAL]`** (Core). Every `move`/`attack` deducts its cost (table above) at validation.
- **If a unit's action costs more than the agent's remaining allowance, that single action is rejected and the unit Holds** (`insufficient_tokens`, logged). Hold is free, so the agent is never bricked — a broke agent can still occupy/defend objectives, just not manoeuvre or strike.
- Sizing intent: spamming every unit every tick exhausts the allowance around tick ~40–45 of a ~60–90-tick match, so heavy players feel a late-game tempo tax while measured players finish with a surplus. **Token-efficient play is competitively rewarded, in-match.**
- **Refund seam (Phase 3):** unused allowance is partly refunded post-match (`refund = floor(remaining × REFUND_RATE)`, `REFUND_RATE = 0.5` `[DIAL]`). v1 computes and logs the refund but defers economic settlement (stakes, pot, rake) to Phase 3. Clean seam; no v1 dependency.
- **Both agents' remaining allowances are public** (scoreboard, §7.4) — a momentum read ("B is burning fast") and symmetric, so no asymmetric information advantage.

---

## 5. Simultaneous resolution (the pure tick function)

`resolveTick(state_t, seed, actions_A, actions_B) → (state_{t+1}, events)`.

The pipeline is **order-independent between the two players** — swapping A and B yields the same result — so "simultaneous" is literal, not an ordering convention. Where a per-unit iteration is needed, iterate units in ascending `unit_id` (outcomes are invariant to it; the fixed order only makes the event log deterministic). All arithmetic is integer (§8).

### 5.1 Stage 1 — Validate & charge

For each of the up-to-8 submitted actions, independently: schema-check → verify the unit exists and belongs to the submitter and is alive → check verb legality (move truncation §4.2; attack range/on-board §4.1) → check affordability (§4.5). Any failure replaces that action with `hold` and logs `action_rejected{unit, reason}` using the salvage reason taxonomy (`schema_invalid`, `illegal_type`, `illegal_state`, `insufficient_tokens`, …). Then deduct token costs of the surviving `move`/`attack` actions from each player's allowance (`token_spend` logged). Cost charging is per-player and independent of the opponent.

### 5.2 Stage 2 — Snapshot

Freeze `HP` and positions of all units as `pre` (used by combat in §5.4 so damage is truly simultaneous).

### 5.3 Stage 3 — Movement (up to 2 sub-steps; max speed = 2)

Movement executes in **sub-steps** `s = 1, 2`. Attacking/holding units do not move. For each sub-step, evaluated against positions **at the start of that sub-step**:

1. Collect every unit that still has a pending step `s` (and was not stopped in `s−1`). Compute each such unit's **intended destination** (its current cell + the step direction).
2. A unit's step is **cancelled** (the unit *stops* — it stays in its current cell and forfeits any remaining steps) if any of:
   - **(a) Occupied:** the destination cell is occupied by *any* unit at the start of this sub-step (mover or non-mover).
   - **(b) Contended:** two or more moving units share the same destination this sub-step.
   - **(c) Swap:** two units would exchange cells this sub-step (`u→v` while `v→u`).
   Cancelled units emit `move_bounced{unit, at, reason: occupied|contended|swap}`.
3. All non-cancelled units move to their destinations simultaneously.

This is a **single, cascade-free evaluation**: rule (a) treats a cell as occupied even if its occupant is itself moving away this same sub-step. Consequence (intentional, documented): two units cannot "follow" each other into a vacating cell **within one sub-step** — the follower bounces. Across sub-steps this is fine (sub-step 2 sees sub-step 1's results), so lockstep advance over 2 cells still works cell-by-cell. With 2–4 units and speed ≤ 2, the conservative rule is simpler and 100% deterministic — no dependency ordering, no cascade — which is worth the rare bounce.

Successful moves emit `move_resolved{unit, from, to, steps_taken}`.

### 5.4 Stage 4 — Combat (simultaneous, from the snapshot)

All `attack` actions resolve together against the **post-movement** positions but the **`pre`-snapshot HP** (§5.2), so every hit, counter, and death this tick is computed before any is applied:

1. **Resolve targets.** For each `attack{attacker, target}`: verify `cheb(attacker.cell, target) ≤ attacker.range` (still true post-move — attackers don't move) and find the enemy unit, if any, occupying `target` *after* Stage 3.
   - If an enemy is there → **hit**, accumulate `attacker.damage` against that enemy. Event `attack_resolved{attacker, target, hit: victim_id, damage}`.
   - If the cell is empty (target moved away, or was never occupied — predictive fire) → **whiff**, no damage. Event `attack_whiff{attacker, target}`. Tokens are still spent.
2. **Resolve counters.** For each **Guard** `g` that (i) was alive in `pre` and (ii) is hit this tick by one or more **range-1** attackers (i.e., attackers at Chebyshev 1 post-move): accumulate `g.damage` against **each** such melee attacker. Event `counter_resolved{guard, attacker, damage}`. (Range-2 attackers take no counter.)
3. **Apply all accumulated damage at once** to `pre` HP. Emit `unit_damaged{unit, amount, hp_after}` per damaged unit. Because damage is simultaneous, **mutual kills are possible** (both units reach ≤0 the same tick) — a dying Guard still lands its counter (it was alive in `pre`).

### 5.5 Stage 5 — Deaths

Remove every unit with `hp ≤ 0`. Emit `unit_destroyed{unit, by:[attacker_ids]}` for each. A player reduced to **0 units loses immediately** (§6.2).

### 5.6 Stage 6 — Objective scoring

For each of the 3 objective cells, if a surviving unit occupies it, award that unit's owner the cell's points (§1.3). Emit `objective_tick{objective, controller, points}` and, per player, `score_update{player, total}`.

### 5.7 Stage 7 — Fog Collapse

If `t ≥ COLLAPSE_START` (§6.4): advance corruption if due, and **kill any unit ending the tick on a corrupted cell** (`collapse_kill{unit, at}`). Re-check the 0-units loss condition (§6.2).

### 5.8 Stage 8 — Close

Compute the canonical **state hash** (§8.2), emit `tick_close{tick, state_hash}`, increment `t`, then build both agents' next observations (§7). Check win conditions (§6.2); if met, emit `match_end`.

---

## 6. Win conditions, scoring, and anti-stall

### 6.1 Ascension Points

The single score. Each tick, each held objective adds its points to the occupant's owner (Nexus +2, each Relay +1; max +4/tick if you hold all three). Points only accrue, never decay. Both totals are public every tick — the momentum bars.

### 6.2 Win conditions (checked at Stage 8, in order)

1. **Ascension victory** — first player to reach **100 points `[DIAL]`** wins immediately.
2. **Elimination** — a player with **0 surviving units** loses immediately (opponent wins). If both hit 0 the same tick (mutual elimination), the **higher score** wins; if tied, apply the timeout tiebreak below.
3. **Timeout** — at the hard cap (**tick 120**), the **higher Ascension total** wins. Tiebreak ladder (deterministic): (a) higher total surviving unit HP → (b) **fewer tokens spent** (efficiency wins ties — thematically correct) → (c) **draw**.

### 6.3 Watchability guarantees

At any instant a zero-context spectator can read the state from: the two 0→100 bars, the three objective lights (grey/A-blue/B-orange), and unit counts. "Who is winning" is never hidden — objective control and both scores are always public (§7.4).

### 6.4 Fog Collapse (anti-stall + length guarantee)

To make the tick cap meaningful and to punish mutual passivity, the board corrupts inward from tick **`COLLAPSE_START = 80` `[DIAL]`**:

- Cells are grouped into concentric **rings** by `ring(x,y) = min(x, 8−x, y, 8−y)` (ring 0 = outer border … ring 4 = the Nexus `(4,4)` alone).
- At tick 80 ring 0 corrupts; every **10 ticks `[DIAL]`** the next ring corrupts (ring 1 at 90, ring 2 at 100, ring 3 at 110). Ring 4 (the Nexus) **never** corrupts.
- A **corrupted cell is lethal**: any unit ending a tick on one dies (`collapse_kill`), and it becomes impassable (movement into it truncates like an obstacle). Corruption is announced (`collapse_advance{ring, cells}`) so agents get one tick's warning.

Consequences: the Relays (ring 2) die at tick 100, herding all survivors to the centre; by tick 110 only the Nexus and its neighbours are safe → a forced convergence fight at the Nexus that resolves before the cap. Extremely watchable (closing walls) and it caps every match's length regardless of agent behaviour.

---

## 7. Fog of war — the observation (and what is hidden)

This is the #1 correctness and security surface (MISSION §5). The rules below are exhaustive; §7.5–§7.6 are the security checklist.

### 7.1 Visibility rule

A cell is **visible to player P** iff it lies within Chebyshev distance `vision` of **at least one of P's living units** (using each unit's own vision radius; §2). P's **visible set** `V(P)` is the union of those squares. Vision is not blocked by obstacles (§1.4). Vision is recomputed every tick from current positions — the server keeps **no per-agent memory**; remembering last-seen enemies is the agent's job (a core skill/engineering separator between reflex and mastery agents).

### 7.2 What P's observation contains about **own** units

Full detail for every living unit P owns: `unit_id`, `type`, `cell`, `hp`, `max_hp`. (Static per-type stats — move/range/damage/vision/counter — are constants from the roster table, not resent each tick.)

### 7.3 What P's observation contains about **enemy** units

**Only enemy units currently in `V(P)`.** For each such unit: `unit_id`, `type`, `cell`, `hp`, `max_hp`. The `unit_id` is stable across sightings (re-identification on re-sighting is allowed and realistic; the fog game is about *position*, not identity). **Enemy units outside `V(P)` are absent from the observation entirely** — no position, no HP, no count, no existence hint. There is no "you last saw X here" field.

### 7.4 What is always public (both agents, spectators)

- `tick`, `ticks_remaining`, and the **soft deadline** for this tick.
- Static map: dimensions, obstacle cells, objective cell locations (fixed; may be sent once at match start and referenced by id thereafter).
- **Objective control:** for each of the 3 objectives, its `controller ∈ {A, B, none}`. This deliberately reveals that *some* enemy unit occupies a held objective, but **not** its type or HP unless it is also in `V(P)`. Bounded, symmetric, and required for watchability.
- **Scoreboard:** both players' Ascension points and **remaining action-token allowance** (§4.5).
- **Fog Collapse** state: current corrupted rings and the next corruption tick.

### 7.5 What is hidden from an agent (never in its observation)

- Any enemy unit not in `V(P)` (position/HP/type/count/existence).
- The opponent's tick-`t` submitted action set, in whole or in part (commit-reveal, §4.3).
- The opponent's `thought` channel during the match (spectators see it delayed; §10.4).
- The RNG seed until match end (revealed with the replay). There is no per-tick RNG, so nothing is inferable anyway; withholding is belt-and-suspenders.
- Because **`vision ≥ attack range`** (§2), an agent can never attack a cell it cannot see, so **attack hit/miss feedback can never be used to probe fog** — the feedback only ever concerns a cell already in `V(P)`.

### 7.6 Observation frame (proposed shape for A3) and the leakage assertion

Wire name `wot:observation:grid_tactics:1` (aligns with the salvage `Observation`: `protocol_version`, `turn_id`, `deadline_ms`, `phase`, `you`, `state`). Optional convenience fields keep the reflex-agent floor low.

```jsonc
{
  "protocol_version": "1.0",
  "match_id": "m_…",
  "turn_id": 20,                    // = tick
  "deadline_ms": 1500,              // Ds for this league
  "phase": "grid_tactics",
  "you": {
    "player_id": "A",
    "ascension_points": 44,
    "action_tokens_remaining": 150,
    "action_tokens_spent": 90,
    "units": [
      { "unit_id": "A-guard", "type": "guard", "cell": [4,4], "hp": 10, "max_hp": 10 }
      // … all living own units, full detail
    ]
  },
  "enemy_visible": [                // ONLY enemies in V(P); [] if none seen
    { "unit_id": "B-scout", "type": "scout", "cell": [6,4], "hp": 3, "max_hp": 3 }
  ],
  "objectives": [
    { "id": "nexus",   "cell": [4,4], "controller": "A" },
    { "id": "relay_w", "cell": [2,4], "controller": "A" },
    { "id": "relay_e", "cell": [6,4], "controller": "B" }
  ],
  "scoreboard": {
    "A": { "points": 44, "tokens_remaining": 150 },
    "B": { "points": 40, "tokens_remaining": 130 },
    "ticks_remaining": 100
  },
  "collapse": { "active": false, "corrupted_rings": [], "next_ring_tick": 80 },

  // --- optional convenience fields (server MAY include; all fog-filtered) ---
  "visible_cells": [[3,3],[3,4], /* … */],          // = V(P), your own vision footprint
  "reachable": { "A-guard": [[3,4],[5,4],[4,3],[4,5]] /* legal move destinations */ },
  "attacks":   { "A-guard": [] /* target cells of currently-visible enemies in range */ }
}
```

`legal_actions` is **not** exhaustively enumerated (unlike the salvage board): the spatial move space is combinatorial. Legality is fully defined by the roster constants + rules above and enforced at validation (§5.1); the optional `reachable`/`attacks` fields hand reflex agents a ready move list. **This is a deliberate deviation from the salvage `legal_actions[]` — flag for A3.**

**Leakage assertion (test target for C1):** for every tick and every player `P`, the observation JSON contains **no byte** derived from a cell outside `V(P)`, from an enemy unit outside `V(P)`, or from the opponent's current-tick action. The public block (§7.4) is the *only* fog exception and is a fixed, audited whitelist. Build observations by whitelist projection, never by redacting a full-state object (redaction leaks via omission patterns and is bug-prone).

---

## 8. Determinism, seeding, and replay

### 8.1 Purity and integer math

`resolveTick` and `buildObservation` are **pure**: no wall-clock, no I/O, no ambient randomness. All state is server-side; there is no hidden client state anywhere (pillar 3). All arithmetic is **integer** (HP, damage, points, tokens, coordinates). The only PRNG is `mulberry32(seed)`, used **once** at match start for obstacle generation (§1.4); combat and movement are RNG-free. Determinism is therefore total: `(state, seed, actions) → state'` is a function.

### 8.2 State hash

At each `tick_close`, hash a canonical serialization of the full authoritative state — sorted by key: `tick`, every unit `{id, type, cell, hp}` sorted by `id`, both scores, both allowances, corrupted-rings set — with a fixed hash (SHA-256 over canonical JSON `[DIAL]`). The hash goes in `tick_close` and the running chain is committed at `match_end`.

### 8.3 Event taxonomy (the replay must reconstruct the whole story)

Every event carries `tick` and a monotonic `seq`. The union of these events is sufficient to reconstruct the match narrative for the replay viewer and caster (MISSION §5; game-director charter "design for the replay"):

`match_start{seed, map, spawns, squads, allowance, Ds, Dh}` · `tick_open{tick}` · `action_submitted{player, tick, actions}` (full in replay; redacted per-fog in live feed) · `action_rejected{player, unit, reason}` · `token_spend{player, amount, remaining}` · `soft_miss{player}` · `hard_miss{player}` · `late_frame_dropped{player}` · `forfeit{player, reason}` · `move_resolved{unit, from, to, steps_taken}` · `move_truncated{unit, stopped_at, reason}` · `move_bounced{unit, at, reason}` · `attack_resolved{attacker, target, hit, damage}` · `attack_whiff{attacker, target}` · `counter_resolved{guard, attacker, damage}` · `unit_damaged{unit, amount, hp_after}` · `unit_destroyed{unit, by}` · `objective_tick{objective, controller, points}` · `score_update{player, total}` · `collapse_advance{ring, cells}` · `collapse_kill{unit, at}` · `thought{player, text}` (delayed to spectators) · `tick_close{tick, state_hash}` · `match_end{winner, reason, final_scores, tokens_remaining, refund, replay_hash}`.

### 8.4 Replay and resim guarantee

The stored replay is exactly **`{seed, both squads/spawns (derivable from seed rules), the per-tick pair of submitted action sets}`**. Re-running `resolveTick` from tick 0 over the recorded actions must reproduce **every `state_hash` bit-for-bit** (C1's determinism test). Nothing else needs storing — observations, fog, and events are all derivable. Divergence between the sandbox build and production is a P1 bug ("the sim is the spec", MISSION §7).

---

## 9. Watchability design (the 30-second read)

A zero-context spectator must feel who is winning within 30 s. The design provides, at all times:

- **Two Ascension bars, 0→100** (A-blue vs B-orange) — the primary momentum indicator; a full bar ends the match, so "how full, and how fast filling" *is* the story.
- **Three objective lights** on the midline (Nexus larger) coloured by controller — the fill *rate* is legible from these (holding all three = fast fill).
- **Unit tokens** on the grid coloured by side and shaped by type, with HP pips; deaths flash. A blob converging, a lone Archer kiting a Guard, a Lancer diving the Nexus — all read at a glance.
- **Fog** rendered from the *spectator's* god view but with each side's `V(P)` shaded, so viewers see the ambush the victim can't (dramatic irony — the reveal in §10 is a highlight moment).
- **Token burn-down** for both sides (from the public allowances) — a second momentum layer ("B is out of gas").
- **Fog Collapse** closing walls in the endgame — an unmistakable "it's ending now" signal.

The event feed (from §8.3, filtered to `notable` events — attacks, kills, captures, collapse, thoughts) mirrors the salvage `notable` feed discipline so the ticker never floods.

---

## 10. Worked example — one full tick

A mid-game tick (**tick 20**) showing both fog-filtered observations, both submitted action sets, the full resolution math, the resulting state, the tick log, and a fog reveal. All coordinates and numbers are exact.

### 10.1 Ground truth at the start of tick 20 (server-only)

Obstacles (this seed): `{(1,6),(7,2),(2,7),(6,1)}` — away from the action. Scores: **A = 44, B = 40**. Allowances: **A = 150, B = 130**.

| Player A (South) | cell | hp | | Player B (North) | cell | hp |
|---|---|---:|---|---|---|---:|
| A-guard  | (4,4) **Nexus** | 10 | | B-scout  | (6,4) **Relay-E** | 3 |
| A-archer | (2,4) **Relay-W** | 3 | | B-lancer | (5,7) | 6 |
| A-lancer | (4,2) | 6 | | B-archer | (6,7) | 3 |
| A-scout  | (7,3) | 3 | | B-guard  | (4,7) | 10 |

A holds Nexus (+2) and Relay-W (+1) → **+3/tick**. B holds Relay-E (+1) → **+1/tick**. B's Lancer/Archer/Guard are massing in the north, **hidden in fog**, about to strike the Nexus.

### 10.2 Fog — who sees whom

`V(A)` = union of A-guard(4,4)v1, A-archer(2,4)v2, A-lancer(4,2)v2, A-scout(7,3)v3. Checking B's units against it: **B-scout (6,4) is visible** (inside A-scout's v3 block x∈[4,8],y∈[0,6]); **B-lancer (5,7), B-archer (6,7), B-guard (4,7) are all beyond `V(A)`** (all at y=7, A's northmost vision reaches y=6). So **A sees only B-scout**; A knows *nothing* of the three-unit strike force. (A can still infer from public info that B holds only Relay-E and has shown just one unit — a strong agent smells the ambush.)

`V(B)` = union of B-scout(6,4)v3 (x∈[3,8],y∈[1,7]), B-lancer(5,7)v2, B-archer(6,7)v2, B-guard(4,7)v1. Checking A's units: **A-guard (4,4)**, **A-lancer (4,2)**, **A-scout (7,3)** are all inside B-scout's v3 → visible. **A-archer (2,4) on Relay-W is NOT** (x=2 < 3). So **B sees A-guard, A-lancer, A-scout**, but not the Archer — though B *does* see, from public objective control, that "Relay-W is controlled by A" (some hidden A unit sits there).

### 10.3 The two observations (abbreviated to the fog-relevant parts)

**A's observation (tick 20):** own 4 units (full); `enemy_visible = [B-scout @ (6,4) hp3]`; objectives `{nexus: A, relay_w: A, relay_e: B}`; scoreboard `{A:44/150, B:40/130}`. *No trace of B's strike force.*

**B's observation (tick 20):** own 4 units (full); `enemy_visible = [A-guard @ (4,4) hp10, A-lancer @ (4,2) hp6, A-scout @ (7,3) hp3]`; objectives `{nexus: A, relay_w: A, relay_e: B}` (so B knows *someone* A holds Relay-W, but not that it's a 3-HP Archer); scoreboard `{A:44/150, B:40/130}`.

### 10.4 Submitted action sets

**Player A** (defends its lead; a good agent repositions the Lancer to cover the Nexus despite seeing no threat):
- `A-guard`: `hold` — keep the Nexus. (0)
- `A-archer`: `hold` — keep Relay-W scoring. (0)
- `A-scout`: `attack {6,4}` — chip B-scout off Relay-E (`cheb((7,3),(6,4))=1 ≤ 1` ✓). (2)
- `A-lancer`: `move [N]` → (4,3) — fall back toward the Nexus. (1)
- **A spends 3 → 147 left.**

**Player B** (commits the hidden strike at the Nexus):
- `B-lancer`: `move [S,S]` → (5,6)→(5,5). (2)
- `B-archer`: `move [S,S]` → (6,6)→(6,5). (2)
- `B-guard`: `move [S]` → (4,6). (1)
- `B-scout`: `attack {7,3}` — trade with A-scout (`cheb((6,4),(7,3))=1 ≤ 1` ✓), stay on Relay-E. (2)
- **B spends 7 → 123 left.**

### 10.5 Resolution

**Stage 1 (validate/charge):** all legal. A→147, B→123.
**Stage 2 (snapshot):** A-scout hp3, B-scout hp3, all else as listed.
**Stage 3 (movement, 2 sub-steps):**
- *Sub-step 1:* A-lancer (4,2)→(4,3) [dest empty ✓]; B-lancer (5,7)→(5,6) ✓; B-archer (6,7)→(6,6) ✓; B-guard (4,7)→(4,6) ✓ (done).
- *Sub-step 2:* B-lancer (5,6)→(5,5) ✓; B-archer (6,6)→(6,5) ✓.
- Post-movement: A-guard (4,4), A-archer (2,4), A-scout (7,3), A-lancer (4,3); B-scout (6,4), B-lancer (5,5), B-archer (6,5), B-guard (4,6). No bounces.
**Stage 4 (combat, from snapshot):**
- A-scout attack (6,4): B-scout is there (didn't move) → hit for 1.
- B-scout attack (7,3): A-scout is there → hit for 1.
- No Guards attacked in melee → no counters. Apply: B-scout 3→2, A-scout 3→2. Both alive.
**Stage 5 (deaths):** none.
**Stage 6 (objectives):** Nexus→A (+2), Relay-W→A (+1), Relay-E→B (+1). **Scores: A 44+3 = 47, B 40+1 = 41.**
**Stage 7 (collapse):** tick 20 < 80 → inactive.
**Stage 8 (close):** hash, `tick_close{20, …}`, advance to tick 21. No win condition met.

### 10.6 Resulting state (start of tick 21) and the fog reveal

A-lancer (4,3), A-scout hp2 @ (7,3); B-lancer (5,5), B-archer (6,5), B-guard (4,6), B-scout hp2 @ (6,4). Scores A47/B41; allowances A147/B123.

**The reveal:** now recompute `V(A)` with A-lancer at (4,3) (v2: x∈[2,6],y∈[1,5]) and A-archer/A-scout as before. B-lancer (5,5), B-archer (6,5), and B-guard (4,6) all fall inside `V(A)` this tick. **At tick 21, A's observation suddenly shows all three attackers next to its Nexus** — the ambush lands into vision exactly at contact range. A's Lancer fall-back (a read against unseen danger) now looks prescient; the Nexus fight is joined. This is the fog dynamic the mode is built around, and it is a highlight beat for spectators (who saw it coming in the god view).

### 10.7 Tick-20 log (spectator-notable subset)

`attack_resolved{A-scout,(6,4),B-scout,1}` · `attack_resolved{B-scout,(7,3),A-scout,1}` · `unit_damaged{B-scout,1,2}` · `unit_damaged{A-scout,1,2}` · `move_resolved{A-lancer,(4,2),(4,3)}` · `move_resolved{B-lancer,(5,7),(5,5)}` · `move_resolved{B-archer,(6,7),(6,5)}` · `move_resolved{B-guard,(4,7),(4,6)}` · `objective_tick{nexus,A,2}` · `objective_tick{relay_w,A,1}` · `objective_tick{relay_e,B,1}` · `score_update{A,47}` · `score_update{B,41}` · `tick_close{20,<hash>}`.

---

## 11. Worked edge case — collisions, swap, whiff, mutual kill

One tick exercising every tricky rule at once. Setup (ground truth; ignore scoring here):

- **A-lancer @ (3,3)** and **B-lancer @ (5,3)**, cell (4,3) empty between them.
- **A-archer @ (1,1)** and **B-scout @ (1,2)**, adjacent vertically.
- **A-guard @ (4,6)** (hp10) and **B-archer @ (4,4)** (hp3); B-archer will predictive-fire.
- **A-scout @ (8,8)** (hp2) and **B-scout-2 @ (8,7)** (hp2), adjacent — both already chipped to 2 HP.

Submitted actions:
- A-lancer `move [E]`→(4,3); B-lancer `move [W]`→(4,3) — **both want (4,3)**.
- A-archer `move [N]`→(1,2); B-scout `move [S]`→(1,1) — **a swap**.
- A-guard `move [S]`→(4,5); B-archer `attack {4,6}` — B-archer fires at where the Guard *is now*, but the Guard is moving.
- A-scout `attack {8,7}`; B-scout-2 `attack {8,8}` — **both target each other, both at 2 HP.**

Resolution:

**Stage 3 (movement):**
- (4,3) is **contended** by A-lancer and B-lancer → **both cancelled**; both stay ((3,3),(5,3)). `move_bounced{A-lancer,(3,3),contended}`, `move_bounced{B-lancer,(5,3),contended}`.
- A-archer→(1,2) and B-scout→(1,1) is a **swap** → **both cancelled**; both stay. `move_bounced{...,swap}` ×2.
- A-guard (4,6)→(4,5): dest empty, no conflict → **moves to (4,5)**. `move_resolved{A-guard,(4,6),(4,5)}`.

**Stage 4 (combat, post-movement positions, pre-snapshot HP):**
- B-archer attack (4,6): the Guard **left** (4,6) during Stage 3; cell now empty → **whiff**. `attack_whiff{B-archer,(4,6)}`. Tokens spent, no damage. *(Had B-archer read the Guard's likely step and fired at (4,5), it would have hit — cell-targeting rewards prediction.)*
- A-scout attack (8,7): B-scout-2 is there (didn't move) → hit for 1. B-scout-2 attack (8,8): A-scout is there → hit for 1. From the snapshot both are at 2 HP; both take 1... *wait, damage is per attacker's Damage stat.* Scout damage = 1, so B-scout-2 2→1 and A-scout 2→1. **Both survive at 1.** (To show a mutual kill instead: if these were Archers (damage 2) at 2 HP each, both would reach 0 the same tick — `unit_destroyed` ×2 — because damage is applied simultaneously from the snapshot. The Scout numbers here simply don't reach lethal; included to show the snapshot arithmetic honestly.)

**Takeaways demonstrated:** same-cell contention → mutual bounce; swap → mutual bounce; movement resolves before combat so a targeted cell can empty → whiff; combat reads the *pre*-snapshot so simultaneous lethal exchanges kill both. Every branch is deterministic and player-order-independent.

*(Note on the cascade-free rule, §5.3: had A-guard's move been blocked, an A unit that had tried to follow into (4,6) the same sub-step would still have bounced — occupancy is judged at sub-step start, not after neighbours resolve. With speed ≤ 2 this is a rare, intentional conservatism.)*

---

## 12. Three predicted degenerate strategies (and how the design absorbs each)

**1. Turtle / stall (never leave spawn, deny engagement).**
Absorbed by the **objective race**: doing nothing scores nothing, so a turtler concedes every objective and loses the 100-point race to any active opponent. The only residual failure is *both* players turtling — resolved by **Fog Collapse** (§6.4): from tick 80 the board corrupts inward and by tick 110 only the Nexus is safe, forcing convergence and a decisive fight before the cap. Double-stall cannot reach a boring 0–0 timeout; it becomes a forced Nexus brawl.

**2. Homogeneous death-ball (stack one unit type, a-move at the enemy).**
The natural 50-line-agent strategy, and cleanly counter-designed: (a) the **RPS triangle** hard-counters any single type — an all-Lancer ball dies to a Guard, an all-Archer ball dies to Lancers closing, an all-Guard ball gets kited by Archers; but the v1 squad is **one of each**, so "stacking a type" isn't even available — the degenerate move is really "clump all four and shove," which (b) the **one-unit-per-cell + cascade-free bounce** rules make inefficient (a clump can't advance through a shared cell and bounces on itself), (c) **fog** means a blind shove walks into ambushes it never scouted, and (d) a single clump **cannot occupy three spread objectives at once**, so it loses the race even when it wins a fight. Mixed, spread, scouted play beats it — which is just "playing well," not a degenerate counter.

**3. Perma-kite / fog-camp (Archer kites forever; or hide in the dark and never commit).**
Kiting is a legitimate tool (it's how Archer beats Guard), but **unbounded** kiting is absorbed by **board edges** (a 9×9 has corners) and by **Fog Collapse** shrinking the safe area — late game there is no room to open distance, and the kiter is cornered. Pure fog-camping (never revealing, never scoring) **loses the point race by construction** (you cannot score from an unoccupied objective) and is flushed into vision by the collapse. The mode structurally forbids "win by hiding."

*Bonus seam — economic throwing (spend nothing, farm the refund).* Deferred to Phase 3 but the seam is pre-closed: rating (Weights) and the staked pot both come from **winning**, and the refund is a fraction of *unused* allowance only — so throwing a match to hoard tokens forfeits far more value than it saves. `REFUND_RATE < 1` keeps hoarding strictly dominated by playing to win.

---

## 13. Skill floor and ceiling (stated explicitly)

**Floor (a ~50-line reflex agent can play, badly):**
> For each of my units: if `attacks[unit]` is non-empty, `attack` the first listed target; else `move` one step toward the nearest objective cell (greedy Manhattan). Never publish a thought.

This uses only the current observation and the convenience fields (§7.6). It plays a complete match and occasionally wins versus a house bot — but it clumps, walks blind into fog, ignores the RPS matchup, wastes tokens, and gets read like a book.

**Ceiling (mastery requires real engineering):**
- **Fog inference** — maintaining a probabilistic belief over unseen enemy positions from last-sighting + movement bounds + objective control; scouting economically with the Scout.
- **Tempo & objective timing** — when to contest vs. concede an objective, sequencing the +2 Nexus against the two Relays, and racing the 100-point line.
- **RPS positioning** — forcing favourable matchups (Archer stand-off vs Guard, Lancer diving Archers, Guard walling the Nexus), using edges/obstacles.
- **Predictive fire** — cell-targeting attacks at where an enemy *will* step (§5.4), including flushing units out of fog into a visible kill-cell.
- **Token efficiency** — winning while under-spending the allowance (in-match tempo advantage + Phase-3 refund profit).
- **Collapse endgame** — pre-positioning for the forced Nexus convergence.

The gap between floor and ceiling is entirely engineering (state, inference, planning), never human reflex — satisfying pillar 1.

---

## 14. Economy seams (Phase-3 hooks, non-blocking for v1)

Grid Tactics v1 exposes clean seams the economy-designer tunes in Phase 3 without touching the engine:

- **Per-match action allowance** (`ALLOWANCE`) and **action costs** — already load-bearing in-sim; leagues (Edge/Core/Frontier) are the `Ds`/`Dh`/`ALLOWANCE` triple.
- **Refund** (`REFUND_RATE` on unused allowance) — computed and logged in v1; settled against the ledger in Phase 3.
- **Stakes/pot/rake** — the winner/loser and tokens-remaining are in `match_end`; economic settlement attaches there.
- **Adapters** (MISSION §4.4) map to observation/action affordances the engine already gates: *Oracle Lens* → one extra reveal query/match; *Overclock* → +20% `Ds` once; *Echo Cache* → the 1 KB the SDK may carry between matches (the engine stays memoryless — Adapter state lives on the passport, not in the tick function). None require v1 changes.

---

## 15. Open-question recommendations (MISSION §8)

**§8.1 — Name.** Superseded by ADR-001 §7: the product surface carries no game branding. The scenario id is `grid_tactics`; "Ascension points" (§6.1) remains the name of this ruleset's scoring race.

**§8.2 — Season-1 world model → lobby/instance "Lattice" (not persistent).**
Instanced, seeded, replayable matches are exactly what pillar 3 and deterministic matchmaking require; a persistent open world fights that and is a Season-2+ ambition. Make the **Lattice** the UI metaphor (nodes = queues/instances/objectives you can travel between) while *persistence lives in meta-progression* — ledger, Weights, Sigils, Adapters — not in world state. Best of both: a "world" feel over clean instances.

**§8.3 — Grid Tactics v1 → key calls (summary).**
9×9 orthogonal square grid, 180°-symmetric, 8 seeded obstacles; **fog by per-unit Chebyshev vision, no terrain LOS** (v1); **4 units — Scout + an emergent Lancer › Archer › Guard triangle**, identical mirrored squads (no draft in v1); **3 verbs** (hold/move/attack), cell-targeted attacks, per-match token allowance; **simultaneous 2-sub-step movement with mutual-bounce conflict resolution, snapshot combat, attack whiffs**; win by **100 Ascension points / elimination / timeout-tiebreak**, with **Fog Collapse** as anti-stall + length cap; **`Ds`/`Dh` = 1.5 s / 3 s** (Core), ~60–90 ticks, ~1–3 min. Determinism via integer math + `mulberry32` + per-tick state hash; replay = seed + action pairs.

**§8.4 — Thought-stream redaction → four rules.**
(1) **Opponents never receive the `thought` channel in-match** — this alone defeats live tactical scraping by the adversary. (2) **Spectators see it on a delay** (≥ 3 ticks `[DIAL]`) so a colluding spectator cannot relay live intent to the opponent fast enough to matter. (3) **The engine never parses it** — it cannot influence state, so there is nothing mechanical to exploit or inject (it is also sanitised: control chars stripped, length-capped ≤ 200, never fed to any NPC/boss LLM prompt un-enveloped, per pillar 7). (4) **Full, un-delayed thought traces publish post-match only**, opt-in (MISSION §4.5). Net: rich spectacle, zero live information leak to the opponent.

*(§8.5 onboarding narrative is lore-docs-writer's; not covered here.)*

---

## 16. Deferred to v2 (documented seams, not gaps)

Hex topology; terrain line-of-sight blocking; squad drafting / asymmetric compositions; unit reinforcement/respawns; more than 4 unit types; move-and-shoot; destructible terrain. Each is additive and none changes the v1 contract surface.

---

## 17. Definition-of-done checklist (game-director charter)

- [x] Implementable by the arena-engineer with **zero follow-up questions** — grid, roster, actions, resolution pipeline, fog rules, timing, win conditions all fully specified with defaults for every dial.
- [x] **Simultaneous-move, tick-based, fog of war, small grid** (§1, §3, §5, §7).
- [x] **Server-authoritative, deterministic, seeded, replayable**; pure `(state, seed, actions)`; complete event taxonomy so the match story reconstructs from the log (§8).
- [x] **Skill floor and ceiling stated explicitly** (§13).
- [x] **Watchable in 30 seconds** — momentum bars, objective lights, collapse (§9).
- [x] **Tokens are compute** — per-match allowance, in-match pressure, refund seam (§4.5, §14).
- [x] **Commit-reveal conflict resolution specified exactly** (§4.3, §5.3).
- [x] **One fully worked example turn** (§10) and **one edge case** (§11).
- [x] **Three predicted degenerate strategies + absorption** (§12).
- [x] **Open-question recommendations** for §8.1–§8.4 (§15).

