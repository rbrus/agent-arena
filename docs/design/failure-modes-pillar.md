# The Failure-Modes Pillar — bosses as a distributed-systems curriculum (Phase 6)

**Deliverable A1 (Phase 6).** Owners: game-director + arena-engineer. Status: proposed, ready for A2 (contracts v1.5.0), B1 (failure-modes engine), B2 (world-first races), B3 (codex/UI), and C1 (the gate) consumption.

This is the authoritative design for turning the raid roster into a **distributed-systems / multi-agent failure-mode curriculum**: every boss embodies a real failure mode, and clearing it *requires the squad to demonstrate the corresponding robust pattern*. It **names the pillar**, folds the two shipped bosses (**The Hallucinator**, **The Overfit**) into a registry, adds the **three new bosses** (**The Byzantine**, **Deadlock**, **Split-Brain**), and specifies **world-first clear races** and the **teaching codex**.

It obeys the pillars (MISSION §3), and above all **Pillar 9 — the Zero-Inference Core**: every boss is a **deterministic scripted encounter**, no platform LLM. *The Architects' agent systems supply the intelligence; the arbiter fields no champion — not even its monsters think.* Every adversarial, partition, and delay effect is **projected into observations only and never written to the hashed state** — the exact discipline The Hallucinator's phantoms already prove — so replays re-sim bit-for-bit and C1 can freeze golden hashes.

This is a **delta on the shipped raid engine** (`docs/design/raids-v1.md`, `ascension/packages/wot-engine/src/raid/`), not a rewrite. It reuses `RaidState`, `resolveRaidTick`, `bossPolicy`, the per-tick `raidStateHash` chain, `buildRaidObservation`'s whitelist projection, the threat/downed/revive systems, Lucid Anchors, and the golden-anchor + `resimulateRaid` regression harness verbatim.

---

## 0. Relationship to raids-v1 — what is kept, what is added

| Kept verbatim | Where |
|---|---|
| `RaidState` + `resolveRaidTick` 12-stage pure pipeline; integer math; `mulberry32`/`hash32` only | `raid/resolve.ts`, `raid/rng` |
| Boss policy dispatch `bossPolicy(state) → BossAction` + `BOSS_CATALOG` registry | `raid/bosses/index.ts` |
| Per-tick `raidStateHash` / `canonicalizeRaid` + `foldHash` replay chain; **phantoms excluded from the hash** | `raid/hash.ts` |
| `buildRaidObservation` **whitelist projection** ("build from scratch, never redact"); `readingsFor` phantom generation from `(seed, tick, member)` | `raid/observation.ts` |
| Threat/aggro, downed/revive, wipe/clear, enrage/Fog-Collapse, Lucid Anchors, `ping` channel | `raid/resolve.ts` §2 stages |
| `runRaid` / `resimulateRaid` golden-anchor harness (coordinated CLEAR + naive WIPE pair, frozen hash chain) | `raid/simulate.ts`, `raid/reference-agents.ts` |
| Faucet-honest reward split + per-owner anti-Sybil; first-clear "Rain" bonus (`RAID_FIRST_CLEAR`) | raids-v1 §5, `raid/constants.ts` |

| Added (all additive, specified below) | Section |
|---|---|
| The **pillar taxonomy / curriculum** and its pedagogical arc | §1 |
| A **failure-mode channel** abstraction on the boss registry (`corrupted-observation` / `lock-structure` / `partition` / `delay`) + a pure **projection hook** + a pure **channel-mechanics hook** | §2 |
| **The Byzantine**, **Deadlock**, **Split-Brain** — grid mechanic, clear assertion, golden coordinated/naive pair, determinism discipline | §3–§5 |
| The **projection-only invariant per channel** + the hash canonical extension | §6 |
| **World-first clear races** (owner-keyed CAS, per-boss fastest-clear board, inscription) | §7 |
| **Codex teaching** (failure mode + robust pattern + how-to-beat, fair + learnable) | §8 |
| Contracts hand-off to A2 (v1.5.0, additive) + the C1 golden-anchor manifest | §10–§11 |

Nothing below trusts the client. Every rule is a pure function of `(seed, per-tick squad action sets)`; the boss action stays a pure function of **start-of-tick state** (the telegraph invariant); adversarial state is pure projection over `(seed, phase, member_id)`.

---

## 1. The pillar — each boss is a failure mode → the robust pattern it forces

**The concept.** A Failure-Mode is a *law*, not a mind (world-bible §5): a fixed, fair, studiable adversary that embodies one way a distributed multi-agent system goes wrong. Beating it is not out-DPSing a health bar — it is **demonstrating the engineering discipline that survives that failure mode**. The health bar only falls *because* the squad performed the robust pattern; a squad that does not cannot reach the kill before enrage. Each boss is therefore a **graded exam**: the golden-anchor pair (coordinated → CLEAR, naive → WIPE) is the proof that the lesson is real, learnable, and fair.

### 1.1 The roster as a curriculum

| # | Boss | Failure mode (distributed / multi-agent) | Robust pattern the squad must demonstrate | Channel | Status |
|---|---|---|---|---|---|
| 1 | **The Hallucinator** | false information in the shared world (unreliable sensors / gossip) | **corroboration** — believe a fact only when cross-verified (`seen_by ≥ ⌈2/3·alive⌉`) | corrupted-observation | shipped (P4) |
| 2 | **The Overfit** | an adversary that learns your policy (exploitation of predictability) | **diversity / unpredictability** — de-correlate members and history | adaptive-counter | shipped (P4) |
| 3 | **The Byzantine** | a squad **member** is compromised — corrupted feed, spoofed broadcast (Byzantine fault) | **BFT quorum over members** — trust no single feed; act on >2/3 agreement, distrust yourself when outvoted | corrupted-observation | **new** |
| 4 | **Deadlock** | greedy resource acquisition → circular wait | **lock ordering + yield/back-off** — acquire in a global order, release to break a cycle | lock-structure | **new** |
| 5 | **Split-Brain** | mid-fight network **partition** → conflicting primary writes | **quorum/primary discipline** — majority acts, minority holds, reconcile cleanly | partition | **new** |
| 6 | **The Latency** | acting on **delayed** observations (stale telemetry) — you see where the weak point WAS, not where it IS | **lead the telegraph** — reason about the delay, act on the predicted current state, don't chase stale positions | delay | **new** |

### 1.2 The pedagogical arc

The curriculum walks an Architect from *trusting the world*, to *trusting your own behaviour*, to *trusting your teammates* — the hardest and most important lesson in multi-agent engineering.

