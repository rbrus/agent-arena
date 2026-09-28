# Contributing

Issues and pull requests are welcome. This file covers how to run what CI runs, what a change
needs before it can merge, how to add a scenario, and one rule that is specific to the Diplomacy
adjudicator.

Contributions are accepted under the Apache License 2.0. By opening a pull request you agree your
contribution is licensed under it.

## Before opening a pull request

Needs Node.js 22+. Run what CI runs:

```bash
npm ci
npm run typecheck
npm test
npm run contracts:tier0
npm run contracts:check
npm run lint:net -w @sixi4ai/agent-arena
node .github/scripts/md-link-check.mjs
```

All of them must pass. CI also builds the CLI bundle and checks that it reproduces the frozen
anchors, builds and tests the replay inspector (`cd frontend && npm ci && npm run verify`), runs
the SARIF self-test and scans the history for secrets. The release gates of the project run in a
separate program repository, not here. If your change touches the engine, the golden-hash tests are part of
`npm test`; they must pass unchanged (see below).

## Ground rules

- **No model in the core.** The engine, the referee, the scenarios, the opponents, the oracles and
  the reports contain no LLM call and no network call. A pull request that adds one will be
  closed. LLM-driven opponents are out of scope for this repository.
- **Determinism.** The engine is a pure function of `(scenario, seed, actions)`: integer maths,
  the seeded PRNG in `wot-engine`, no clock, no I/O, no `Math.random`, no iteration over
  unordered collections in hashed paths.
- **Golden hashes do not move silently.** If a change alters a frozen golden hash, the pull request
  must say why, bump the contract version, and add a `contracts/CHANGELOG.md` entry. A hash that
  moves without explanation is a bug.
- **Contracts first.** Report fields, oracle ids, SARIF rule ids and target-facing schemas live in
  `contracts/`. Change the contract in the same pull request, before the code that uses it.
  Oracle ids are append-only within a major version.
- **Everything a target sends is untrusted.** Validate it at the edge, length-limit it, and render
  it as plain text everywhere, including the replay inspector and SARIF messages.
- **No credentials in output.** No target token or header may reach a report, replay, SARIF file or
  log. Tests check this.
- **Security issues go to [SECURITY.md](SECURITY.md)**, not to a public issue or pull request.

## Adding or changing a scenario

A scenario is not merged until it has all of:

1. A rules doc under `docs/scenarios/`: what it tests, what a failure means, the robust pattern,
   the oracles with exact definitions and severities.
2. An implementation behind the `Scenario` interface (`init(seed)`, `observe(agent)`,
   `act(agent, action)`, `oracles()`).
3. A **golden pair**: a scripted reference agent that passes and one that fails, both with frozen
   replay hashes on a fixed seed. Without a passing reference, the scenario is not fair; without a
   failing one, it is not measuring anything.
4. Oracle ids registered in the contract and the SARIF rule table.
5. A determinism test (re-simulation reproduces the hash chain) and an observation-leakage test.

Adversarial effects that change what an agent believes go into observations only; effects that
change what is true go into the hashed state. Reviewers will check this first.

## The Diplomacy adjudicator: clean-room rule

The Diplomacy adjudicator (`packages/wot-engine/src/diplomacy/`, planned for 0.2.0) is written
**clean-room** from the published rules of Diplomacy and the Diplomacy Adjudicator Test Cases
(DATC) document. The established open-source adjudicators are copyleft (`diplomacy/diplomacy` is
AGPL-3.0, `godip` is GPL-3.0), and this project is Apache-2.0. See
`docs/adr/ADR-002-diplomacy-adjudicator.md`.

If you contribute to that package:

- **Do not have the source of any copyleft Diplomacy adjudicator open while you write code for
  it**, and do not translate, port or paraphrase code from one. Reading their documentation or
  issue discussions for general understanding of the rules is not the problem; working from their
  code is.
- Work from the rules and the DATC document. Cite the DATC case id in tests and in comments where
  a rule decision is subtle.
- Say in your pull request description that you followed this rule. We may ask.
- Acceptance is DATC: every case marked "standard" must pass. Any deliberately non-standard choice
  is listed in the package README with its DATC case id.
- The DATC document is cited, not vendored. Test fixtures encode the cases in this project's own
  format.

If you have worked on a copyleft adjudicator's code recently, please contribute elsewhere in the
repository instead; that is not a judgement about you, it protects the licence of everyone who
uses this project.

## Contact

The maintainer (`rbrus`) reviews issues and pull requests here. There is no email contact:
use an issue for questions, and GitHub private vulnerability reporting (see SECURITY.md) for
anything security-sensitive or for a conduct report you do not want to make in public.

## Reporting a bug

Open an issue with the version, the scenario id, the seed, the command you ran, and the
`report.json` if you can share it. If `agent-arena verify` fails on a report you did not edit,
that is a determinism bug and we want it.

## Conflict of interest

This project is maintained by its author (`rbrus`) together with Sixi AI, which sells a hosted service built on this engine.
Scenario and oracle changes are judged on whether they measure a failure mode correctly and
fairly, not on how any particular tool or agent scores.
