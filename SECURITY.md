# Security policy

`agent-arena` is a tool people point at their own agents and run in CI. A flaw in it can become a
flaw in their pipeline, so we treat reports about it seriously and handle them in private.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Reports
reach the maintainer (`rbrus`). There is no email contact. Please do not open a public issue,
discussion or pull request for a suspected vulnerability.

Include what you can of:

- the version or commit,
- the component (CLI, a transport adapter, report/SARIF output, replay inspector, engine, sandbox),
- steps to reproduce, ideally a seed, a scenario id and a minimal target,
- the impact you believe it has.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement | within 5 working days |
| Initial assessment (confirmed / not reproducible / out of scope) | within 10 working days |
| Fix or mitigation for a confirmed issue | depends on severity; we will tell you the plan |
| Public advisory | after a fix is released, crediting you unless you ask otherwise |

This is maintained by a small team. These are targets, not guarantees.

## In scope

Issues in this repository, in particular:

- **Target credentials** — a bearer token or other secret supplied for a target that is persisted
  beyond the process, or appears in a report, replay, SARIF file, log or crash output.
- **SSRF** — a way to make a transport adapter reach a private or link-local address without the
  explicit opt-in, including through redirects or DNS rebinding.
- **Report integrity** — a way to produce a `report.json` that `agent-arena verify` accepts but
  that does not correspond to the recorded episodes.
- **Untrusted content from a target** — text returned by a target that executes, renders as markup,
  or injects content into the replay inspector, the SARIF output, a CI log or a terminal.
- **Determinism breaks** — any input that makes the same seed and actions produce different replay
  hashes, or that lets transport or timing reach the hashed state other than through recorded
  deadline outcomes.
- **Observation leakage** — a way for an agent to learn hidden state beyond what the scenario
  design exposes.
- **Sandbox** — escapes or unintended network exposure in the provided `docker compose` setup.

## Out of scope

- Weaknesses in *your* agent that a scenario reveals. That is the arena working; the report is the
  output.
- Vulnerabilities in third-party dependencies with no exploitable path through this project
  (report those upstream; tell us if you think we are affected).
- The hosted Sixi Arena service. Report those to Sixi AI through the channel listed on sixi.ai.
- Denial of service that requires running the CLI against your own machine with hostile flags.

## Safe harbour

We will not pursue legal action for good-faith research that stays within this policy, avoids
privacy violations and service disruption, and only targets systems you own or are authorized to
test.

## Conflict of interest

This project is maintained by its author (`rbrus`) together with Sixi AI, which sells a hosted service built on it. Security
reports about the open core are handled in this repository and fixed here first; a fix is never
held back for the commercial service.
