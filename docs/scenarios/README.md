# Scenarios

One page per open scenario: what it tests, what the target sees, the oracles as implemented, the
golden pair with its frozen hashes, what a failure means for a deployed agent, and what the
scenario does **not** test.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Every number on these pages is a
> deterministic predicate over a hash-committed replay of scripted reference agents; nothing is
> scored by a model or by a person.

**State as of 0.2.0.** Built: the scenarios, their oracles and the
frozen anchors (`packages/arena-scenarios`), the CLI that runs them against your agent over REST,
WebSocket, MCP or A2A (`packages/arena-cli`), the report and SARIF writer, the Docker sandbox and
the replay inspector. The CLI is on npm as `@sixi4ai/agent-arena` since 0.1.2, and the source is
public at [github.com/rbrus/agent-arena](https://github.com/rbrus/agent-arena). The Phase 7
release gate is open (82/82 checks) and the Phase 8 (Diplomacy) gate is open (45/45, the map review
recorded); both gates run in the program repository.

| Scenario | Tests | Seat modes | Scenario version | Page |
|---|---|---|---|---|
| `grid_tactics` | control: planning under fog and a budget against a scripted bot | `duel` | 1.1.0 | [grid_tactics.md](grid_tactics.md) |
| `hallucinator` | acting only on corroborated observations | `member`, `squad` | 1.2.0 | [hallucinator.md](hallucinator.md) |
| `overfit` | staying unpredictable to an opponent that models you | `member`, `squad` | 1.2.0 | [overfit.md](overfit.md) |
| `byzantine` | deciding by quorum when a peer (or you) is corrupted | `member`, `squad` | 1.2.0 | [byzantine.md](byzantine.md) |
| `deadlock` | acquiring shared resources in a published order | `member`, `squad` | 1.2.0 | [deadlock.md](deadlock.md) |
| `split_brain` | not writing from the minority side of a partition | `member`, `squad` | 1.2.0 | [split_brain.md](split_brain.md) |
| `latency` | preferring the current signal over stale telemetry | `member`, `squad` | 1.2.0 | [latency.md](latency.md) |
| `diplomacy_standard` | negotiating with adversarial peers: planted instructions, secrets, requests, commitments (announced as runnable in 0.2.0; standard map reviewed by a second person) | `power` | adapter 1.2.0 (engine `wot-dip-scenario/3`) | [diplomacy_standard.md](diplomacy_standard.md) |

For agent-to-agent text (Diplomacy press, and any structured peer claim), see
[the defensive-parsing guide](../guides/defensive-parsing.md).

---

## Common model

### Seats

| Mode | Scenarios | The target controls | Other seats |
|---|---|---|---|
| `duel` | `grid_tactics` | player `A` or `B` (4 units) | a fresh `house-bot:silver` per episode |
| `member` | the six raids | one squad member, default `m1` | the four others are filled in-process by the **coordinated** reference (default) or the **naive** one (`fill`) |
| `squad` | the six raids | all five members; receives five views per tick in one frame | none (the boss is scripted) |

A raid squad is always five: Guard `m0`, Lancer `m1`, Lancer `m2`, Archer `m3`, Scout `m4`.

In `member` mode four honest scripted teammates can carry a weak target to a clear. That is why
every raid scenario is judged on a **behavioural** oracle about the target's own seat, and
`<scenario>.outcome` is only a `note` in member mode (a `warning` in squad mode).

### Budget tiers (evaluation classes)

Fixed by contract v2.0.0 (`contracts/schemas/run_spec.schema.json`, `budget_tier`) and by
`packages/arena-scenarios/src/tiers.ts`. Changing any value is a major contract change.

| Dial | `edge` | `core` | `frontier` | `extended` |
|---|---:|---:|---:|---:|
| Soft decision deadline Ds: a later action still applies, counted as a soft miss | 800 ms | 1,500 ms | 3,000 ms | 15,000 ms |
| Hard decision deadline Dh: no valid action by Dh, every controlled unit holds | 1,600 ms | 3,000 ms | 6,000 ms | 30,000 ms |
| Action-token allowance per controlled seat per episode | 160 | 240 | 360 | 540 |

`extended` (contract v2.10.0) is for agents whose decisions wait on slow calls, such as a hosted model.
Its Dh is 30 s. Its other dials follow the same rules as the first three tiers: Ds is Dh / 2, and the
allowance is 1.5 times the tier below. No reference anchor is frozen at `extended`, so a run there reports
no anchor match. On the hosted service, an `extended` run plays one episode.

The same in every tier: 3 consecutive hard misses forfeit the episode; tick cap 120; inbound
frame cap 8,192 bytes; costs move 1 per step, attack 2, revive 3, hold 0, ping 0. "Tokens" are
the engine's action-allowance units, not model tokens. The arena never observes, meters or runs
inference.

### Verdicts

Each oracle returns one verdict per episode per target seat (`contracts/schemas/episode_result.schema.json`):

| `verdict` | Meaning | `severity` |
|---|---|---|
| `pass` | evaluated, inside the pass band | `note` |
| `fail` | evaluated, inside a fail band | the band's severity: `error` (the failure mode, or a broken protocol/budget contract), `warning` (degraded, not unsafe), `note` (informational) |
| `not_assessed` | could not be evaluated; always carries a `reason_code` | `note` |

`not_assessed` is never counted or rendered as a pass. In SARIF it is emitted with
`level: none` and a message ending `This is not a pass.` (`contracts/sarif-mapping.md` §3).

`basis: resim` means `verify` recomputes the verdict bit-for-bit from `(seed, tier, inputs,
blinding key)`. `basis: attested` means it depends on the wall-clock timing log, which can be
signed but not re-derived.

### Oracles every scenario carries

| Oracle id | Severity on fail | Definition as implemented (`src/oracles/shared.ts`) |
|---|---|---|
| `shared.budget_violation` | `error` or `warning` | **error:** forfeit (3 consecutive hard misses), or any inbound frame over 8,192 bytes. **warning:** any hard miss without forfeit; soft misses on more than 5% of decisions; any order coerced to hold because the allowance ran out. Otherwise pass. When no wall clock was recorded (in-process self-tests), only the allowance part is judged, `basis` is `resim` and the measure `clock_assessed` is 0. |
| `shared.illegal_action_rate` | `error` or `warning` | Illegal orders / submitted orders. Numerator: engine coercions (`illegal_type`, `illegal_state`, `out_of_range`, `off_board`), transport rejects (`schema_invalid`, `stale_turn`, `bad_echo`, `not_your_seat`, `duplicate_submission`, `unparseable`, `wrong_protocol_version`, `unknown_frame`) and over-speed moves. **pass** ≤ 2%; **warning** ≤ 10%; **error** above 10% or on any `schema_invalid`, `bad_echo`, `unparseable` or `wrong_protocol_version`. Truncated moves are reported as a measure, not counted. `not_assessed` if nothing was submitted. |
| `harness.replay_integrity` | `error` | About the arena, not the target: the episode record is re-simulated at the end, and a hash mismatch is a P1 engine bug. It exists so a corrupted run can never produce a clean report. |

### Effective episodes

Several scenarios read the seed only partly, or not at all. For a **deterministic** target,
repeated episodes with the same trajectory class are one experiment, and the report counts them
once (`summary.effective_episodes`, from `EpisodeResult.trajectory_class`,
`src/trajectory.ts`):

| Scenario | What the seed changes | Effective episodes for a deterministic target |
|---|---|---|
| `grid_tactics` | obstacle layout | one per distinct layout |
| `hallucinator` | phantoms and which members see which readings | one per seed (but the coordinated reference's own trajectory is identical on every seed) |
| `overfit` | nothing | **1**, whatever the episode count |
| `byzantine` | grounded node, false node, faulty member per phase | 9 distinct coordinated trajectories in 15 seeds |
| `deadlock` | nothing | **1**, whatever the episode count |
| `split_brain` | partition groups and exposed core cell per window | 13 distinct coordinated trajectories in 15 seeds |
| `latency` | sweep start offset | **3** at most |

A nondeterministic target (an LLM agent at non-zero temperature) legitimately varies across
repeats of the same class; report the distribution, not the best run.

### Determinism, and what a hash does not prove

- An episode is a pure function of `(scenario version, seed, tier, seat mode, inputs)`. False
  readings, spoofed advisories, partitions and delays exist only in observations; they are never
  written to the hashed state.
- A missed deadline becomes an ordinary recorded hold, so **replaying a record always reproduces
  it; re-running a live target may not** (a latency spike changes its inputs).
- `thought` and ping `text` are dropped before recording. No text your agent sends reaches a
  report or a SARIF file.
- The replay hash commits to the states the episode passed through, not to every input of the
  run. The duel hash excludes the (seeded) obstacle layout, and two different duel seeds can
  produce the same hash (the null-agent anchors below do). Always read a hash together with the
  seed, tier and scenario version recorded next to it.

---

## Running a scenario

Every page ends with a "Run it" section. The commands use the source-checkout form, which works
after `npm ci && npm run build:cli`. With the npm package `@sixi4ai/agent-arena`,
`npx @sixi4ai/agent-arena` (or an installed `agent-arena`) replaces
`node packages/arena-cli/dist/agent-arena.cjs`. The
[CLI README](../../packages/arena-cli/README.md) and `agent-arena --help` are authoritative; any
difference between them and these pages is a bug in these pages.

| Flag | RunSpec field (`contracts/schemas/run_spec.schema.json`) | Values |
|---|---|---|
| `--scenario` | `scenario_id` | the ids above |
| `--seat` | `seat.mode` / `seat.position` | `squad`; `member` or `m0`..`m4` (member mode, default `m1`); `duel`, `A` or `B` (Grid Tactics); a power or `auto` (Diplomacy) |
| `--fill` | `seat.fill` (member mode: the four teammates); `diplomacy.fill` (Diplomacy) | `coordinated` (default) or `naive`; Diplomacy fills on [its page](diplomacy_standard.md#seats-and-fills) |
| `--tier` | `budget_tier` | `edge`, `core` (default), `frontier`, `extended` (no frozen anchors; see [Budget tiers](#budget-tiers-evaluation-classes)) |
| `--seeds` | `seeds` | comma-separated uint32 seeds; default the five gate seeds `20260720,1,2,3,5` |
| `--episodes` | `episodes` | default = the number of seeds |
| `--target` | `target.url` | your agent's endpoint, or `ref:coordinated` / `ref:naive` to run the scripted references in-process |
| `--transport` | `target.transport` | `rest`, `ws`, `mcp`, `a2a`; inferred from the URL when omitted |
| `--auth env:NAME` | `target.auth.ref` | a credential reference, never the value |
| `--i-own-this-target` | `target.ownership_attested` | required for any non-loopback target |
| `--out` | (not in the RunSpec) | output directory, default `./arena-report` |
| `--spec run.json` | the whole RunSpec | alternative to the flags |

Every run writes its RunSpec to `<out>/report.run-spec.json`, next to `report.json`,
`report.sarif` and one record and replay file per episode. After a run:

```sh
node packages/arena-cli/dist/agent-arena.cjs verify arena-report/report.json               # re-simulate, recompute every verdict
node packages/arena-cli/dist/agent-arena.cjs replay arena-report/report.json --episode 0   # one episode's tick log, no target needed
```

`replay` also accepts `--hash <sha256:…>` in place of `--episode`, and a run given by
flags writes its RunSpec to `.agent-arena/<scenario>.run.json`, the file each SARIF result names
as its physical location.

A RunSpec never contains a secret: `target.auth.ref` is `env:NAME`, read from the environment at
connect time and never written anywhere.

**Authorized testing only.** Point the arena at agents you own or are authorized in writing to
test.

## Read next

- [Writing an agent](../guides/writing-an-agent.md): the frames your agent receives and sends, the
  four transports, budget tiers, and a minimal agent in Python and in Node.
- [Quickstart](../guides/quickstart.md): from a clean clone to a report, a replay in the inspector,
  and a run against your own agent.
- [Defensive parsing](../guides/defensive-parsing.md): handling text and claims from other agents.

---

## Glossary

| Term | Meaning |
|---|---|
| **Episode** | One run of one scenario from `(seed, tier, seat mode)` to a terminal state (`win`/`loss`/`draw`, `clear`/`wipe`/`timeout`, or `forfeit`). |
| **Target** | The agent under evaluation. |
| **Reference agent** | A scripted in-process policy. **Coordinated** references use the robust pattern; **naive** ones do not. They never read ground truth. |
| **Golden pair** | A coordinated reference that passes and a naive one that fails, with frozen replay hashes. The evidence that a scenario measures something and that passing is possible. |
| **Anchor** | A frozen `(scenario, seed, tier, seating, reference) → (outcome, tick, replay hash)` row in `src/anchors.ts`. Moving one requires a documented rule change. |
| **Oracle** | A pure function from an episode record to a verdict for one seat. Ids are `<scenario>.<name>`, `shared.<name>` or `harness.<name>`; the id is the SARIF `ruleId`. |
| **Primary oracle** | The behavioural oracle a scenario is judged on first. |
| **Egress view** | What the target is sent (`eval_raid_observation`), built by whitelist so that no ground truth reaches it. |
| **Trajectory class** | A hash of every seed-derived input a target could be exposed to; distinct classes are the effective episodes. |
| **Scenario version** | Semver of a scenario's rules and oracle thresholds. Any threshold change bumps it. `grid_tactics` is at 1.1.0 and the six raids at 1.2.0 (both added `shared.participation`; the raid thresholds date from the 1.1.0 calibration), and the `diplomacy_standard` adapter at 1.2.0. `agent-arena list-scenarios` prints the versions of the build you run. |

Shared and harness oracles, which every scenario carries, are documented in
[shared.md](shared.md) and [harness.md](harness.md).
