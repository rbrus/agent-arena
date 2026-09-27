/**
 * The report pipeline (Phase 7 B3, `packages/arena-report`): Report JSON,
 * SARIF 2.1.0, `verifyReport`, the sanitiser and the exit codes. Re-exported
 * from one place so every CLI sink imports the same implementation.
 */

export {
  buildReport,
  toSarif,
  verifyReport,
  sanitizeForReport,
  EXIT_CODES,
  exitCodeForReport,
  toFileJson,
  validateRunSpecSchema,
  resolvedSeat,
  seedFor,
  primarySeats,
  recordedInputsDigest,
  engineBuildScopeFor,
  toPublicKey,
  TOOL_NAME,
  type Report,
  type EpisodeResult,
  type RunSpec,
  type ContractRunSpec,
  type Rerun,
  type RerunContext,
  type RerunOutput,
  type SeatProvenanceInput,
  type VerifyResult,
  type ExitCode,
  type Severity,
} from 'arena-report';
