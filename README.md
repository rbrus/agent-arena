# agent-arena

**An evaluation arena for AI agents whose referee runs no model.**

`agent-arena` puts your agent through seeded, adversarial scenarios: scripted opponents and
teammates that lie, partition, delay and learn your habits. It runs them under fixed time, action
and token budgets and reports which deterministic oracles fired.

- **Replayable.** Every episode is a pure function of the seed and the actions your agent sent, so
  every result carries a replay hash that anyone can re-simulate with `agent-arena verify`.
- **No model on our side.** The referee, the opponents and the scoring contain no LLM, so a
  result cannot be contaminated by one.
- **CI-shaped output.** `report.json` and SARIF 2.1.0, for CI and a GitHub Security tab.

## Why this exists

Agents that work with other agents fail in ways a single-turn probe cannot reach: a peer that lies, a partition, a stale observation, an opponent that learns their habits.
A score from a model judge inherits that model's variance and its exposure to the text it is judging, and is hard for anyone else to reproduce.
agent-arena scripts the adversaries and scores each run with deterministic predicates over a hash-committed replay, so anyone can re-simulate a result with `agent-arena verify`.
It reports which oracles fired on which seeds, for a CI job or a GitHub Security tab.
It does not rank models, and a pass certifies nothing: it means these oracles did not fire on these seeds.
The same engine runs a paid hosted service; the conflict-of-interest note below says who maintains it.

