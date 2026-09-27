# agent-arena documentation

agent-arena runs an AI agent through seeded, adversarial scenarios under fixed time and action
budgets, and reports which deterministic oracles fired, as `report.json` and SARIF 2.1.0. The
referee runs no model.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Verdicts are computed by
> deterministic, published oracles over hash-committed replays; scoring is oracle-first and
> tool-blind.

**Authorized testing only.** Point the arena at agents you own or are authorized in writing to test.

## Start here

| If you want to | Read |
|---|---|
| get a report and a replay on your machine in about five minutes | [Quickstart](guides/quickstart.md) |
| connect your own agent: frames, transports, budgets, what the oracles look for | [Writing an agent](guides/writing-an-agent.md) |
| run the arena against your endpoint on every push, with SARIF in the Security tab | [CI integration](guides/ci-integration.md) |
| know what a result does and does not mean | [FAQ](guides/faq.md) |

## Scenarios

One page per scenario: what it tests, what the target sees, the oracles as implemented, the golden
pair with its frozen hashes, what a failure means for a deployed agent, and what it does not test.

- [Scenarios index and common model](scenarios/README.md): seating, budget tiers, verdicts, shared
  oracles, effective episodes, glossary.
- [`grid_tactics`](scenarios/grid_tactics.md): the control scenario, a 1v1 duel under fog of war.
- [`hallucinator`](scenarios/hallucinator.md): false information in the shared world.
- [`overfit`](scenarios/overfit.md): an opponent that learns your policy.
- [`byzantine`](scenarios/byzantine.md): a compromised peer, and deciding by quorum.
- [`deadlock`](scenarios/deadlock.md): acquiring shared resources in a published order.
- [`split_brain`](scenarios/split_brain.md): a network partition with a contended write.
- [`latency`](scenarios/latency.md): acting on delayed observations.
- [`diplomacy_standard`](scenarios/diplomacy_standard.md): seven-power Diplomacy with a
  negotiation channel.

## Guides

- [Quickstart](guides/quickstart.md)
- [Writing an agent](guides/writing-an-agent.md)
- [CI integration](guides/ci-integration.md)
- [Defensive parsing](guides/defensive-parsing.md): handling text and claims from other agents,
  including Diplomacy press.
- [FAQ](guides/faq.md)

## Reference

| Topic | Where |
|---|---|
| CLI commands, flags, exit codes, transports, security posture, hosted mode | [packages/arena-cli/README.md](../packages/arena-cli/README.md) |
| Docker sandbox: one image, the reference target, `verify.sh` | [sandbox/README.md](../sandbox/README.md) |
| Contracts: RunSpec, EpisodeResult, Report, target-facing frames, versioning | [contracts/README.md](../contracts/README.md) |
| SARIF rule and level mapping, fingerprints | [contracts/sarif-mapping.md](../contracts/sarif-mapping.md) |
| Error codes | [contracts/errors.md](../contracts/errors.md) |
| Contract changes | [contracts/CHANGELOG.md](../contracts/CHANGELOG.md) |
| Replay inspector (static page, bundled samples) | [`frontend/`](../frontend/); how to open it: [Quickstart §3](guides/quickstart.md#3-open-the-report-in-the-replay-inspector) |
| Diplomacy adjudicator: clean-room decision and DATC | [adr/ADR-002-diplomacy-adjudicator.md](adr/ADR-002-diplomacy-adjudicator.md) |

## Project

- [README](../README.md): status table, limitations, related projects.
- [CONTRIBUTING](../CONTRIBUTING.md): what CI runs, adding a scenario, the clean-room rule.
- [SECURITY](../SECURITY.md): report vulnerabilities privately.
- [Code of conduct](../CODE_OF_CONDUCT.md).
- Licence: Apache-2.0, [LICENSE](../LICENSE), [NOTICE](../NOTICE).

## Built and planned (0.1.1)

| | State |
|---|---|
| Engine, seven open scenarios with oracles and golden anchors, report and SARIF writer | built |
| `diplomacy_standard` (adjudicator passes 164/164 DATC cases; negotiation oracles) | built; second-person review of the map data pending |
| CLI `run`, `list-scenarios`, `replay`, `verify`, `version`, `serve-reference`; REST, WebSocket, MCP, A2A | built |
| Replay inspector with verified samples | built |
| Docker sandbox | built; `verify.sh` measured 26 s with 5/5 anchors matched, not re-run for the Phase 7 gate |
| `@rbrus/agent-arena` on npm | published (0.1.1); the source build is equivalent ([Quickstart](guides/quickstart.md#about-npx-rbrusagent-arena)) |
| SARIF upload to a real GitHub Security tab | built; this repository's `sarif-selftest` workflow uploads the CLI's SARIF, and code scanning lists the tool `@rbrus/agent-arena` |
| Sixi Arena hosted service | planned; see the [FAQ](guides/faq.md#what-does-sixi-arena-add) |
