# ADR-002 — Diplomacy scenario: clean-room TypeScript adjudicator, DATC-validated

**Status:** ACCEPTED (D7, 2026-09-26) · **Date:** 2026-09-26 · **Depends on:** ADR-001

## Context

Diplomacy is the flagship adversarial-negotiation scenario (Phase 8). It needs a rules
adjudicator (order resolution for movement, support, convoy, retreat, build phases). The public
Diplomacy Adjudicator Test Cases (DATC) document, v3.0, is the accepted correctness spec.

Existing open-source adjudicators, checked 2026-09-26 via the GitHub API:

| Project | Language | License | Note |
|---|---|---|---|
| `diplomacy/diplomacy` | Python | **AGPL-3.0** | The standard research engine; last push 2024-02 |
| `godip` | Go | **GPL-3.0** | Actively maintained (2025-11) |
| `diplomacy/research` | Python | MIT | Research code, depends on the AGPL engine |

Both usable adjudicators are copyleft. Linking or bundling them inside an Apache-2.0 open core that
also feeds a closed paid layer is not acceptable; running the AGPL engine as a network service
adds an operational dependency and a licence-compliance surface for every modification.

## Decision

- Write a **clean-room TypeScript adjudicator** inside `wot-engine` (working name
  `packages/wot-engine/src/diplomacy/`), implemented from the published rules and the DATC
  document, **not** by translating either copyleft codebase. Contributors to this package must not
  have the AGPL/GPL sources open while writing it; record that in the package README.
- **Acceptance = DATC.** The full DATC suite (sections 6.A–6.J, **164 cases** in DATC v3.0 of 2024-02-23; the "~300" in the first draft was wrong) is encoded as
  fixtures; the gate requires 100% of cases marked "standard" to pass, and every deliberately
  non-standard choice to be listed in the package README with the DATC case id.
- Standard map only (7 powers, 1901 start) for Phase 8. Variants are out of scope.
- Determinism and replay hashing apply exactly as for Grid Tactics: an adjudicated phase is a
  pure function of (state, orders); the negotiation channel is projected into observations and
  hashed only through its settled consequences (the same projection discipline as the raid bosses).

## Alternatives considered

- **AGPL engine as a sidecar service.** Rejected: licence surface, Python runtime in a TS
  monorepo, and it breaks "the sim is the spec" (sandbox and hosted must be the same build).
- **Simplified "Diplomacy-lite" without convoys/retreats.** Rejected for the flagship: agents and
  reviewers will compare against real Diplomacy; DATC compliance is the credibility.

## Consequences

- Estimated ~3.8k LOC source + ~0.7k tests + ~7.5k lines of JSON fixtures (design estimate, 2026-09-26); the largest single Phase 8 workstream. Map adjacency data is also clean-room (entered from the board, second-person reviewed, digest pinned).
- The DATC document is a spec, not code; it is cited, not vendored.
