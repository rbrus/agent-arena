/** Programmatic surface of the CLI (tests, qa/phase7-gate.ts). */
export { main, cli } from './main.ts';
export { runCommand, anchorFor, targetSeatInputs, type RunFlags } from './commands/run.ts';
export { verifyCommand, hostedSealErrors, engineBuildsFor } from './commands/verify.ts';
export { replayCommand } from './commands/replay.ts';
export { startReferenceServer, type ReferenceServer } from './reference/serve.ts';
export { ReferenceAgent, type ServePolicy } from './reference/policy.ts';
export { engineBuildHash, engineBuildFor, VERSION } from './build-info.ts';
export { redrive, regenerate, makeRerun, recordedActionsOf, CLI_SCENARIOS } from './rerun.ts';
export { buildReplayFile, type ReplayFile } from './replay-file.ts';
// Phase 8 C2g: diplomacy_standard.
export { parseDipFlags, canonicalFill, dipRecordedActions, dipValidity, attestLocalSignatures, DIP_UNVERIFIED_SIGNATURE, DIP_FILL_LABEL, DIP_IN_PROCESS, type DipRunOptions } from './diplomacy.ts';
export { DiplomacyReferenceAgent, DipWireView, fromWireObservation, DIP_SERVED_POLICIES, DIP_DEFAULT_AGENT_SEED, type DipServedPolicy } from './reference/diplomacy.ts';
export { dipRegenerateChecks, dipRerunChecks } from './verify-diplomacy.ts';
