/**
 * arena — the WSS session layer + Grid Tactics match runner (Stage B1).
 *
 * The launcher mounts this with:
 *   attachArena({ server, stores, arenaBaseUrl })
 * where `server` is a Node http.Server. It attaches a WebSocketServer that
 * handles upgrades on /v1/arena and returns a handle with `close()`.
 */

export { attachArena, anonymousDialInAllowed, type AttachArenaOptions, type ArenaHandle } from './arena.ts';
export {
  DEFAULT_DEADLINES,
  type DeadlineConfig,
  CLOSE,
  ARENA_PATH,
} from './config.ts';
// Diplomacy table lifecycle (Phase 9 hardening): result hand-off for ended tables.
export {
  memoryResultSink,
  DEFAULT_RESULT_CAP,
  type TableResultSink,
  type TableResultSummary,
  type TableResultDetail,
  type TableEndCause,
  type MemoryResultSinkOptions,
} from './diplomacy/results.ts';
export { DEFAULT_SEAT_TIMEOUT_MS, DEFAULT_END_GRACE_MS, type TableLookup } from './diplomacy/lobby.ts';
export { houseBotPolicy, type HouseBotPolicy } from './housebot.ts';
export {
  Match,
  registerMatchFinishHook,
  type MatchFinishHook,
  type MatchResumeState,
  type MatchEndInfo,
  type PlayerMeta,
} from './match.ts';
// Recovery (Phase 5 B5): the boot-time resume-XOR-clean-fail scan + its report.
export {
  runRecoveryScan,
  type RecoveryDeps,
  type RecoveryReport,
  type RecoveryOutcome,
  type ResumeContext,
} from './recovery.ts';
// Fuzz-hardening edge guards for the untrusted edges (B5).
export {
  guardFrame,
  jsonDepth,
  SubmissionNonceGuard,
  constantTimeEqual,
  type EdgeReason,
  type EdgeResult,
  type EdgeGuardOptions,
} from './edgeguard.ts';
export {
  verifyDelegatedChild,
  registryKeyFor,
  type DelegationStores,
  type RaidHelloBinding,
  type DelegatedChildResult,
  type DelegatedChildDenyReason,
} from './delegation.ts';
export { sanitizeText, sanitizeThought, sanitizeDisplayName } from './sanitize.ts';
export {
  attachRaidArena,
  RAID_PATH,
  type AttachRaidArenaOptions,
  type RaidArenaHandle,
  type RaidQueueResult,
} from './raid.ts';
export { RaidMatch, specForSlots, type RaidSlot } from './raidmatch.ts';