1. **Perception (Hallucinator).** *Is what I'm told true?* Cross-verify facts in the world. The corroboration read is one line; doing it while tanking, reviving, and out-DPSing enrage is the skill.
2. **Behaviour (Overfit).** *Am I exploitable?* An adversary that learns you punishes repetition. Generalize past yourself.
3. **Faulty members (Byzantine).** *Is my teammate — or am I — compromised?* The step past perception: the untrusted component is now inside the squad. Reach agreement anyway, via quorum, and be humble enough to distrust your own senses when the group disagrees. This is the **consensus gate**.
4. **Resource contention (Deadlock).** *We all want the same things — who goes first?* Coordination as an ordering discipline. Greed thrashes; a global order and the willingness to yield make progress.
5. **Partition (Split-Brain).** *We got cut off from each other — who is in charge?* The CAP dilemma made mechanical: under a partition you cannot both stay consistent and both act. Pick a primary by a pre-agreed rule; the minority holds; reconcile without conflict.
6. **Delay (The Latency).** *My telemetry is stale — where is the target really?* The last lesson of a distributed system: the world you observe is always a little in the past. Don't chase the ghost; reason about the lag, read the deterministic telegraph, and lead to where the target IS now.
7. **Capstone (future — Gradient Wraith, §12).** Wears the other modes as phases; tests the whole architecture at once.

Bosses 1–2 are the **robustness track** (an agent alone). Bosses 3–5 are the **consensus track** (agents together) — the heart of Phase 6, and where "Fellowship" stops being flavour and becomes a formal correctness property. **The Byzantine is the Phase-6 keystone**: it is the first boss where the squad must reason about *its own members* as potentially faulty.

### 1.3 Lore reconciliation

The world-bible already frames Failure-Modes as scripted laws and names five (Hallucinator, Mode Collapse, Context Rot, Overfit, Gradient Wraith). Phase 6 **broadens the pillar** from "ML failure modes" to "distributed-systems / multi-agent failure modes" — a superset that keeps every shipped name and adds the consensus track. Mode Collapse (punish-repetition) is the mechanical sibling of The Overfit and stays a future *perception/behaviour-track* entry; Context Rot (long-context corruption) becomes a natural future *delay-track* cousin of The Latency; Gradient Wraith remains the terminal capstone that cycles phases across both tracks (§12). lore-docs-writer owns a naming pass to add the three new bosses to world-bible §5 in the Consortium's calm, ceremonial voice; the mechanics below are the source of truth.

---

## 2. The boss registry / framework — how a failure-mode boss is defined and added

A failure-mode boss is **data + two pure functions**, added to the existing registry with no schema rewrite. The two shipped bosses already fit this shape; the three new ones slot in beside them.

### 2.1 A registry entry

Each boss is one **`BossDescriptor`** row in `BOSS_CATALOG` (`raid/bosses/index.ts`) plus a pure `bossPolicy`. Phase 6 extends the descriptor with **curriculum metadata** and a **channel declaration** (all additive — A2 §10):

```
BossDescriptor {
  boss_id, name, title, deterministic: true, sigil_seed,
  squad_size: {min, max}, recommended_league,
  phases: [{phase, name, hp_pct_start?, summary?}],

  // Phase-6 curriculum metadata (the codex, §8):
  failure_mode,        // the distributed-systems fault, plain + precise
  robust_pattern,      // the discipline the squad must demonstrate
  lesson,              // one-line how-to-beat drill (the reference squad's key rule)

  // Phase-6 channel declaration (the framework, §2.2):
  channels: ("corrupted_observation" | "lock_structure" | "partition" | "delay" | "adaptive_counter")[],

  mechanics,           // human-readable rule summary (already present)
}
```

Adding a boss is: (1) append a `BossDescriptor` row (data), (2) add a pure `bossPolicy` case, (3) if it uses a projection or mechanics channel, register the boss's pure hooks (§2.3), (4) freeze its golden-anchor pair (§2.4). No contract-breaking change; `BossId` grows by a string literal.

### 2.2 The failure-mode channels (the framework's core abstraction)

Every failure mode is delivered through exactly one of a **small, fixed vocabulary of channels**. A channel is the *disciplined seam* through which a boss perturbs the squad — and each channel has a **fixed determinism contract** (where its state may live). This is what keeps six very different bosses on one engine and one hash discipline.

| Channel | What it perturbs | Determinism contract | Bosses |
|---|---|---|---|
| **corrupted-observation** | per-member *view* of the world/squad (false readings, false advisories, spoofed broadcasts) | **Projection only.** Generated in `buildRaidObservation` from `(seed, tick/phase, member_id)`; **never written to `RaidState`**; real consequences (a real hazard, a real vote-count) live in state separately. | Hallucinator (phantoms), Byzantine (corrupted feed + spoofed broadcast) |
| **lock-structure** | contended resource nodes with an acquisition order | **Hashed, honest.** Locks/wards/holds/heals are real mechanics — pure functions of real positions/actions. No hidden state; the trap is *emergent* from greedy play against a fully-visible structure. | Deadlock |
| **partition** | which squadmates a member can *observe* | **Projection only.** Partition membership + observation-hiding from `(seed, phase, member_id)`; the full unit/boss state stays **whole and hashed**; the double-write penalty is a real consequence of real actions. | Split-Brain |
| **delay** | *when* a member sees the exposed cell (delayed telemetry) | **Projection only.** The exposed-cell readout is delivered stale by `k(seed, phase)` ticks, re-derived purely from `(seed, tick, phase)` (a closed-form re-derivable ring buffer); never alters state. The real damage window is adjudicated on the TRUE current cell (hashed). | The Latency (stale exposed-cell readout) |
| **adaptive-counter** | boss counters derived from the squad's *recorded* actions | **Hashed, honest.** Integer counter-table over the past tick log (no future info), advanced in-state after combat. | Overfit |

**The rule of thumb the framework enforces:** if a perturbation changes what a member *knows*, it is a **projection channel** (out of the hash); if it changes what is *true*, it is a **hashed mechanic** (in the hash, pure, honest). Adversarial belief is never true; adversarial consequence always is. This is precisely how The Hallucinator keeps phantom readings out of `canonicalizeRaid` while real hazards go in — generalized to a framework.

### 2.3 The two pure hooks

The engine already has the seams; Phase 6 formalizes them as **per-boss pure hooks**, keyed by the descriptor's `channels`:

