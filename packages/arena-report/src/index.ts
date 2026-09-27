/**
 * arena-report — Phase-7 B3: Report JSON (contracts/schemas/report.schema.json),
 * SARIF 2.1.0 (contracts/sarif-mapping.md), `verify`, and the report sanitiser.
 * Contracts 2.2.0: seat provenance and ADR-004 verification, the not-assessed
 * section, hosted-run passthrough, JCS/Ed25519 report signing (signing.md),
 * and the scoped engine build digest.
 */

export type * from './types.ts';
export {
  buildReport,
  ReportBuildError,
  NOT_APPLICABLE_REASONS,
  POWERS,
  resolvedSeat,
  resolvedFill,
  seatModeOf,
  seedFor,
  playerSeats,
  primarySeats,
  expectedSeatProvenance,
  seatProvenanceErrors,
  completeSeats,
  recordedInputsDigest,
  computeNotAssessed,
  sortNotAssessed,
  runReplayHash,
  computeRunOracles,
  summarize,
  deriveRunId,
  type BuildReportInput,
  type SeatProvenanceInput,
  type ExpectedSeat,
} from './build.ts';
export { toSarif, hostedProperties, kindAndLevel, fingerprint, SARIF_SCHEMA_URI, type ToSarifOptions } from './sarif.ts';
export { validateSarif, SARIF_SCHEMA_PATH, SARIF_SCHEMA_SHA256 } from './sarif-validate.ts';
export {
  verifyReport,
  type Rerun,
  type RerunContext,
  type RerunOutput,
  type RecordedSeatContext,
  type VerifyOptions,
  type VerifyResult,
  type VerifyDiff,
  type EpisodeVerification,
  type SeatProvenanceResult,
  type SignatureResult,
} from './verify.ts';
export { sanitizeForReport, DEFAULT_MAX_LENGTH, TRUNCATION_MARK, type SanitizeOptions } from './sanitize.ts';
export { EXIT_CODES, type ExitCode } from './exit-codes.ts';
export { exitCodeForReport } from './exit-policy.ts';
export { jcs, canonicalize, canonicalDigest, toFileJson, type JcsOptions } from './canonical.ts';
export {
  canonicalizeForSigning,
  signedBodyDigest,
  pae,
  signReport,
  signDocument,
  verifyReportSignature,
  verifyDocumentSignature,
  toPublicKey,
  toPrivateKey,
  REPORT_PAYLOAD_TYPE,
  RUN_MANIFEST_PAYLOAD_TYPE,
  CROSSCHECK_PAYLOAD_TYPE,
  SIGNATURE_POINTER,
  type Ed25519KeyInput,
  type SignatureCheck,
  type SignReportOptions,
} from './signing.ts';
export {
  engineBuildDigest,
  engineBuildDigestOf,
  engineBuildScopeFor,
  allowedEngineBuildScopes,
  engineSourceManifest,
  engineSourceManifestDigest,
  assertEngineSourceManifest,
  findEngineWorkspaceRoot,
  inScope,
  ENGINE_BUILD_SCOPES,
  ENGINE_SOURCE_ROOTS,
  ENGINE_SOURCE_MANIFEST_FORMAT,
  type EngineBuildScope,
  type EngineSourceManifest,
  type EngineBuildDigest,
  type EngineBuildDigestOptions,
} from './engine-digest.ts';
export { oracleCatalog, isScenarioId, DIPLOMACY_CATALOG, DIPLOMACY_SCENARIO_ID, ORACLE_TITLES, CONFLICT_OF_INTEREST, DETERMINISM_NOTE, TOOL_NAME, TOOL_VERSION, type ReportScenarioId } from './catalog.ts';
export { validateReportSchema, validateEpisodeResultSchema, validateRunSpecSchema } from './schemas.ts';
export {
  renderEvidenceReport,
  lintWording,
  EvidenceRenderError,
  R1_PATTERN,
  HOSTED_STATUS,
  LABEL_WITHHELD,
  LOCAL_STATUS,
  HOSTED_ADDENDUM,
  EVIDENCE_WORDING,
  EVIDENCE_CONTRACTS_VERSION,
  STANDING_EXCLUSIONS,
  validateEvidenceReportSchema,
  validatePackManifestSchema,
  validateCrosscheckRecordSchema,
  type EvidenceReport,
  type EvidenceFinding,
  type EvidenceRun,
  type EvidenceEvidenceRef,
  type EvidenceRenderOptions,
  type EvidenceCorpus,
  type CorpusRecord,
  type PackManifest,
  type PackRule,
  type PackSeverity,
  type CrosscheckRecordInput,
  type EvidenceBundle,
  type EvidenceAdmission,
  type EvidenceErrorCode,
  type VerifyResultLike,
} from './evidence.ts';
