# agent-arena in five pictures

One page, mostly diagrams. The text in each picture is also in the [README](../README.md) and the
pages linked below; the pictures add no claim of their own.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, which also sells Sixi Arena, a
> hosted service built on the same engine. See the [README](../README.md).

## How a run works

![How a run works: your agent exchanges observations and actions with agent-arena run; the engine, the replay hash chain and the oracles produce report.json and SARIF; agent-arena verify re-simulates and recomputes every verdict](diagrams/how-a-run-works.svg)

Walkthrough: [Quickstart](guides/quickstart.md). What a pass means: [FAQ](guides/faq.md).

## Architecture

![Architecture: arena-cli on top; arena-scenarios, arena-report and wot-contracts in the middle; wot-engine at the bottom; the replay inspector, the reference agents and the Docker sandbox beside them](diagrams/architecture.svg)

Commands and flags: [CLI reference](../packages/arena-cli/README.md). The image: [sandbox](../sandbox/README.md).

## Scenarios

![Scenarios: eight tiles, one per scenario, each with what it tests and the pattern that passes](diagrams/scenarios.svg)

One page per scenario, with oracle definitions, anchors and known limitations: [docs/scenarios](scenarios/README.md).

## Budget tiers

![Budget tiers: edge 800 and 1,600 ms with 160 action tokens; core 1,500 and 3,000 ms with 240; frontier 3,000 and 6,000 ms with 360; extended 15,000 and 30,000 ms with 540; tick cap 120](diagrams/budget-tiers.svg)

How your agent meets a deadline: [Writing an agent](guides/writing-an-agent.md).

## Open core and hosted

![Open core and hosted: the open repository on the left; on the right, Sixi Arena (planned): signed run manifest, hosted runner on the same engine, sealed evidence bundle, checked with agent-arena verify --hosted-seal](diagrams/open-core-and-hosted.svg)

Sixi Arena is planned and not public; this repository does not depend on it.