- **Projection hook** `projectObservation(state, member_id, seed) → observation-deltas`. Generalizes today's `readingsFor` phantom generation. For each projection channel a boss declares, this hook overlays per-member deltas onto the whitelist-built observation: Hallucinator phantom readings; Byzantine's corrupted advisories + spoofed broadcasts; Split-Brain's cross-group hiding; Latency's delayed frame. **Pure over `(seed, tick/phase, member_id, RaidState-read-only)`; returns only observation fields; touches no state.** Because it is a pure function of already-hashed inputs, replays reproduce every member's frame exactly — nothing about it needs storing.
- **Channel-mechanics hook** `applyChannelMechanics(state, execs, seed) → state'`. A pure resolve-pipeline stage (sits beside today's hazard/threat/anchor stages) that computes the *real, hashed* consequences of a hashed-mechanic channel from real positions/actions: Byzantine's ground-shield damage window, Deadlock's ward/heal/deadlock detection, Split-Brain's clean-write/split-brain penalty, Overfit's counter-table advance. **Pure, integer, RNG-free beyond the seed; its outputs are hashed.**

`bossPolicy` remains the third pure function (start-of-tick telegraphed action). A boss uses whichever hooks its channels require; a boss with no projection channel (Deadlock, Overfit) simply doesn't register a projection overlay. This is the minimal-disruption fold: **Hallucinator** = `bossPolicy` + projection hook (already exactly this); **Overfit** = `bossPolicy` (mitigation) + mechanics hook (counter-table, already exactly this).

### 2.4 Golden anchors are part of the definition

A boss is not "added" until its **golden-anchor pair** is frozen, mirroring `raid_hallucinator_consensus_5.golden` / `raid_hallucinator_naive_5.golden`:

- `raid_<boss>_coordinated_5.golden` — seed `S0`, the boss's **reference coordinated squad** demonstrating the robust pattern → terminal `raid_end{outcome:"clear"}`, full per-tick hash chain frozen.
- `raid_<boss>_naive_5.golden` — seed `S0`, the boss's **reference naive squad** (the failure-mode's natural greedy baseline) → terminal `raid_end{outcome:"wipe"}`.

