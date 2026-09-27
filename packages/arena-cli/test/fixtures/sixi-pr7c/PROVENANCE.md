# Provenance: Sixi PR 7c evidence goldens

Test data for `test/evidence.test.ts`. Do not edit by hand: every file is a byte copy, and the test compares the
CLI's output with the goldens byte for byte.

**Source.** Repository `sixi-scanner`, commit `3ca6a8c08169cabb86040b7156637e2936c9a20c` ("Arena PR 7c: the evidence
report in the sealer"), directory `go/arena/`. See `docs/phase-9/pr/PR7c-evidence.md`.

| File here | Source | Git blob |
|---|---|---|
| `render/input.json` | `testdata/seal/evidence-input.golden.json` | `2b6ebdec5d2a1d7335a9110c2f1c33ebaae86ac1` |
| `golden/evidence.json` | `testdata/seal/evidence.golden.json` | `459eef80ab3b26088f84d86adcd639cb152068f7` |
| `golden/evidence.md` | `testdata/seal/evidence.golden.md` | `4441b205cba8e3f8e46be902568e5b07c7c272ad` |
| `golden/evidence-norecord.md` | `testdata/seal/evidence-norecord.golden.md` | `d6dd1288ca1e60a5724732f864c2f304bca30648` |
| `seal/report.json`, `seal/verify.json`, `out/report.sarif`, `out/run-manifest.json` | the sealer's test harness at that commit | see below |

**The four input files.** They are what the Go sealer's evidence test mounts for the job (`newEvidenceHarness(t,
true, nil)` then `toSigned()` in `evidence_test.go`): the fixture run `testdata/seal/hosted-run.tar.gz` after
seal steps 1 to 3. The report is signed with the RFC 8032 section 7.1 TEST 1 key (a published test vector, never a
Sixi key) under kid `sixi-arena-ed25519-20261101`, sealed at `2026-11-10T14:05:00Z`. The cross-check record in
`render/input.json` is signed with the same key. They were dumped from that harness unchanged, and their sha256
values are the ones the golden `signature.files` names:

| File | sha256 |
|---|---|
| `seal/report.json` | `71120d232551cda3ca2c4c3d5c79b3b77b79842795d6f161f1b5d2a6547907ef` |
| `out/report.sarif` | `9b43ac97d1ee5c977acca591fe715de3664771f460819badbcf0e422bd01247b` |
| `seal/verify.json` | `44e99782a7ef91896f5c6da0835a7fc8e2cb94918ef671033c0ab36375c126ac` |
| `out/run-manifest.json` | `64a5ab98ea94b25042e397680f330c927ba64bc569c4a1dd1bf013a5121caf76` |

**One line changed since the copy (contracts 2.13.0).** The renderer states the contracts release it validates against,
so the three goldens' contracts version moved from `2.12.0` to `2.13.0`: `golden/evidence.json` line 47
(`producer.contracts_version`) and the "Contracts version" row (line 40) of `golden/evidence.md` and
`golden/evidence-norecord.md`. No other byte differs from the source blobs above; the Sixi side re-vendors 2.13.0 and
regenerates its goldens with the released CLI (PR 7d).

**How the goldens were made.** Sixi's `testdata/seal/evidence-driver.mjs` (the proposed `agent-arena evidence`
command over `renderEvidenceReport`) at contracts 2.12.0. The no-record golden is the same inputs with
`crosscheck_record` removed from `render/input.json` (exit 1, `evidence.md` only).

EvidenceArgs.txt: the exact command line of the Sixi evidence job (go/arena/evidencejob.go EvidenceArgs), copied from the PR 7c note.
