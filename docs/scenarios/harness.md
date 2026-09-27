# Harness oracles

Harness oracles judge the run itself, not the target's behaviour. Rule ids are `harness.<name>`.

## replay_integrity

Basis `resim`, severity `error`. The episode's recorded inputs are re-simulated and must reproduce
the recorded per-tick hash chain and the final `replay_hash` (for Diplomacy also the
`transcript_hash` and both evaluation hashes). A failure means the report cannot be trusted: the
record was edited, a file is missing, or the engine build differs (the engine build hash is
checked first and a mismatch is reported as `unsupported_engine` rather than as this oracle).
`agent-arena verify` performs the same check from the files alone; the replay inspector's chain
check is a file-consistency check, not a re-simulation.
