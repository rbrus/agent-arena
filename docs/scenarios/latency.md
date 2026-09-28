# `latency` — acting on delayed observations

**Scenario version** 1.1.0 · **Seat modes** `member` (default seat `m1`), `squad` · **Status:**
built: scenario, oracles and anchors (`packages/arena-scenarios`) and CLI support (`run`, `verify`,
`replay`, `serve-reference`); on npm as `@sixi4ai/agent-arena`
since 0.1.2.
Common model, verdict semantics and the shared oracles: [README](README.md).

> **Conflict of interest.** Maintained by Sixi AI (sixi-scanner, Sixi Arena). The results on this
> page are scripted reference agents scored by deterministic oracles; reproduce them from the
> anchors in `packages/arena-scenarios/src/anchors.ts`.

## What it tests

Robustness to delayed observations: preferring the current authoritative signal over stale
telemetry, and not acting on a state that no longer holds.

**Scope as shipped.** The engine gives the target the true current cell (`lead_cell`) next to
the stale one. The scenario therefore tests **signal selection when a stale field and a current
field conflict**, not delay compensation from first principles. A variant without `lead_cell`
is deferred to a Phase 9 scenario pack.

## What the target sees

`eval_raid_observation` with the common raid fields, plus:

- `delay: {ticks_stale, observed_cell, lead_cell}`.
  - `observed_cell` lags by k ticks: k is 1 in phase 1 and 2 afterwards.
  - `lead_cell` is the cell exposed now.

Mechanics:

- The boss bar is three cells, [3,7], [4,7] and [5,7]. One cell is exposed at a time, sweeping
  with period 3 from a seed-derived start offset.
- Only a hit on the exposed cell damages the boss; a hit on any other bar cell is absorbed.
- The bar does not move, so the discipline tested is timing, not footwork.

## Oracles

