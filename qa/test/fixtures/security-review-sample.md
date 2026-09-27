# Fixture: security hand review (regression input for qa/phase7-gate.ts parseReviewVerdict / openReviewFindings)

This file is test data. It imitates the shape of docs/phase-7/SECURITY-REVIEW.md: prose that uses
the word "pass" before the verdict token, an orchestrator note, and superseded verdicts kept for
the record with their own condition tables.

## 0. Verdict

**Current verdict, after the closure pass of 2026-01-01 (probes pass; §7 status): gate criterion 6 is PASS-WITH-CONDITIONS, with one condition.**
> **Orchestrator note, 2026-01-02 (after commit abc1234):** the single condition above (G-104) is closed — the suite passes 10/10. G-105 closed in the same commit. Pending the security-architect's counter-signature at release, gate criterion 6 is treated as **PASS**.

| Blocks | # | Finding | Sev | Why it blocks |
|---|---|---|---|---|
| public flip | 1 | **G-104**: fixture condition | Medium | fixture |

The earlier verdict follows, unchanged, for the record.

**First review (superseded): PASS-WITH-CONDITIONS.**

**Must close before the public flip:**

| # | Finding | Sev | Why it blocks |
|---|---|---|---|
| 1 | **G-101** superseded blocker one | High | fixture |
| 2 | **G-102** superseded blocker two | Medium | fixture |

## 7. Status of every finding (fixture)

| ID | Sev | State | Evidence (file:line) and residual | Test |
|---|---|---|---|---|
| G-101 | High | **Closed** (C2a) | closed long ago | `t` |
| G-102 | Medium | **Closed** (C2a), with residual **G-103** | closed | `t` |
| G-103 | Low | Open, Phase 9 | still open; a later pass will look again | — |
| G-106, G-107 | Low/Info | Open | Unchanged | — |
| G-108 | — | Accepted | accepted risk | — |
| G-109 | Medium | **Closed in design, reopened by G-104** | reopened | `t` |
| G-110 | Low | **Closed in design, reopened by G-103** | still reopened: G-103 is open | `t` |
| G-104 | Medium | **New** (§9.4); blocks the flip | fixture | `todo` |
| G-105 | Low | **New** (§9.4) | fixture | `todo` |

## 8. Later section

| G-199 | Low | Open | a row outside the status table must not be read | — |
