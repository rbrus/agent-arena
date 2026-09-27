# Shared oracles

These oracles run in every scenario and seating. Their rule ids are `shared.<name>`; the SARIF
`help_uri` for each points at the matching heading below. Thresholds are the ones the committed
code applies (`ascension/packages/arena-scenarios/src/oracles/shared.ts`); the definitions are
normative in `contracts/sarif-mapping.md` §2.

## budget_violation

Basis `attested` (the runner's own clock and counters, not re-simulated). Fails at `warning` when
the target's soft-deadline miss rate exceeds 5 % of its decisions, and at `error` on a forfeit:
three consecutive hard-deadline misses. In Diplomacy the counters are missed orders deadlines and
counted press rejects (`warning`; `error` on forfeit). `verify` carries the runner's counters over
without re-deriving them, because no clock runs during a re-simulation.

## illegal_action_rate

Basis `resim`. The share of submitted actions the engine refused or coerced (schema-invalid,
over-speed, out-of-turn, transport rejects). Pass at or below 2 %, `warning` up to 10 %, `error`
above. An agent that keeps sending illegal frames is also rate-limited and eventually closed by
the transport, which shows up here as transport rejects.

## participation

Basis `resim`, severity `error`, reason code `no_participation`. A target seat that issues no
non-trivial action over the episode fails. Non-trivial means: in raids, a move of at least one
step, an attack, a revive or a ping; in the duel, any unit order other than hold; holds, zero-step
moves, omitted units and the hold the runner fills in on a missed deadline do not count. In squad
seating the five members are pooled, so one action by any member passes. Only ticks on which the
seat had a unit able to act are counted; a seat that never had one is `not_assessed` with reason
`never_actable` (never produced by the open scenarios). Evidence is the first and last actable
tick. Known weakness: a ping costs nothing, so an agent that pings every tick passes; the
threshold is one action because the lowest honest count among the coordinated references is four.

This oracle exists because a hold-only agent could otherwise reach `pass` in `split_brain`
member seating, where the scripted teammates clear the encounter. See
[writing-an-agent](../guides/writing-an-agent.md#what-the-hold-agent-scores).

Scenario versions that carry it: raids 1.2.0, `grid_tactics` 1.1.0. Diplomacy has no
participation oracle yet; an all-hold, no-press power is caught only by the deadline counters.
A `diplomacy_standard.participation` rule is reserved in contracts 2.8.0.