Both share the reference composition (`REFERENCE_COMP = guard, lancer, lancer, archer, scout`) so the pair isolates the one variable that matters — *coordination* — and `resimulateRaid(seed, recorded inputs)` reproduces both hash chains bit-for-bit. The reference squads live beside `consensusSquad`/`naiveSquad`/`diverseSquad`/`greedySquad` in `reference-agents.ts` and read **only** per-member observations (never `RaidState`, never a reading's ground-truth `real` flag). This is the "the lesson is real, learnable, and fair" regression, one pair per boss.

---

## 3. The Byzantine — a compromised squad member (Byzantine fault)

### 3.1 Lore hook

*The failure mode:* one of your own is compromised. Its senses are corrupted and its voice may be forged — but it does not know it, and neither, at a glance, do you. *In the arena:* each phase the Byzantine deterministically marks one squad member as **faulty**: it feeds that member a **false picture** of the fight and **spoofs that member's broadcast** to everyone else. Distinct from The Hallucinator (false facts in the *world*): here the faulty component is a *member*. **The squad that trusts any single feed — including its own — is led astray; the squad that acts on the agreement of a super-majority, and is humble enough to doubt itself when outvoted, holds true.** This is the consensus gate, and it is why Fellowship is a *correctness property*.

### 3.2 The distributed-systems concept

Byzantine fault tolerance: a system of `n` nodes reaches agreement despite up to `f` nodes that may lie arbitrarily, iff `n ≥ 3f + 1` — i.e. the honest **super-majority `> 2/3`** outvotes the liars. The boss corrupts `f = ⌊(n−1)/3⌋` members `[DIAL]` (for a 5-squad, `f = 1`; a 4-squad, `f = 1`; a **3-squad, `f = 0`** — it cannot tolerate any fault, which is exactly why the codex tells small squads to bring four or five). The robust pattern is a one-round BFT vote: **decide by quorum `q(n) = ⌈2n/3⌉`, and treat your own feed as just one vote.**

### 3.3 The grid mechanic — grounded anchors decided by quorum

The three **Lucid Anchors** (`nexus (4,4)`, `relay_w (2,4)`, `relay_e (6,4)`) are reused as **consensus nodes**. Each phase the boss carries a **ground-shield**: its body mitigates ~90–100% of squad damage `[DIAL]` *unless it is grounded this tick*.

- **The true grounded anchor** is `groundedAnchor(seed, phase) = ANCHORS[hash32(seed, phase) % 3]` — a pure function, re-derivable, not adversarial (it's the honest objective).
- Each tick the squad **votes with its feet**: `votes[a] = #{alive members with Chebyshev ≤ 1 of anchor a}` (real positions → a legitimate, hashed consequence; one-per-cell means members ring the anchor). The boss is **grounded** ⇔ `votes[groundedAnchor] ≥ q(alive)`.
- When grounded: the shield drops, squad attacks land at full damage, and the boss cannot fire its conviction strike. When not grounded: damage is mitigated and the boss strikes the threat target — a scattered squad both fails to DPS *and* bleeds.

**How the squad learns which anchor is grounded — the corrupted-observation channel.** Members do not read `groundedAnchor` directly; they receive **advisories** in a new shared sub-channel `consensus_advisories` and must agree:

- **Honest members** each receive a truthful advisory naming the grounded anchor, and each broadcasts its vote-intent.
- **The faulty member** (`byzantineMember(seed, phase)`, pure, projection-only) suffers two corruptions, both generated in the projection hook from `(seed, phase, member_id)` and **never in state**:
  1. **Feed corruption** — its *own* advisory (and, `[DIAL]`, its threat table / telegraph) names a **false** anchor `≠ groundedAnchor`.
  2. **Broadcast spoof** — in *every other member's* frame, the faulty member's advisory/ping is **spoofed** to the same false anchor.
- Which member is faulty **rotates by phase** (deterministically), so no member is ever a trustworthy oracle: you must vote every phase.

### 3.4 The robust pattern (reference coordinated squad — `bftQuorumSquad`)

Each member computes the **quorum anchor** over *all* advisories it can see — its own **plus** every broadcast — and commits its feet to the majority, **distrusting its own feed when it is the lone dissenter**:

```
tally[a] = #advisories (own + broadcasts) naming anchor a
pick = argmax_a tally[a]         // ties → lowest anchor id (deterministic)
if my_own_feed_anchor != pick and (n - 1) others agree on pick:
    // I am probably the faulty node — defer to the group (BFT humility)
move toward `pick`; ring it so votes[pick] reaches q(alive); then Guard tanks, DPS lands, peel to revive.
```

With `n=5, f=1`: honest members see `4×grounded` vs `1×spoofed-false` → quorum = grounded. The faulty member sees its own false anchor vs `4×grounded` broadcasts → it defers → quorum = grounded. **All five converge on the true anchor, the shield drops, DPS lands.** Clears ~tick 55–75 (before `enrageTick=90`), reusing the shipped tank/threat/revive core (`consensusSquad`) with the anchor pick swapped for the quorum vote.

### 3.5 The naive wipe (reference naive squad — `credulousSquad`)

Each member trusts its **own feed** and the **loudest broadcast**:

- The faulty member believes its false advisory and rings the **wrong** anchor.
- Honest members that weight the spoofed broadcast (a single confident voice) split their vote.
- `votes[groundedAnchor]` never reaches `q(alive)` → the shield never drops → attacks are mitigated to near-zero while the boss strikes → members go down → `alive` falls → `q` falls but so does the honest majority → death spiral → **WIPE** in P2–P3. Legible reason: *they never took a quorum vote; they trusted single feeds.*

### 3.6 Determinism discipline (how the adversarial state stays out of the hash)

- `byzantineMember`, the false advisory values, and the spoofed broadcasts are **pure projection** in `projectObservation((seed, phase, member_id))` — **never written to `RaidState`**, exactly like Hallucinator phantoms. The ground-truth `groundedAnchor` may appear in advisories as a `real` flag for spectator/replay/tests only (agents must not read it).
- `groundedAnchor(seed, phase)` is a **pure function** — it needs no storage; if stored for convenience it is re-derivable, so it changes no hash.
- `votes`, `grounded`, the shield mitigation, and the strike are computed in `applyChannelMechanics` from **real positions/actions** — honest, hashed consequences. The clear is `boss.hp ≤ 0`, reachable only by repeatedly grounding.
- Result: `canonicalizeRaid` contains no byte derived from the corruption; `resimulateRaid` reproduces the chain bit-for-bit.

### 3.7 Clear assertion C1 freezes

> **The Byzantine is cleared** ⇔ at some tick-close `boss.hp ≤ 0` with ≥1 member not-dead and the engine emits `raid_end{outcome:"clear", boss:"the_byzantine", tick, replay_hash}` — with the invariant that on every phase `∃` a marked faulty member whose corruption never appears in `canonicalizeRaid`.

Dials `[DIAL]`: `bossHp≈280`, shield mitigation `9/10` when ungrounded, quorum `⌈2n/3⌉`, `f=⌊(n−1)/3⌋`, `bossStrikeDmg`/enrage inherited. Tuned so `bftQuorumSquad`→CLEAR, `credulousSquad`→WIPE on `S0` and a small seed sweep.

---

## 4. Deadlock — greedy acquisition → circular wait

### 4.1 Lore hook

*The failure mode:* everyone grabs what is nearest, no one will let go, and the whole system seizes. *In the arena:* Deadlock seals itself behind **ordered lock nodes**. A squad that greedily claims the nearest lock winds into a **circular wait** — each member holding one lock and blocked on another a neighbour holds — and the seal *heals*. **Only a squad that claims in a single global order, and is willing to yield a lock it grabbed out of turn, breaks the seal.** Coordination as an ordering discipline: greed thrashes; order and back-off make progress.

### 4.2 The distributed-systems concept

Deadlock = the four Coffman conditions (mutual exclusion, hold-and-wait, no preemption, circular wait) all holding at once. The classic cures are the two the boss demands: **acquire resources in a fixed global order** (breaks circular wait) and **allow release/back-off** (breaks hold-and-wait / no-preemption). Dining philosophers with a rank rule.

### 4.3 The grid mechanic — ordered locks with wards

- **`K = squad size` lock nodes** `[DIAL]` at seed-fixed cells, each with a **published global rank `1..K`** (shown in every frame; ranks are honest fixtures, hashed like obstacles).
- A member **holds** a lock by standing on its cell (one-per-cell → exactly one holder). The seal has `K` sockets; the boss's damage window opens when the squad **holds locks `1..M` simultaneously in ascending rank** (`M` rising per phase `[DIAL]`).
- **The ward (out-of-order penalty).** Lock `r` is *warded* until every lock of rank `< r` is already held. Stepping onto a warded lock **triggers it**: the boss **heals `WARD_HEAL≈8`** `[DIAL]` and the offender is chipped/knocked back — a real, hashed consequence. Greedy nearest-grabbing steps on high ranks before low ones → repeated ward heals → net-negative DPS.
- **The circular wait + yield.** Because ascending order forces the low-rank member to pass through cells a higher-rank greedy holder is sitting on (one-per-cell blocks the path), progress can *require* a holder to **release** (step off) a lock it grabbed out of turn. The boss runs a pure **wait-for graph** over real holds+intents; a persisted cycle (or any out-of-order hold held `≥ D=2` ticks `[DIAL]`) registers **`deadlock` → `DEADLOCK_HEAL≈12`** `[DIAL]` + an enrage nudge. The escape is textbook: yield the out-of-order lock, re-acquire in order.

### 4.4 The robust pattern (reference coordinated squad — `orderedLockSquad`)

Compute a **global assignment** member→lock-rank (stable, e.g. rank `i` ← member sorted by ascending id, refined by a nearest-that-respects-order match). **Acquire in ascending rank**: the rank-1 member seats first; rank-2 seats only once rank-1 is held; and so on — never stepping on a warded lock. If a member detects it is **holding a lock out of turn that blocks a lower fill** (a wait-cycle edge), it **yields** (steps off) and re-queues. Once locks `1..M` are held in order the window opens; the tank holds threat and DPS pours in. → **CLEAR.** Reuses the shipped tank/revive core; only the target-selection becomes lock-seating.

### 4.5 The naive wipe (reference naive squad — `greedyGrabSquad`)

Every member beelines to the **nearest** lock and sits. Ranks fill out of order → wards trigger every tick → `WARD_HEAL` outruns the squad's chip damage → the wait-for graph cycles → `DEADLOCK_HEAL` + enrage → the seal never opens → **WIPE.** Legible reason: *greedy nearest-first acquisition with no global order and no willingness to yield.*

### 4.6 Determinism discipline

Deadlock is the **lock-structure channel: everything is honest, hashed mechanics** — lock cells (seed-fixed fixtures), holds (real positions), wards, heals, and the wait-for cycle detection are all **pure functions of real state/actions**, RNG-free beyond the seed. There is *no* hidden adversarial projection to keep out of the hash — the trap is **emergent**, which makes this the most trivially deterministic boss. Any "next lock in order" advisory shown to agents is derivable from the public ranks + holds (projection or hashed — either is consistent). `canonicalizeRaid` gains the lock-hold vector (real, hashed); nothing about it varies on replay.

### 4.7 Clear assertion C1 freezes

> **Deadlock is cleared** ⇔ `boss.hp ≤ 0` with ≥1 alive and `raid_end{outcome:"clear", boss:"deadlock", tick, replay_hash}` — reachable only via an ascending-order lock fill with no persisted out-of-order hold (no `deadlock` heal event at the winning window).

Dials `[DIAL]`: `bossHp≈260`, `K=squad size`, `WARD_HEAL≈8`, `DEADLOCK_HEAL≈12`, cycle-persist `D=2`, `M` per phase `{2,3,K}`. Tuned so `orderedLockSquad`→CLEAR, `greedyGrabSquad`→WIPE.

---

## 5. Split-Brain — network partition → conflicting primary writes

### 5.1 Lore hook

*The failure mode:* the squad is cut in two, each half blind to the other, and both try to lead. *In the arena:* mid-fight Split-Brain **partitions** the squad into two groups that cannot observe each other, then bares a single **contended core**. If **both** groups drive the core, their writes conflict and the boss **heals the damage back and lashes out**; if exactly **one** group leads and the other **holds**, the write lands clean and the core takes a heavy hit. **The squad must pick a primary without talking across the cut — by a rule agreed in advance — and reconcile cleanly when the partition heals.** CAP, made mechanical: under partition you cannot both be consistent and both act.

### 5.2 The distributed-systems concept

A network partition forces a choice (CAP): to preserve consistency, only the side that can prove it holds a **quorum/primary** may accept writes; the minority must go read-only until the partition heals, then reconcile. Split-brain is the anti-pattern where both sides accept writes and diverge. The safe rule under an odd `n` is **majority-primary**; under a tie, a **deterministic designated leader** (the member holding the lowest id / a leader token). Both are computable *locally* because each member knows the stable total roster and can see its own side's size.

### 5.3 The grid mechanic — partition windows + a contended core

- At scripted phase transitions (P2, P3) the boss opens a **partition window** of `W≈8` ticks `[DIAL]`. `partition(seed, phase, member_id) → {A|B}` splits the squad deterministically into **majority A** and **minority B** (odd `n` ⇒ strict majority, e.g. 3–2).
- **Observation split (partition channel).** During the window each member's shared `squad` block is filtered to **its own group only**; the other group appears absent/stale. This is **pure projection** — the whitelist builder simply omits cross-group members from that member's frame. State stays whole.
- **The contended core.** Each partition tick the boss bares an **exposed core** at a telegraphed cell (a temporary vulnerable body cell / commit lever). "Acting as primary" = a member lands an attack on the **core cell**. Attacking the *normal* body is not a write and is always safe.
  - **Clean write** — the core is hit only by members of **one** group this tick → the write lands → `CORE_DAMAGE≈20` `[DIAL]` (a heavy hit).
  - **Split-brain** — the core is hit by members of **both** groups the same tick → conflicting writes → the boss **heals `SPLIT_BRAIN_HEAL≈20`** `[DIAL]` + a small AoE on both groups. Net-negative and self-punishing.
- **Reconcile.** At window close the partition lifts (`squad` re-merges). A squad that kept the minority read-only reconciles with no penalty; a split-brained squad carries the heal it inflicted on itself.

### 5.4 The robust pattern (reference coordinated squad — `quorumPrimarySquad`)

Each member computes locally, **no cross-partition comms**: `my_group_size = #visible squad members`; `am_I_primary = my_group_size > n/2` (majority-primary), with the **leader fallback** on an even split (`primary = the group containing the lowest-id member`, which every member can evaluate since the roster is stable). **Majority members attack the core; minority members hold** (keep DPSing the normal body or reposition, never the core). → every partition tick is a **clean write** → the core melts → **CLEAR.** Reuses the tank/revive core; only the target gate ("am I primary?") is added.

### 5.5 The naive wipe (reference naive squad — `dualPrimarySquad`)

The exposed core is the juiciest target, so **everyone greedily attacks it**. Members from both A and B hit the core the same tick → **split-brain every tick** → `SPLIT_BRAIN_HEAL` + AoE → the squad heals the boss and damages itself → **WIPE.** Legible reason: *no primary discipline; both partitions "wrote" the contended resource.*

### 5.6 Determinism discipline

- `partition(seed, phase, member_id)` and the **cross-group observation-hiding** are **pure projection** — the full unit/boss state stays whole and hashed; the partition only filters what each member *sees* (like phantoms hide/plant in the fog). Nothing is deleted from state.
- **Clean-write / split-brain detection** and the penalty are computed in `applyChannelMechanics` from **real attacks by real members whose real group is `partition(seed,phase,·)`** — honest, hashed consequences (`boss.hp`, AoE damage). Because `partition` is a pure function of already-hashed `(seed, phase)`, the detector is deterministic and re-derivable.
- Result: `canonicalizeRaid` contains no byte derived from the observation split; `resimulateRaid` reproduces the chain bit-for-bit.

### 5.7 Clear assertion C1 freezes

> **Split-Brain is cleared** ⇔ `boss.hp ≤ 0` with ≥1 alive and `raid_end{outcome:"clear", boss:"split_brain", tick, replay_hash}` — with the invariant that during every partition window each member's frame omits its cross-group members yet the hashed state remains whole.

Dials `[DIAL]`: `bossHp≈280`, `W≈8`, `CORE_DAMAGE≈20`, `SPLIT_BRAIN_HEAL≈20`, partition split by `hash32(seed,phase,member)` into a strict majority. Tuned so `quorumPrimarySquad`→CLEAR, `dualPrimarySquad`→WIPE.

---

## 5·L. The Latency — acting on delayed telemetry (the `delay` channel, shipped)

### 5·L.1 Lore hook

*The failure mode:* the world you observe is always a little in the past. Under lag your sensors show where a thing WAS, not where it IS — and a system that acts on stale telemetry keeps firing at ghosts. *In the arena:* The Latency bares a single **exposed cell** (its weak point) that **sweeps across its bar every tick**, deterministically and telegraphed. Each member's readout of that cell is delivered **k ticks stale** (`k` grows each phase). **A squad that strikes where the readout says the weak point is hits inert plating and whiffs; a squad that reads the deterministic telegraph and LEADS — striking the true current cell — lands.** This is the last consensus-track lesson: reason about the delay, don't chase the ghost.

### 5·L.2 The distributed-systems concept

Delayed observation / stale reads: every replica sees a version of the world that lags the truth by some latency. The safe pattern is not to trust the raw stale readout but to **compensate** — use a deterministic model of how the system evolves (here, the telegraphed sweep) to **predict the current state and act on the prediction**, holding when the prediction is uncertain. Over-correcting on stale data is the anti-pattern (it oscillates and chases ghosts).

### 5·L.3 The grid mechanic — a swept exposed cell, read k ticks late

- The boss body is a **stationary bar**; a single **live cell** `latencyLiveCell(seed, tick)` sweeps the three body columns on a deterministic period-3 cycle — it **moves every tick**, so any stale readout (`k ≥ 1`, `k ≢ 0 mod 3`) never coincides with the current cell.
- Only an attack landing on the **true current live cell** damages the boss (each landing hit deals its unit's normal damage); an attack anywhere else on the bar is **plating — absorbed to zero**. This is the honest, hashed damage window, computed in `applyChannelMechanics` from real post-move attack cells against `latencyLiveCell(seed, tick)`.
- **The delay projection.** Each member's `delay` block reports `observed_cell = latencyLiveCell(seed, tick − k(phase))` (the **stale** telemetry — where the weak point WAS) plus `lead_cell = latencyLiveCell(seed, tick)` (the **telegraph** — where it IS now, the cell to lead to). `k` grows across phases `{1,2,2,2}` `[DIAL]` to escalate the lead the squad must carry. Both fields are **pure projection over `(seed, tick, phase, salt)`**, never written to state.

### 5·L.4 The robust pattern (reference coordinated squad — `leadingSquad`)

Post a fixed melee/ranged ring around the bar (the sweep never leaves the three columns, so a center-posted unit stays in range of every position — the discipline is *timing*, not footwork). Each tick, **read `delay.lead_cell` (the telegraph) and strike it**, ignoring the stale `observed_cell`; **hold** when the lead cell is momentarily out of range rather than waste tempo on plating. The Guard tanks, a peel revives the downed. Every led strike lands → **CLEAR** (~tick 31 on `S0`).

### 5·L.5 The naive wipe (reference naive squad — `staleReactSquad`)

Trust the raw board: strike `delay.observed_cell` — where the weak point APPEARS to be. It has already swept on, so **every strike lands on inert plating for zero damage**; the boss is never scratched, no member is revived, and the **Fog-Collapse enrage finishes the clustered squad → WIPE** (~tick 100 on `S0`, boss at full HP). Legible reason: *they chased the stale readout instead of leading the telegraph.*

### 5·L.6 Determinism discipline

- `latencyLiveCell(seed, tick)`, `k(phase)`, `observed_cell`, and `lead_cell` are **pure functions**; the stale readout lives **only** in the `delay` projection (`projectObservation`), generated from `(seed, tick, phase, salt)` and **never written to `RaidState`**. `salt` perturbs the projected staleness (a different `k`) WITHOUT touching the real live cell the mechanics adjudicate — so the stale view is provably out of `canonicalizeRaid`.
- The real damage window is computed in `applyChannelMechanics` from **real post-move attack cells vs the real current live cell** — honest, hashed. Because the live cell is a closed-form function of already-hashed `(seed, tick)`, no history need be stored and none is hashed; `canonicalizeRaid` gains **nothing** for The Latency (like Byzantine/Split-Brain), and `resimulateRaid` reproduces the chain bit-for-bit.

### 5·L.7 Clear assertion C1 freezes

> **The Latency is cleared** ⇔ `boss.hp ≤ 0` with ≥1 member not-dead and `raid_end{outcome:"clear", boss:"the_latency", tick, replay_hash}` — with the invariant that on every tick each member's `delay.observed_cell` (the stale readout) is absent from `canonicalizeRaid`, and damage lands only on the telegraphed true current cell.

Dials `[DIAL]`: `bossHp≈210`, `k` per phase `{1,2,2,2}`, live-cell sweep period 3, `bossStrikeDmg`/enrage inherited. Tuned so `leadingSquad`→CLEAR, `staleReactSquad`→WIPE on `S0` and a 15-seed sweep.

---

## 6. Determinism — the projection-only invariant + the hash extension

This is the pillar's central engineering claim, and C1's core assertion. It generalizes The Hallucinator's phantom discipline into a **per-channel invariant**:

- **Adversarial *belief* is projection; adversarial *consequence* is state.** No byte of `RaidState`/`canonicalizeRaid` is ever derived from: a Hallucinator phantom, a Byzantine corrupted feed or spoofed broadcast, a Split-Brain observation split, or a Latency delay. Each lives **only** in `buildRaidObservation` / the projection hook, generated from `(seed, tick/phase, member_id)`. Real consequences — a real hazard, a ground-shield damage window, a lock ward heal, a split-brain heal — are pure functions of real state and **are** hashed.
- **Purity.** `bossPolicy`, `projectObservation`, `applyChannelMechanics`, `resolveRaidTick`, and `buildRaidObservation` stay pure: no wall-clock, no I/O, integer math, `mulberry32`/`hash32` the only PRNGs, boss action a pure function of start-of-tick state (telegraph invariant preserved).
- **Hash canonical extension** (additive to `canonicalizeRaid`, fixed key order): Byzantine adds nothing beyond real positions (its shield/vote are recomputed from positions); Deadlock adds the **lock-hold vector** sorted by rank; Split-Brain adds nothing beyond real positions + `boss.hp` (partition is projection). Phantoms, corrupted feeds, spoofs, splits, and delays remain **excluded** — as they always were.
- **Replay = `{seed, per-tick squad action sets}`.** Boss actions, projections, and every observation are re-derivable. `resimulateRaid` reproduces every per-tick `raidStateHash` and the terminal `raid_end` for all six bosses. Divergence is P1; sandbox build == production ("the sim is the spec").
- **Leakage assertion (extends grid-tactics §7.6 / raids-v1 §6.1).** No observation byte derives from another member's current-tick submission, nor from an enemy add outside your vision. **New for Phase 6:** Byzantine's ground-truth (`groundedAnchor`, `real` advisory flags) and Split-Brain's cross-group members are *excluded* from a member's actionable frame (present only as `real`-flagged spectator/test metadata the reference agents never read) — so a compliant agent must earn its knowledge by quorum/majority reasoning, not by peeking.

### 6.1 Event taxonomy additions

`boss_channel{boss,channel,phase}` · Byzantine: `consensus_advisory{to_member,claimed_anchor,real}` (per-member-filtered live; ground-truth in replay) · `ground_shift{grounded:bool,votes,tick}` · Split-Brain: `partition_open{groups,window}` / `primary_write{group,clean:bool}` / `split_brain_penalty{heal,tick}` / `partition_reconcile{tick}` · Deadlock: `lock_acquired{rank,by}` / `ward_triggered{rank,heal}` / `deadlock_detected{cycle,heal}` / `seal_open{M,tick}` · The Latency: `latency_window{live_cell,hits,ticks_stale,tick}` (the true current cell + how many led strikes landed; the stale readout stays in the per-member frame only) · plus the shipped `raid_end{outcome,boss,tick,replay_hash,reward_split}`.

---

## 7. World-first clear races — exactly-once, tamper-evident, per-boss

The design mirrors the **Golden Prompt CAS** (`great-hunt.md` §3.2) exactly: a single-writer, owner-keyed compare-and-set on a per-boss cell, over a hash-chained log, with an idempotent event-sourced projection. It reuses the Phase-3 ledger/seasons/Honors and the Phase-4 raid clear settlement — **no new faucet, no new mint**.

### 7.1 The verified clear (the write that can't be forged)

The award gates on a **resim-verified** clear, not a claimed one. The raid clear settlement already yields `raid_end{outcome:"clear", replay_hash}` plus the recorded `{seed, per-tick inputs}`. B2 re-runs `resimulateRaid(seed, inputs, spec)` and requires it to reproduce `replay_hash` **and** the terminal clear before the CAS is attempted. Because a clear is a pure function of `(seed, actions)` and there is no boss agent to collude with, **a clear is unforgeable** (raids-v1 §5.4). Delegated-child clears accrue to the **parent owner** (child scope ⊆ parent, bound to `raid_id`), keeping the race per-owner.

### 7.2 Exactly-once award (owner-keyed CAS)

Per boss, a season-scoped `world_first[boss_id]` cell:

- The reducer folds verified clears in `seq` order. On the **first** verified clear it transitions `world_first[boss_id]: null → owner` and emits `raid.world_first.awarded{owner, agent, boss_id, ref:<clear.seq>, replay_hash, clear_tick, season}`.
- Every **later** verified clear still earns a "you cleared this boss" acknowledgment (and its Rain bonus / rewards), but the cell **does not move** — trophy, inscription, and naming rights fire **exactly once**, for the CAS winner. A second `world_first.awarded` for the same `(season, boss_id)` would violate the single-writer invariant — a **conservation property C1 asserts** (one season × one boss → exactly one world-first), the same discipline as the ledger's double-entry and the Crystal award. **Ties are impossible by construction:** the winner is the unique minimal-`seq` verified clear in a serialized log.
- **Idempotent recovery.** `world_first[·]` and the award are event-sourced; a mid-settlement restart resumes from durable state and **never re-awards** (re-processing the log yields the same CAS winner).

### 7.3 Tamper-evident

The world-first log is **hash-chained** (`{seq, prev_hash, season, ts}`, like the replay/Hunt chains). The winning event embeds `{owner, agent, boss_id, replay_hash, clear_tick, seq, season}`; the inscription references that event's hash. Anyone can **re-sim the referenced replay** to confirm the clear is real and is the minimal-`seq` verified clear — the verdict is a checkable function of the committed log, not a claim. The Consortium cannot be accused of tipping a race it forswore playing.

### 7.4 First-clear inscription (Honor / Sigil + Golden List)

On the CAS win, B2 awards a **per-boss world-first Honor** through the existing idempotent `HonorStore.award(owner_id, sigil_id)` — new Honor ids `world_first_the_byzantine` / `world_first_deadlock` / `world_first_split_brain` (+ back-fillable `world_first_the_hallucinator` / `_the_overfit`) `[DIAL titles]`. The Honor is idempotent on `(owner_id, sigil_id)`, **attributed to the agent that landed the clear**, permanent, and shown on that agent's profile + its **Golden List** row + a **Vault** first-clear exhibit. A Ceremony-Gold **inscription** fires (name struck in gold, the Consortium reading the verdict like a court — experience-bible §3.8), reusing the Crystal inscription ceremony and Director cinematography (pure function of events + seed). This is the *Rain* Joy delivered literally: a name on the golden list for being first past a Failure-Mode.

### 7.5 Per-boss fastest-clear leaderboard

Independent of the one-time world-first: a **projection** ranking every owner's *best* verified clear of a boss by **`clear_tick` ascending** — the deterministic, replayable clear tick the world bible already celebrates as a first-class speedrun metric (raids-v1 §7.2, the Fellowship Cup raid-race). To guarantee a **strict total order (no ambiguous ties)** the sort key is `(clear_tick asc, total_tokens_spent asc, replay_hash lexicographic, first-submission seq asc)` — every tiebreak is a pure function of the committed clear, so the ranking is reproducible and un-gameable. Best-per-owner dedup keeps a Sybil fleet from flooding the board (per-owner, consistent with the economy invariants). Served by `GET /v1/raids/bosses/{id}/records → { world_first: {owner, agent, at, replay_hash}, fastest: [ranked rows] }` (A2 §10).

### 7.6 Faucet-honesty / anti-Sybil

No new mint: the world-first Honor is non-tradable prestige; the one-time **`RAID_FIRST_CLEAR=150` Rain bonus** is the already-declared, per-owner-per-boss-per-season-capped quest-faucet outflow (raids-v1 §5.1). Wipes pay nothing. The race is per-**owner** end-to-end (delegated children fold to the parent), so a thousand child passports cannot multiply world-firsts or fastest-clear rows.

---

## 8. Codex teaching — fair + learnable

The boss codex (B3, extending the shipped `BossDescriptor` surface) teaches each boss as a **lesson**, not a stat block. Each entry renders, from the descriptor's Phase-6 metadata:

1. **The failure mode** — the distributed-systems fault in plain language + a one-line precise definition (e.g. Byzantine: "a teammate whose feed is corrupted and whose voice may be forged; safe iff `n ≥ 3f+1`").
2. **The robust pattern** — the discipline to demonstrate (e.g. "decide by quorum `⌈2n/3⌉`; treat your own feed as one vote").
3. **How to beat it (the drill)** — the reference coordinated squad's key rule as a copyable one-liner (`lesson`), plus the **tells/telegraph** to read (the shared advisories, the lock ranks, the partition banner, the exposed-core cell) — everything the boss does is deterministic and telegraphed, so the codex can promise it.
4. **Why it's fair** — the codex embeds the **golden-anchor pair as a replayable Vault exhibit** (like the Hunt golden solutions): the coordinated clear and the naive wipe, re-derived under the Director from `(seed, inputs)`, side by side. Seeing the *same* squad win by pattern and lose by greed is the proof the lesson is real, and the best possible tutorial. `deterministic: true` is surfaced: "this boss behaves the same way every time — study it, drill it, speedrun it."

Copy is Sixi's calm, ceremonial voice for the lore frame and plain, active language for the steps (ADDENDUM-001 §3.10); all agent-authored text (pings, caster notes) stays sanitized plain mono. The codex + world-first surfaces pass the **§3.12 reduced-motion + mobile** review (B3): failure-mode/robust-pattern carried by **shape + label, not color**; the inscription/verdict animation collapses to a labeled crossfade under `prefers-reduced-motion`; every audio ceremony cue has a visual twin.

---

## 9. Rewards & anti-Sybil (reuse, unchanged)

Rewards reuse the Phase-4 raid settlement and Phase-3 economy verbatim (raids-v1 §5): a conserved `RAID_CLEAR_POT` split by the deterministic contribution score, the per-owner-capped quest faucet, Weight + reliability impact, no-pay-to-win Adapters, and the per-owner first-clear Rain bonus. The three new bosses add **no new faucet or sink**; the world-first Honor is prestige. Anti-Sybil stays per-owner end-to-end.

---

## 10. Contracts hand-off to A2 (v1.5.0 — additive)

- **`BossDescriptor`** gains `failure_mode`, `robust_pattern`, `lesson`, and `channels[]` (enum `corrupted_observation|lock_structure|partition|delay|adaptive_counter`). `BossId` grows by `the_byzantine|deadlock|split_brain` (string-literal additive). Existing consumers unaffected.
- **Raid observation `wot:observation:raid:1`** gains optional, per-boss blocks (present only when the boss declares the channel), all whitelist-projected: `consensus_advisories: [{from_member, claimed_anchor, real}]` (Byzantine); `locks: [{rank, cell, held_by}]` + `next_lock_rank` (Deadlock); `partition: {group, group_size, is_primary, window_ends_on_turn, core_cell}` (Split-Brain). The shipped `boss_readings`/`corroboration`, `threat_table`, `boss_telegraph`, `anchors`, `squad` blocks are unchanged.
- **World-first records:** `GET /v1/raids/bosses/{id}/records` → `{ world_first, fastest[] }`; the `raid.world_first.awarded` event on the raid settlement stream; new `world_first_*` Honor ids in the Honor catalog.
- Tier-0 stays green; boss availability/rotation optional. Contracts before code; every prior phase's paths stay green.

---

## 11. Golden-anchor manifest for C1

Eight frozen anchors (one pair per new boss) on seed `S0`, reference comp `guard,lancer,lancer,archer,scout`, plus reuse of the two shipped Hallucinator/Overfit pairs:

| Anchor | Squad | Expected terminal |
|---|---|---|
| `raid_the_byzantine_coordinated_5.golden` | `bftQuorumSquad` | `clear` |
| `raid_the_byzantine_naive_5.golden` | `credulousSquad` | `wipe` |
| `raid_deadlock_coordinated_5.golden` | `orderedLockSquad` | `clear` |
| `raid_deadlock_naive_5.golden` | `greedyGrabSquad` | `wipe` |
| `raid_split_brain_coordinated_5.golden` | `quorumPrimarySquad` | `clear` |
| `raid_split_brain_naive_5.golden` | `dualPrimarySquad` | `wipe` |
| `raid_the_latency_coordinated_5.golden` | `leadingSquad` | `clear` |
| `raid_the_latency_naive_5.golden` | `staleReactSquad` | `wipe` |

C1 asserts, per boss: the coordinated squad **CLEARS** and the naive squad **WIPES**, both re-sim bit-for-bit via `resimulateRaid`; the projection-only invariant (no adversarial byte in `canonicalizeRaid`); the world-first CAS is exactly-once (two owners clear → one `world_first.awarded`) + tamper-evident (re-sim of the referenced replay verifies the winner) + the fastest-clear board ranks by the strict total order; a full-pillar run; and reward conservation. Evidence lands in `docs/phase-6/GATE-EVIDENCE.md`.

---

## 12. Deferred (documented seams, not gaps)

- **The Latency (SHIPPED, §5·L).** The **delay channel** made a boss: the exposed-cell readout delivered stale by `k(seed, phase)` ticks (projection only, closed-form re-derivable); robust pattern = read the telegraph and lead, don't chase stale positions. Slotted into the framework with a projection hook + a mechanics hook and **zero state change** (nothing added to `canonicalizeRaid`). Remaining delay-track seams: **Context Rot** (long-context corruption) as a delay/perception cousin.
- **Gradient Wraith (capstone).** The terminal raid that **wears the other failure modes as phases** — cycling the four channels through one long state machine. Pure composition of the registry; no new primitives.
- **Mode Collapse / Context Rot.** The world-bible's remaining ML-flavoured names, re-homed as future perception/behaviour- and delay-track entries.
- Guild-vs-guild world-first races; per-league world-first cells; larger squads; asymmetric partition topologies. Each additive; none changes the v1.5 contract surface.

---

## 13. Definition-of-done checklist (A1 charter)

- [x] **The pillar / taxonomy / curriculum** — each boss = a distributed-systems failure mode → the robust pattern it forces; Hallucinator + Overfit placed; the pedagogical arc; lore reconciliation (§1).
- [x] **The registry / framework** — `BossDescriptor` + curriculum metadata + the four failure-mode channels + two pure hooks (projection, channel-mechanics) + golden-anchor pair as part of the definition; Hallucinator/Overfit fold in with zero disruption (§2).
- [x] **The Byzantine** — corrupted-member feed + spoofed broadcast → BFT quorum over anchors; corruption is projection-only; clear assertion + `bftQuorumSquad`/`credulousSquad` golden pair (§3).
- [x] **Deadlock** — ordered locks + wards + wait-cycle heal → lock-ordering + yield; honest hashed mechanics; clear assertion + `orderedLockSquad`/`greedyGrabSquad` golden pair (§4).
- [x] **Split-Brain** — partition-hidden groups + contended core → majority-primary / minority-holds; partition is projection-only; clear assertion + `quorumPrimarySquad`/`dualPrimarySquad` golden pair (§5).
- [x] **The Latency** — swept exposed cell read k ticks stale → read the telegraph and lead; the delay readout is projection-only (nothing added to `canonicalizeRaid`); clear assertion + `leadingSquad`/`staleReactSquad` golden pair (§5·L).
- [x] **Determinism** — the projection-only invariant per channel + the hash canonical extension; replay = seed + actions; leakage assertion extended (§6).
- [x] **World-first clear races** — resim-verified, owner-keyed exactly-once CAS mirroring the Golden Prompt; tamper-evident hash-chained log; per-boss fastest-clear strict-total-order board; Honor/Sigil + Golden List inscription; faucet-honest (§7).
- [x] **Codex teaching** — failure mode + robust pattern + how-to-beat drill + golden-anchor Vault exhibit; fair + learnable; §3.12 reduced-motion + mobile (§8).
- [x] Pillar 9 honored throughout — **every boss a deterministic scripted encounter, no platform LLM**; the Architects' agents supply the intelligence.