Think of it as a **robustness test under adversarial peers and partial observability**, not a
leaderboard. See [Limitations](#limitations).

> **Conflict of interest.** This arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on this same engine. That conflict is stated here, and it
> is the reason scoring is oracle-first and tool-blind. Verdicts are deterministic predicates over
> the replay, identical for every agent and every tool, with no model and no human in the loop.

---

## Status

`0.1.1`, on npm as `@rbrus/agent-arena`: the first published release (the `v0.1.0` tag was never
published). Pre-1.0: contracts, oracle ids and thresholds may still change between minor versions
(see [Limitations](#limitations)). Everything marked **built** below is in this repository and
covered by the release gate.

Release gates, re-run on the contracts 2.12.0 tree (2026-09-27):

- **Phase 7 (open arena): `GATE: OPEN`, 82/82 checks** in the development repository. In this
  repository's layout, `npm run gate` does not evaluate the checks that read private evidence
  documents; this repository's CI runs it on Node 22 and Node 24 (80/80 on both at the first
  public CI run).
- **Phase 8 (Diplomacy): 44/45 checks.** `npm run gate:phase8 -- --full`. The 45th check is a
  second-person review of the map data, which a person has to sign and which is still pending.

| Component | State |
|---|---|
| Deterministic tick engine, fog of war, per-tick replay hash chain | built |
| Grid Tactics + six failure-mode scenarios behind one `Scenario` interface (`packages/arena-scenarios`) | built: `grid_tactics` 1.0.0, the six raids 1.1.0 |
| Per-scenario oracles with severities, `not_assessed` reasons, re-derivation from the record | built |
| Target-facing observation filter (no ground truth reaches the target; 9 leak classes tested) | built |
| Golden pairs with frozen replay hashes in the `edge`, `core` and `frontier` budget tiers (none at `extended`) | built |
| Contracts: `RunSpec`, `EpisodeResult`, `Report`, SARIF mapping, target-facing frames | built (contracts 2.12.0) |
| CLI `run`, `list-scenarios`, `replay`, `verify`, `version`, `serve-reference` (`packages/arena-cli`) | built: the gate command runs in 1.41 s; 4.6 s from a clean clone to a report |
| Target transports: REST, WebSocket, MCP, A2A | built: identical replay hashes, verdicts and SARIF fingerprints on all four (gate criterion 2, 15/15) |
| Report writer (`report.json`) and SARIF 2.1.0 emitter (`packages/arena-report`) | built: every SARIF log the gate produced validates (18/18) |
| `verify`: re-simulate a report and recompute every verdict | built |
| Docker sandbox: one image with the arena server and a reference target (`sandbox/`) | built: `sandbox/verify.sh` checks 5/5 anchors end to end; not part of the gate run |
| Replay inspector (static web page, `frontend/`) | built: loads `report.json` + replay, inert to hostile input, Diplomacy-aware; the 15 bundled samples verify |
| Diplomacy scenario `diplomacy_standard`: clean-room adjudicator, negotiation channel, oracles, reference agents, CLI support | built: 164/164 DATC v3.0 cases; Phase 8 gate 44/45; announced as runnable in 0.2.0 after the map review |
| Hosted mode: `run --hosted`, driven only by a signed run manifest, and `verify --hosted-seal` | built in the CLI for the Sixi Arena runner; the hosted service itself is not public |
| `--spec <run.json>`, `replay --hash`, the SARIF location file `.agent-arena/<scenario>.run.json` | built |
| `@rbrus/agent-arena` on npm | published: 0.1.1 |
| SARIF upload to a GitHub Security tab | built: this repository's `sarif-selftest` workflow uploads the CLI's SARIF, and code scanning lists the tool `@rbrus/agent-arena` |

---

## Five-minute path

Needs Node.js 22+, npm and git. No Docker, no API key and no model. In the Phase 7 gate this path
took 4.6 s from a clean clone to a report (aarch64, Node 24, warm npm cache).

The CLI is on npm as `@rbrus/agent-arena` (bin name `agent-arena`). The steps below use a source
checkout, the form the gate timed, because the reference target script lives in the repository.
The three forms run the same file:

| Installed | Without installing | From a source checkout |
|---|---|---|
| `npm i -g @rbrus/agent-arena`, then `agent-arena <command> …` | `npx @rbrus/agent-arena <command> …` | `node packages/arena-cli/dist/agent-arena.cjs <command> …` |

Without a checkout, `agent-arena serve-reference --port 8080` serves the same reference target.

```sh
git clone https://github.com/rbrus/agent-arena.git
cd agent-arena
npm ci
npm run build:cli
```

Start the included reference target, a scripted squad (no model) served over REST, WebSocket, MCP
and A2A on one loopback port. Run it in **a second terminal**, in the same directory:

```sh
npm run target:reference -- --port 8080
```

Back in the first terminal, run five seeded Byzantine episodes, with the target controlling all
five squad members, and check the report:

```sh
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target http://localhost:8080
node packages/arena-cli/dist/agent-arena.cjs verify arena-report/report.json
```

The defaults are the release-gate run: the `core` tier and the five gate seeds `20260720,1,2,3,5`,
one episode each. The run writes `./arena-report/`:

- `report.json`: per episode, the outcome, final tick, replay hash, budget counters and a verdict
  for every oracle; per run, a summary that counts **effective** episodes (distinct trajectories),
  not just episodes.
- `report.sarif`: one SARIF result per oracle verdict that is not a pass, with rule id
  `<scenario>.<oracle>`. `not_assessed` verdicts are included and marked "This is not a pass."
- `report.run-spec.json`, and per episode a `record.json` (what `verify` re-simulates) and a
  `replay.json` (what the replay inspector opens).

`verify` re-runs every episode from its seed and recorded inputs, recomputes every verdict and
compares the hashes. It exits 0 when everything matches.

**What the five-minute run shows.** The included target is the coordinated reference squad. On the
five gate seeds it fails no oracle, every episode's replay hash matches a frozen anchor
(`anchor: match`), and `report.sarif` holds no results. To see findings without writing code, run
the naive reference in-process:

```sh
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target ref:naive --out arena-naive
```

It exits 1 with `byzantine.off_quorum_position` failing at `error` on 5 of 5 episodes (13 SARIF
results in all).

Next: point `--target` at your own agent (add `--i-own-this-target` for any non-loopback address),
open the report in the replay inspector, and upload the SARIF from CI. The
[quickstart](docs/guides/quickstart.md) walks through each step, and
[writing an agent](docs/guides/writing-an-agent.md) has a minimal agent in Python and in Node.
`--seat m1` evaluates a single agent in one squad seat, with four scripted teammates.

---

## Scenarios

Seven open scenarios, each a deterministic scripted encounter, plus Diplomacy. Each has a **golden
pair**: a reference agent that demonstrates the robust pattern and passes, and a naive one that
fails. The pair is the evidence that the scenario measures something real and that passing is
possible. One page per scenario, with oracle definitions, anchors and known limitations:
[docs/scenarios](docs/scenarios/README.md).

| Scenario | What it tests | The robust pattern that passes | Behavioural oracles |
|---|---|---|---|
| `grid_tactics` | control: 1v1 play under fog of war against a scripted house bot, within budget | plan under partial information; emit a valid frame every tick | `outcome`, `win_rate` (run-level), `token_efficiency` (measure) |
| `hallucinator` | false information in the shared world | act on a reading only when enough teammates saw it | `corroborated_hazard_hit`, `acted_on_uncorroborated` |
| `overfit` | an opponent that learns your policy from your recorded actions | spread targets and timing | `predictability`, `absorbed_share` |
| `byzantine` | a compromised squad member: a corrupted feed and a spoofed broadcast | quorum: act on ≥ ⌈2n/3⌉ agreement; your own feed is one vote | `off_quorum_position`, `followed_minority_claim`, `self_distrust` |
| `deadlock` | greedy acquisition of shared resources | take locks in the published order; never hold one out of order | `out_of_order_acquire`, `held_through_deadlock` |
| `split_brain` | a network partition with a contended write | the minority holds, the primary keeps writing | `minority_write`, `conflict_caused`, `primary_idle` |
| `latency` | acting on delayed observations | act on the current signal, not the stale one | `stale_strike_rate`, `chased_observed_cell` |
| `diplomacy_standard` | negotiating with adversarial peers on the seven-power Diplomacy map | treat other agents' messages as data; keep accepted deals; keep secrets | `injection_followed`, `intent_leak`, `manipulation_followed`, `commitment_broken`, `collusion` |

Every scenario also carries `shared.budget_violation`, `shared.illegal_action_rate` and
`harness.replay_integrity` (a self-check of the arena itself), and each raid carries
`<scenario>.outcome`.

**Seating.** The six raids seat the target in a squad of five, in one of two ways:

- **member mode:** the target controls one seat and four scripted teammates fill the rest;
- **squad mode:** the target controls all five members, the shape of an orchestrator with
  sub-agents.

In member mode, teammates can carry a weak target to a clear, so the verdict rests on the
behavioural oracles about the target's own seat, not on the outcome.

**Diplomacy.** Seven-power Diplomacy on the standard map with a negotiation channel. The target
plays one power; the other six are scripted reference diplomats.

- **Adjudicator:** written clean-room in TypeScript. It passes all 164 cases of the Diplomacy
  Adjudicator Test Cases (DATC) v3.0 with no deviations. The second-person review of the map data
  is pending, and Diplomacy is announced as runnable (0.2.0) only after it.
- **Oracles:** `injection_followed`, `intent_leak`, `manipulation_followed`, `commitment_broken`,
  `collusion` (a flag for human review, assessable only with two independently owned agents at
  the table) and the shared `shared.budget_violation`.
- **Gate timings:** the seven-reference table 3.79 s; the CLI once per power, seven runs each
  followed by `verify`, 26.3 s.
- **Docs:** [docs/scenarios/diplomacy_standard.md](docs/scenarios/diplomacy_standard.md), and for
  anyone whose agent reads other agents' messages,
  [docs/guides/defensive-parsing.md](docs/guides/defensive-parsing.md).

---

## Transports

The CLI is the client; your agent is the server. `--transport` (or the URL scheme) selects the
transport:

| Transport | Reaches |
|---|---|
| `rest` | an HTTP/JSON agent: each observation is POSTed, the action comes back in the response |
| `ws` | a WebSocket agent, one socket per episode |
| `mcp` | an MCP server (streamable HTTP) exposing an `arena_act` tool |
| `a2a` | an Agent-to-Agent agent (URL of its agent card) |

- **One guarded network layer.** Every outbound connection goes through it. Private, link-local
  and metadata addresses are refused unless you opt in (a loopback address you type yourself is a
  logged opt-in). Redirects are refused by default, and credentials are sent only to the origin
  you typed.
- **No stored credentials.** `--auth env:NAME` reads a target's token from an environment
  variable at connect time and removes the variable. The value is never written to a report,
  replay, SARIF file or log.
- **Transport-invariance (gated).** Transport is outside the hashed state. In the Phase 7 gate,
  the same reference over WebSocket, MCP and A2A produced the same replay hashes, verdicts and
  SARIF fingerprints as over REST (criterion 2, 15/15), for both the passing and the failing
  reference. That holds for a deterministic agent that answers inside the soft deadline.

Full flag list, exit codes and security posture: [packages/arena-cli/README.md](packages/arena-cli/README.md).

---

## Budget tiers

Budgets are the only fairness mechanism. The arena never asks which model you run, because it
could not verify the answer; it enforces what the referee can measure. The four tiers are
evaluation classes, not leagues. The values are fixed by the contracts; changing one is a major
version change, because it changes results. `extended` was added in contracts 2.12.0 for agents
whose decisions take tens of seconds; the other three tiers did not change.

| Tier | Soft deadline | Hard deadline | Action-token allowance per seat | Tick cap |
|---|---:|---:|---:|---:|
| `edge` | 800 ms | 1,600 ms | 160 | 120 |
| `core` (default) | 1,500 ms | 3,000 ms | 240 | 120 |
| `frontier` | 3,000 ms | 6,000 ms | 360 | 120 |
| `extended` | 15,000 ms | 30,000 ms | 540 | 120 |

- **`extended` has no frozen anchors.** `verify` re-simulates an `extended` report like any other,
  but no `anchor: match` is claimed for it. A worst-case episode at `extended` is 120 × 30 s = 60 min.
- **Hosted caps (Sixi Arena runner only).** A hosted `extended` run plays exactly one episode, and
  a hosted Diplomacy run plays at most 50. The open CLI keeps the RunSpec limit of 1,000 episodes
  at every tier.

- An action that arrives after the soft deadline still applies and is counted as a soft miss.
- No valid action by the hard deadline means the seat's units hold.
- Three consecutive hard misses forfeit the episode.
- All of these are recorded and judged by `shared.budget_violation`.
- "Tokens" here are the engine's action units. The arena does not see or meter model tokens.

---

## Determinism and replay hashes

- **Pure engine.** It is a pure function of `(scenario version, seed, tier, seats, actions)`:
  integer maths, a seeded PRNG, no I/O, no clock, no model. The tests poison the clock,
  `Math.random` and I/O while an episode and its oracles run.
- **Hash chain.** Each tick's state is hashed and folded into a chain; the final value is the
  episode's replay hash.
- **Belief versus truth.** Adversarial effects that change what an agent *believes* (false
  readings, spoofed claims, partitions, delays) exist only in observations and never enter the
  hashed state. Effects that change what is *true* are hashed.
- **Verdicts from the record.** `verify` recomputes every verdict from the episode record. The
  ones that depend on wall-clock timing are marked `attested` rather than `resim`.
- **Regression-tested.** The golden pairs are tested against frozen hashes on every engine
  change.

What the hash proves: this recorded episode happened under these rules. What it does not prove:
that your agent will send the same actions next time, or on its own which seed was used. Read a
hash together with the seed, tier and scenario version recorded next to it.

---

## What this is not

- **Not a benchmark of models.** It evaluates agent *systems* (prompts, tools, memory,
  coordination logic, error handling) through the actions they send. The model is one component.
  There is no leaderboard.
- **Not a game.** It grew out of an earlier game prototype, and the game layer was removed. The
  scenarios are small grid worlds because that makes failure modes exact and replayable, not
  because they are fun.
- **Not a certification.** A passing run means the listed oracles did not fire on the listed
  seeds. Nothing in this repository says an agent is safe, certified or compliant with anything.

---

## Limitations

Read this before quoting a result.

- **Scripted opponents only.** Every opponent and teammate in the open core is a deterministic
  script. Passing against scripts does not predict behaviour against an adaptive adversary.
- **Three scenarios hand the agent the answer.** `deadlock` gives the next lock rank, `split_brain`
  says whether you are primary, and `latency` gives the current cell next to the stale one. As
  shipped, they test whether an agent follows a correct signal against a greedy incentive, not
  whether it can work the signal out. Variants that withhold it are planned for a later pack.
- **A do-nothing agent is not failed everywhere.** An agent that only ever holds fails
  `byzantine`, `hallucinator` and `overfit` at `error`, but it cannot acquire, write or strike, so
  the primary oracles of `deadlock`, `split_brain` and `latency` do not fire. In squad mode those
  runs end `inconclusive` (the squad is wiped); in `split_brain` member mode the scripted teammates
  clear and the run verdict is `pass`. The measured table is in
  [writing an agent](docs/guides/writing-an-agent.md#what-the-hold-agent-scores). A participation
  oracle that fails such a seat is planned.
- **Some scenarios ignore the seed.** `overfit` and `deadlock` produce **one** effective episode
  per tier for a deterministic agent, however many you run, and `latency` at most three. The
  report counts effective episodes and never presents repeats as independent samples.
- **The references have known gaps.** Each scenario page lists them. In particular:
  - in squad mode, `byzantine.followed_minority_claim` does not separate the pair (the naive squad
    passes it); the squad verdict rests on the primary oracle and `self_distrust`;
  - the Deadlock pass reference is a wrapper (`lockOrderDiscipline`) around the engine's own
    ordered-lock policy, which by itself fails both Deadlock oracles in squad mode;
  - a reference served over the network only approximates member seating, so a served
    member-mode run need not reproduce the frozen member-mode anchors. The release gate compares
    served runs with the anchors in squad mode.
- **The referee is reproducible; your agent may not be.** An LLM-backed agent at non-zero
  temperature will usually send different actions on the same seed and so produce a different
  hash. Run several seeds and episodes, and report the distribution, not the best run.
- **Timing enters the result.** Deadline misses change the action sequence. A target that is fast
  on localhost and slow over a network can score differently in the same tier.
- **Token budgets cover only what the referee can see.** The arena cannot measure the tokens your
  model spends internally.
- **Abstractions, not your deployment.** The scenarios test coordination discipline under a
  failure mode in a grid world, and negotiation hygiene at a Diplomacy table. They do not test
  your tools, your data, or prompt injection against your real deployment. See agent-probe and
  the other tools below for that.
- **Oracles can miss, and can be `not_assessed`.** An oracle is a predicate over recorded events,
  and an agent can pass one on some seeds by chance. When a precondition never occurs, the verdict
  is `not_assessed`, which is never a pass.
- **Pre-1.0.** Contracts, oracle ids and thresholds may change between minor versions until 1.0.
  Every threshold change bumps the scenario version and is listed in `contracts/CHANGELOG.md`.
- **Authorized testing only.** Point the arena at agents you own or are authorized in writing to
  test.

---

## Related projects

- **[agent-probe](https://github.com/rbrus/agent-probe)**: a single-turn baseline scanner for
  prompt injection, system-prompt disclosure and tool abuse. A smoke test for one agent;
  agent-arena tests behaviour over many turns against adversarial peers.
- **[redwire](https://github.com/rbrus/redwire)**: one send interface across REST, MCP, A2A,
  WebSocket and browser CDP. agent-arena's transport adapters follow its design.
- **[agent-redteam-benchmark](https://github.com/rbrus/agent-redteam-benchmark)**: compares
  red-teaming tools against one real agent, scored by deterministic oracles and a tool-blind
  judge. Same scoring discipline; different subject (tools there, agents here).
- **Sixi Arena** (commercial, Sixi AI; planned): hosted runs of this same engine build, closed
  scenario packs mapped to published control frameworks, and LLM-driven adaptive opponents. The
  open core does not depend on it. The hosted runner is this CLI's `run --hosted` mode, and a
  hosted run must reproduce the hashes the open CLI produces for the same seeds and actions.

---

## Read next

- [docs/index.md](docs/index.md): every page, and what is built and what is planned.
- [Quickstart](docs/guides/quickstart.md): install, run Byzantine against the bundled reference,
  open the report in the replay inspector, run against your own agent, read the SARIF in GitHub.
- [Writing an agent](docs/guides/writing-an-agent.md): the frames your agent receives and sends,
  the four transports, budget tiers, what the oracles look for, and a minimal agent in Python and
  in Node.
- [CI integration](docs/guides/ci-integration.md): a GitHub Actions job for your own endpoint,
  with `verify` and SARIF upload.
- [FAQ](docs/guides/faq.md): what a pass means, `not_assessed`, the conflict of interest, and what
  Sixi Arena adds.
- [Scenarios](docs/scenarios/README.md) and [defensive parsing](docs/guides/defensive-parsing.md).
- [CLI reference](packages/arena-cli/README.md) and the [Docker sandbox](sandbox/README.md).

---

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): how to run what CI runs, how to add a scenario, and the
  clean-room rule for the Diplomacy adjudicator.
- [SECURITY.md](SECURITY.md): report vulnerabilities privately; do not open a public issue.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- This project is maintained by its author (`rbrus`) together with Sixi AI, which sells a hosted
  service built on this engine.
- Contact: the maintainer (`rbrus`), through issues and pull requests on this repository, or
  GitHub private vulnerability reporting for anything sensitive. There is no email contact.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions are accepted under
the same licence.

> **Authorized testing only.** Point `agent-arena` at systems you own or have explicit written
> permission to test.
