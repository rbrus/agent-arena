# FAQ

Short answers, with links to where the detail lives. "Built" means it is in the committed code
in the source tree as of 2026-09-26; "planned" means it is not.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Verdicts are computed by
> deterministic, published oracles over hash-committed replays; scoring is oracle-first and
> tool-blind.

## Is this a benchmark of models?

No. It evaluates an agent **system** (prompts, tools, memory, coordination logic, error handling)
through the actions it sends back. The model is one component of that system, and the arena never
learns which one you use: it does not ask, because it could not verify the answer. There is no
leaderboard.

What it enforces instead is what the referee can measure: decision deadlines and an action
allowance per budget tier (`edge`, `core`, `frontier`). "Tokens" in the reports are the engine's
action units, not model tokens. See [writing-an-agent.md](writing-an-agent.md#budgets-and-tiers).

## Does the referee run a model?

No. The engine, the scripted opponents and teammates, the oracles, the report writer and the
SARIF emitter contain no LLM call and no network call. The engine is integer maths and a seeded
PRNG; its tests poison the clock, `Math.random` and I/O while an episode and its oracles run.
The CLI's `lint:net` check fails the build if any network or process primitive appears outside
its one guarded network layer (`packages/arena-cli/src/net/`).

That includes the Diplomacy scenario: the six other powers are scripted reference agents, and the
negotiation oracles are predicates over the recorded messages, orders and commitments.

## Why deterministic replay hashes?

So that anyone can check a result without trusting us.

- An episode is a pure function of the scenario version, seed, tier, seating and the actions your
  agent sent. Each tick's state is hashed into a chain; the final value is the episode's
  `replay_hash`.
- `agent-arena verify report.json` re-simulates every episode from the record, recomputes every
  verdict and compares. An edited report fails.
- The same property makes CI useful: the same behaviour on the same seed gives the same hash and
  the same SARIF fingerprint, so an alert stays one alert across runs. A behaviour change gives a
  new hash.
- The scripted references are regression-tested against frozen hashes (anchors) on every engine
  change, and a deterministic agent produces identical hashes over REST, WebSocket, MCP and A2A
  (Phase 7 gate criterion 2).

What a hash does **not** prove: that your agent will send the same actions next time, or, on its
own, which seed was used. An LLM agent at non-zero temperature usually produces a different hash
on the same seed, and a late answer changes the recorded inputs. Read a hash together with the
seed, tier and scenario version next to it, and run several seeds.

## What does "not assessed" mean?

The oracle could not be evaluated on that episode, and the verdict says why in a `reason_code`.
Examples:

| `reason_code` | Meaning |
|---|---|
| `precondition_not_reached` | the situation the oracle judges never happened, e.g. your seat was never the faulty member in `byzantine` |
| `insufficient_samples` | too few assessable ticks, e.g. an agent that never strikes in `latency` |
| `episode_aborted` | the episode did not complete |

`not_assessed` is **never** a pass. It is never counted in a pass total, the report lists every
one under `not_assessed`, and in SARIF it is a result whose message ends `This is not a pass.`
A run can only have `summary.verdict: pass` if nothing is `not_assessed` except by catalog design
(the oracle cannot apply to that scenario, seat or tier).

## What does a passing run mean?

That these oracles did not fire on these seeds, in this tier and seating, against scripted
opponents. Nothing more. It is not a certification, and nothing in this project says an agent is
safe or compliant with anything.

A concrete reason for care: an agent that only ever answers "hold" passes the primary oracle of
`deadlock`, `split_brain` and `latency`, because it never acquires, writes or strikes, and in
`split_brain` member mode its run verdict is `pass` because four scripted teammates clear the
encounter. The measured table is in
[writing-an-agent.md](writing-an-agent.md#what-the-hold-agent-scores). Read the outcome, the
`not_assessed` list and the per-oracle measures, and run both squad and member mode. Each
[scenario page](../scenarios/README.md) lists what the scenario does not test.

## Is there a conflict of interest?

Yes. agent-arena is maintained by Sixi AI, which sells sixi-scanner and plans a hosted service
(Sixi Arena) on this same engine. The arena could be used to score a Sixi tool. That is why:

- every verdict is a published, deterministic predicate over a hash-committed replay, identical
  for every agent and every tool, with no model and no human in the loop;
- every report carries the conflict-of-interest sentence in its `disclosure` block, and `verify`
  checks that it was not altered;
- scenario and oracle changes go through contracts and a changelog, with golden references that
  pass and fail, so a threshold cannot move quietly.

Any comparison we publish carries the same notice and links the reports and replays behind it.

## How do I report a security issue?

Privately, through GitHub: **Security → Report a vulnerability** on the repository. Please do not
open a public issue, discussion or pull request. What is in scope (credential leaks, SSRF, report
integrity, untrusted target content, determinism breaks, observation leakage, the sandbox) and the
response targets are in [SECURITY.md](../../SECURITY.md). Issues in the hosted Sixi Arena service
go to Sixi AI, not to this repository.

## What is the licence?

Apache License 2.0; see [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE). Contributions are
accepted under the same licence. The Diplomacy adjudicator is written clean-room from the rules and
the DATC test cases, because the established open-source adjudicators are copyleft; if you
contribute to it, read the clean-room rule in [CONTRIBUTING.md](../../CONTRIBUTING.md) first.

## What does Sixi Arena add?

Sixi Arena is a commercial hosted service from Sixi AI. **It is planned and not available.** The
open core does not depend on it: every scenario, oracle, transport and the replay inspector are in
this repository.

What it is designed to add:

| | Open core (this repository) | Sixi Arena (planned) |
|---|---|---|
| Where runs execute | your machine or your CI | Sixi's infrastructure, one short-lived container per run, from the same image pinned by digest |
| Engine | this engine | the same engine build; a hosted run must reproduce the hashes the open CLI produces for the same seeds and actions |
| Evidence | `report.json` + SARIF, re-simulated by `verify` | the same files, signed (Ed25519 seal and DSSE envelopes) with a signed run manifest |
| Target ownership | self-attested (`--i-own-this-target`) | verified by Sixi before a run |
| Scenarios | the eight open scenarios | also closed scenario packs mapped to clauses of published control frameworks |

What already exists in the open code for it: the runner mode it will use (`run --hosted`, refused
outside a signed manifest), `verify --key` to check a sealed report, and `verify --hosted-seal` for
a hosted bundle, all documented in the [CLI README](../../packages/arena-cli/README.md#hosted-mode-sixi-arena-runner-only).
A mapping from a scenario to a framework clause is a statement about what a scenario exercises. It
is not a compliance claim, and the open SARIF output emits none.

## Where do I start?

- [Quickstart](quickstart.md): a report and a replay in about five minutes.
- [Writing an agent](writing-an-agent.md): frames, transports, budgets, oracles.
- [CI integration](ci-integration.md).
- [Scenarios](../scenarios/README.md).
