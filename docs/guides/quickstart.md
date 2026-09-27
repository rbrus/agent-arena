# Quickstart: the five-minute first run

This page takes you from a clean clone to a report, a replay you can scrub tick by tick, a run
against an agent of your own, and SARIF findings in a GitHub Security tab. Every command below was
run against the committed CLI in the source tree on 2026-09-26.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Verdicts are computed by
> deterministic, published oracles over hash-committed replays; scoring is oracle-first and
> tool-blind.

**Authorized testing only.** Point the arena at agents you own or are authorized in writing to test.

## What you need

- Node.js 22 or later, npm, git.
- Python 3.9+ **or** nothing extra for step 4 (the example agent exists in Python and in Node).
- A GitHub account for step 5 only.

No Docker, no API key and no model are needed. The engine runs inside the CLI.

## How long it takes

From the Phase 7 gate evidence (`GATE: OPEN`, 2026-09-26, aarch64, Node 24, warm npm cache):

| Step | Wall-clock |
|---|---:|
| clone | 0.2 s |
| `npm ci` | 2.0 s |
| reference target up | 1.0 s |
| the gate command: 5 Byzantine episodes over REST, report written | 1.5 s |
| **clean clone to report** | **4.6 s** |

The gate command alone measured 1.41 s. A cold npm cache adds download time. The gate measured the
TypeScript entry point; this page builds the single-file CLI bundle first (`npm run build:cli`),
which the gate did not time. The replay inspector in step 3 has its own `npm ci`.

## About `npx @rbrus/agent-arena`

The CLI is on npm as `@rbrus/agent-arena` (bin name `agent-arena`), from 0.1.1. The three forms
run the same file:

| Installed | Without installing | From a source checkout |
|---|---|---|
| `npm i -g @rbrus/agent-arena`, then `agent-arena <command> …` | `npx @rbrus/agent-arena <command> …` | `node packages/arena-cli/dist/agent-arena.cjs <command> …` |

This page uses the source-checkout form so that every line runs as
written. In a source checkout, `npx @rbrus/agent-arena` does not find the bundle even after
`npm run build:cli`, because `npm ci` links the bin before the bundle exists.

## 1. Install

```sh
git clone https://github.com/rbrus/agent-arena.git
cd agent-arena
npm ci
npm run build:cli
node packages/arena-cli/dist/agent-arena.cjs version
```

`version` prints `0.1.1`. `list-scenarios` shows the eight scenarios with their
oracles and reference pairs:

```sh
node packages/arena-cli/dist/agent-arena.cjs list-scenarios
```

## 2. Run Byzantine against the bundled reference

The reference target is a scripted squad (no model) that the CLI can serve over REST, WebSocket,
MCP and A2A on one loopback port. Start it in **a second terminal**, in the same directory:

```sh
npm run target:reference -- --port 8080
```

It prints its four URLs and `/healthz`. Back in the first terminal:

```sh
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target http://localhost:8080
```

The defaults are the release-gate run: the `core` tier and the five gate seeds
`20260720,1,2,3,5`, one episode each. The output ends like this:

```text
episode 0 seed 20260720 squad: clear at tick 38  sha256:e533088162409df5…  anchor: match (byzantine core seed 20260720 squad coordinated)
…
episode 4 seed 5 squad: clear at tick 52  sha256:960d8eef99ff19d9…  anchor: match (byzantine core seed 5 squad coordinated (gate))
verdict: pass  (5/5 episodes, 5 distinct trajectories, 5 within budget)
report: …/arena-report/report.json
sarif:  …/arena-report/report.sarif
exit 0 (no findings); verify with: agent-arena verify …/arena-report/report.json
```

`anchor: match` means the episode's replay hash equals a frozen golden anchor in
`packages/arena-scenarios/src/anchors.ts`. On these five seeds the coordinated reference squad
fails no oracle, so `report.sarif` holds no results. That is expected; step 5 shows how to get
findings.

Files in `./arena-report/`:

| File | What it is |
|---|---|
| `report.json` | per episode: outcome, terminal tick, replay hash, budget counters, one verdict per oracle; per run: summary, `effective_episodes`, `not_assessed`, disclosure |
| `report.sarif` | one SARIF 2.1.0 result per verdict that is not a pass |
| `report.run-spec.json` | the RunSpec (credential references only, never values) |
| `report.episode-<n>.record.json` | what `verify` re-simulates |
| `report.episode-<n>.replay.json` | the replay-inspector file |

Check the report was not edited after the fact:

```sh
node packages/arena-cli/dist/agent-arena.cjs verify arena-report/report.json
```

`verify` re-simulates every episode from its seed and recorded inputs, recomputes every verdict
and compares. It ends `verified: every episode re-simulated to the reported hashes and verdicts
(exit 0)`. Print one episode's tick log (no target needed):

```sh
node packages/arena-cli/dist/agent-arena.cjs replay arena-report/report.json --episode 0
```

To see a failing run without writing any code, run the naive reference in-process:

```sh
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target ref:naive --out arena-naive
```

It exits 1 with `byzantine.off_quorum_position` failing at `error` on 5 of 5 episodes.

## 3. Open the report in the replay inspector

The inspector is a static page in `frontend/`. It reads files locally through the browser's file
picker and fetches nothing except its own bundled samples.

```sh
cd frontend
npm ci
npm run dev
```

Open the URL Vite prints (by default `http://localhost:5173/`). Then either:

