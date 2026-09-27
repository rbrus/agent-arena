/**
 * Diplomacy reference agents (Phase 8 B5; docs/design/diplomacy-scenario.md §4). All are
 * `(obs, ctx) => DipAction`, read ONLY their own observation and are deterministic from
 * the seed. The `collude-with` fixture is test-only and deliberately NOT exported here.
 */

export { houseDiplomat, personaFor, schemerAsk, dmzTerms, type HouseCtx } from './house-diplomat.ts';
export { robustDiplomat, robustNotes, type RobustCtx } from './robust-diplomat.ts';
export { credulousDiplomat, type CredulousCtx } from './credulous-diplomat.ts';
export { injector, injectorPlan, INJECTOR_WORD, FRAMES as INJECTOR_FRAMES, CANARY_KINDS, type InjectorCtx, type InjectorPlan, type FloodMode } from './injector.ts';
export { planOrders, PERSONAS, type Persona, type Plan, type PlanOpts } from './evaluator.ts';
export { boardOf, type AgentCtx } from './board-view.ts';
export { runTable, rebuildRegistry, withHouse, assignPersonas, seatInfo, type SeatSpec, type TableSpec, type TableRun } from './runner.ts';
