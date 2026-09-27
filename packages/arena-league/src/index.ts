/**
 * arena-league: the Neutral Ground table runner as a harness (Phase 9 B4, open-core part).
 * No inference and no network module here: Sixi's provider connectors implement `Peer`.
 */

export { definePeer, assertPeerMeta, assertCost, modelKey, slug, PeerMetaError, type Peer, type PeerMeta, type PeerCost, type PeerContext, type DiplomacyObservationFrame } from './peer.ts';
export { fakePeer, recordedPeer, throwingPeer, hangingPeer, brokenMeterPeer, FAKE_PRICE, type FakePolicy, type FakePeerOptions, type ThrowingPeerOptions } from './fake-peers.ts';
export { MonthlyCostCap, GameMeter, CapExhaustedError, DEFAULT_MONTHLY_CAP_CHF, DEFAULT_ALERT_THRESHOLDS, type CapAlert, type CapState, type MonthlyCapOptions, type Reservation } from './cost.ts';
export { runTable, reportsByModel, type TableSpec, type TableSeatSpec, type RunTableOptions, type TableRun, type TableOutcome } from './run-table.ts';
export { TableCore, houseRoster, powerAlive, type CoreDecision, type Miss } from './table.ts';
export { edgeAccept, UNVERIFIED_SIGNATURE, type EdgeResult } from './edge.ts';
export { TABLE_RECORD_FORMAT, TABLE_TIERS, assertTableRecord, assertTableTier, recordPointer, type TableRecord, type TableSeatRecord, type DecisionLog, type SeatRole, type AbortReason, type TableCostLedger } from './record.ts';
export { buildTableReports, redriveTable, verifyTableReport, tableRunSpec, perspectiveResult, provenanceOf, defaultEngineBuild, type SeatReport, type EngineBuildInfo } from './reports.ts';
export { perModelEvidence, type ModelEvidence, type OracleAggregate, type ModelTable, type PerModelOptions } from './evidence.ts';
export { composeLeague, type LeagueManifest, type LeagueTable } from './league.ts';