- pick a bundled sample from the **sample** list and load it. There is a coordinated and a naive
  sample for each raid scenario, two Grid Tactics samples and one Diplomacy sample. A sample can
  also be opened by URL, for example `http://localhost:5173/#sample=byzantine-core-20260720-naive`;
- or use the file picker to load your own `arena-report/report.json` together with one
  `report.episode-<n>.replay.json` (up to four files at once).

The inspector shows the run metadata, the episode table, every verdict with its measures, and a
tick scrubber with per-member observations and actions. It re-checks the replay's hash chain in
the browser. The bundled samples are regenerated by the CLI itself and all verify:

```sh
npm run samples -- --verify
```

That check took about a minute on the machine these docs were written on. Return to the
repository root with `cd ..`.

## 4. Run against your own agent over REST

Stop the reference target (Ctrl-C in the second terminal). Save the minimal agent from
[writing-an-agent.md](writing-an-agent.md#a-minimal-rest-agent) as `hold_agent.py` (or
`hold-agent.mjs`) and start it in the second terminal:

```sh
python3 hold_agent.py
```

or

```sh
node hold-agent.mjs
```

It listens on `127.0.0.1:8090` and answers every decision with a legal "hold". Run the same
scenario against it:

```sh
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target http://127.0.0.1:8090 --i-own-this-target --out arena-mine
```

The run completes, and it fails: `byzantine.off_quorum_position` and `byzantine.self_distrust` at
`error` on 5 of 5 episodes, every episode a wipe, exit 1. Holding still is not a strategy. That is
the point of the step: the pipeline works end to end with your own endpoint, and the report tells
you what the agent did not do.

`--i-own-this-target` is your statement that you own the endpoint or are authorized to test it.
It is recorded in the report (`run.target_ownership`). For a loopback address like this one the
run works without it; for any other address the CLI refuses to send anything until you pass it
(exit 3, `target_ownership_unattested`). If your agent needs a credential, pass a reference, never
the value:

```sh
MY_AGENT_TOKEN=… node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target https://agent.example.com/arena --auth env:MY_AGENT_TOKEN --i-own-this-target
```

The CLI reads the variable once, removes it from its environment, and never writes the value to a
report, SARIF file, replay or log. Non-loopback targets are paced at 5 requests/s by default
(`--max-rps`, at most 50), and the run prints its request ceiling before the first request.

## 5. Read the SARIF in GitHub

Once the public repository exists, it carries `.github/workflows/sarif-selftest.yml`. The workflow
builds the CLI, starts the reference target on loopback, runs the gate command, validates
`report.sarif` against the SARIF 2.1.0 schema, runs `verify`, and uploads the SARIF with
`github/codeql-action/upload-sarif` (category `agent-arena/selftest`).

1. Fork `rbrus/agent-arena` and enable Actions in the fork.
2. Run **Actions → sarif-selftest → Run workflow**.
3. Open **Security → Code scanning**.

With the coordinated reference the upload succeeds and there are **no alerts**: the reference
fails no oracle on the gate seeds. To see alerts, change `--policy coordinated` to
`--policy naive` in the workflow's "Start reference target" step and run it again. Measured
locally with the same command, that SARIF holds 13 results: `byzantine.off_quorum_position`
(error, 5), `byzantine.self_distrust` (error, 3) and `byzantine.outcome` (warning, 5). The
workflow still passes, because it fails only on exit codes of 2 or more and all five naive hashes
match their frozen anchors.

**Upload proven:** the SARIF validates against the schema in the gate (criterion 4), and this
repository's `sarif-selftest` workflow uploads it to the repository's own Security tab, where code
scanning lists the tool `@rbrus/agent-arena`. What each alert contains is described in [ci-integration.md](ci-integration.md#what-the-security-tab-shows).

To run the arena against your own endpoint in your own CI, see [ci-integration.md](ci-integration.md).

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `sh: 1: agent-arena: not found` from `npx @rbrus/agent-arena` inside a source checkout | in a checkout, `npm ci` links the bin before the bundle exists (see [About `npx @rbrus/agent-arena`](#about-npx-rbrusagent-arena)) | use `node packages/arena-cli/dist/agent-arena.cjs` |
| `Cannot find module …/dist/agent-arena.cjs` | the bundle was not built | `npm run build:cli` |
| `EADDRINUSE` from the reference target or the example agent | the port is taken | `--port <other>` for the reference; edit the port at the bottom of the example agent |
| every episode `forfeit`, `shared.budget_violation` at `error` (exit 1) | the target answered with errors or not at all; three consecutive hard misses forfeit an episode | check the agent's own log; a non-2xx answer is a refused submission and the units hold |
| exit 2 | the run itself failed: unreachable target, repeated 401/403, a crash | the error line names the cause and a next step |
| exit 3 `target_ownership_unattested` | non-loopback target without the attestation | pass `--i-own-this-target` if you own the endpoint or are authorized to test it |
| a target hostname that resolves to a private address is refused | the CLI's network guard, on purpose | type the loopback address, or pass `--allow-private` (logged) |

The CLI's full flag list, exit codes and security posture are in the
[CLI README](../../packages/arena-cli/README.md). The Docker route (the same image the hosted
runner will use) is in the [sandbox README](../../sandbox/README.md).

## Next

- [Writing an agent](writing-an-agent.md): the frames, budgets, transports and what each oracle
  looks for.
- [CI integration](ci-integration.md): a GitHub Actions job for your own endpoint.
- [Scenarios](../scenarios/README.md): one page per scenario, with known limitations.
- [FAQ](faq.md).