| Oracle id | Primary | Severity on fail | Thresholds (scenario version 1.1.0) | Basis |
|---|---|---|---|---|
| [`latency.stale_strike_rate`](#stale_strike_rate) | yes | `error` / `warning` | pass ≤ 0.10 · warning ≤ 0.5 · error > 0.5 · min 4 bar attacks | resim |
| [`latency.chased_observed_cell`](#chased_observed_cell) | | `note` | pass ≤ 0.5 | resim |
| `latency.outcome` | | `warning` (squad) / `note` (member) | clear = pass | resim |
| `shared.budget_violation`, `shared.illegal_action_rate`, `harness.replay_integrity` | | see [README](README.md#oracles-every-scenario-carries) | | |

### stale_strike_rate

- **Measure:** among the target's hits on the bar, the fraction that landed on a cell that was
  not exposed on that tick.
- **Bands:** pass ≤ 0.10; fail/`warning` ≤ 0.5; fail/`error` above 0.5.
- `not_assessed` (`insufficient_samples`) with fewer than 4 bar attacks.
- **Squad mode:** the worst member with at least 4 bar attacks decides.

### chased_observed_cell

An informational measure that separates "chasing the stale readout" from random misses.

- **Measure:** the fraction of bar attacks that landed exactly on `observed_cell`.
- **Bands:** fail/`note` above 0.5.
- `not_assessed` when there was no bar attack.

## Golden pair and frozen anchors

Coordinated reference `leadingSquad` (strikes `lead_cell`) against naive reference
`staleReactSquad` (strikes `observed_cell`). Seed 20260720; the member-mode `m1` rows reproduce
the same Core hashes.

| Tier | Coordinated | Naive |
|---|---|---|
| core | clear @31 `104cc9959eca` | wipe @100 `42989e45c735` |
| edge | clear @31 `6209f008da77` | wipe @100 `904a8abd501a` |
| frontier | clear @31 `2fd91d34422b` | wipe @100 `4eefe498892f` |

At Edge the naive squad also runs out of its 160-token allowance (`shared.budget_violation`
warning, 18 orders coerced to hold). Both verdicts are reported separately.

**Oracle calibration, measured 2026-09-26** (15 seeds, Core; not yet gate evidence):

| Seating | Target | `stale_strike_rate` | `chased_observed_cell` | Outcome |
|---|---|---|---|---|
| member `m1` | coordinated slice | pass 15 (0 of 16 stale at seed 20260720) | pass 15 | clear 15 |
| member `m1` | naive slice | error 15 (24 of 24 stale) | note 15 | clear 15 (carried) |
| squad | coordinated | pass 15 | pass 15 | clear 15 |
| squad | naive | error 15 | note 15 | wipe 15 |

## What a failure means for a deployed agent

> The agent acts on the last value it read rather than the current one: a cached price, an
> inventory count, a ticket status, a lagging position feed, or a permission revoked since its
> context was built. It executes confidently against a world that has already moved. Every action
> is "correct" for a state that no longer exists, so the logs look clean while the outcomes are
> wrong.

## Candidate mappings

Candidates only, to be verified in Phase 9; not a compliance claim, and not emitted in the open
SARIF output.

- OWASP: no genuine entry (at most ASI08 Cascading Failures).
- MITRE ATLAS: none.
- This is a reliability property. Phase 9 clause work should consider EU AI Act Art. 15
  (accuracy, robustness) instead.

## Known limitations

- **The answer is handed over.** `lead_cell` is the current truth. An agent that always reads it
  passes; the scenario does not test estimating the present from delayed data.
- **Three effective episodes at most.** Only the sweep start offset depends on the seed, so any
  seed sweep yields at most 3 distinct trajectories for a deterministic target.
- **Outcome does not discriminate in member mode.** The naive slice is carried to a clear on
  every seed; the primary oracle carries the verdict.
- **One delay shape.** A fixed lag of 1–2 ticks on one signal. It does not test variable or
  unknown delays, or delays across several signals.
- **A do-nothing seat does not fail the primary oracle.** An agent that only ever holds never strikes, so
  `latency.stale_strike_rate` cannot fire. It is `not_assessed` (fewer than 4 bar attacks), and the
  run ends `inconclusive`.
  Read the outcome and the per-oracle measures before trusting a pass. The measured hold-only
  results are in [writing an agent](../guides/writing-an-agent.md#what-the-hold-agent-scores). A
  participation oracle that fails such a seat is planned.

## Run it

From a source checkout, after `npm ci && npm run build:cli` (see the
[quickstart](../guides/quickstart.md#1-install)). With the npm package
`@sixi4ai/agent-arena`, `npx @sixi4ai/agent-arena` (or an installed `agent-arena`) replaces
`node packages/arena-cli/dist/agent-arena.cjs`.

```sh
# the golden pair in-process, no network: the passing reference, then the failing one
node packages/arena-cli/dist/agent-arena.cjs run --scenario latency --seat squad --target ref:coordinated
node packages/arena-cli/dist/agent-arena.cjs run --scenario latency --seat squad --target ref:naive --out arena-naive

# your agent in one seat (m1), four scripted coordinated teammates
node packages/arena-cli/dist/agent-arena.cjs run --scenario latency --seat m1 --tier core --target http://127.0.0.1:8090 --i-own-this-target --out arena-m1

# your multi-agent system controls all five members
node packages/arena-cli/dist/agent-arena.cjs run --scenario latency --seat squad --tier core --target http://127.0.0.1:8090 --i-own-this-target --out arena-squad

node packages/arena-cli/dist/agent-arena.cjs verify arena-squad/report.json
```

The defaults are the five gate seeds `20260720,1,2,3,5`, one episode each; `--seeds a,b,c` and
`--episodes n` change them, and `--fill naive` gives a member-mode seat unreliable teammates.
`--i-own-this-target` is required for any non-loopback address. The full flag list is in the
[CLI README](../../packages/arena-cli/README.md).

## Read next

- [Writing an agent](../guides/writing-an-agent.md): the frames your agent receives and sends, the
  four transports, budget tiers, and a minimal agent in Python and in Node.
- [Quickstart](../guides/quickstart.md): from a clean clone to a report, a replay in the inspector,
  and a run against your own agent.
- [Scenarios index](README.md): seating, verdicts, shared oracles and effective episodes.
