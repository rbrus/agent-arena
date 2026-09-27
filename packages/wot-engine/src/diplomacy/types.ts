/**
 * Diplomacy adjudicator — all exported types (docs/design/diplomacy-adjudicator.md §1, §3).
 * No logic lives here. Clean-room: see ./README.md.
 */

export type Power = 'austria' | 'england' | 'france' | 'germany' | 'italy' | 'russia' | 'turkey';

/** Canonical power order (alphabetical). Used everywhere a power list is serialised. */
export const POWERS: readonly Power[] = Object.freeze([
  'austria',
  'england',
  'france',
  'germany',
  'italy',
  'russia',
  'turkey',
] as const);

export type ProvinceId = string; // 3 lower-case ASCII letters
export type CoastTag = 'nc' | 'sc' | 'ec';
export type NodeId = string; // ProvinceId, or `${ProvinceId}/${CoastTag}` for split coasts
export type UnitType = 'A' | 'F';
export type Season = 'S' | 'F' | 'W';
export type PhaseKind = 'M' | 'R' | 'A';
export type PhaseId = string; // `${Season}${year}${PhaseKind}`

export interface ProvinceDef {
  id: ProvinceId;
  name: string; // normative English name (civil-disorder tie-break key)
  kind: 'sea' | 'inland' | 'coastal';
  sc: boolean;
  home: Power | null;
  coasts: readonly CoastTag[];
}

export interface Unit {
  power: Power;
  type: UnitType;
  at: NodeId;
}

export interface Dislodged {
  unit: Unit;
  attackerFrom: ProvinceId;
  byConvoy: boolean;
  options: readonly NodeId[];
}

export interface DipState {
  ruleset: 'wot-dip/1';
  year: number;
  season: Season;
  phase: PhaseKind;
  units: readonly Unit[];
  dislodged: readonly Dislodged[];
  sc: Readonly<Record<ProvinceId, Power | null>>;
}

// ---------------------------------------------------------------- orders

export interface RawLoc {
  p: ProvinceId;
  coast?: CoastTag | 'wc';
}

export type RawOrder =
  | { k: 'hold'; type?: UnitType; at: RawLoc }
  | { k: 'move'; type?: UnitType; at: RawLoc; to: RawLoc; via: boolean }
  | { k: 'support'; type?: UnitType; at: RawLoc; ofPower?: Power; ofType?: UnitType; of: RawLoc; to?: RawLoc }
  | { k: 'convoy'; type?: UnitType; at: RawLoc; ofPower?: Power; ofType?: UnitType; of: RawLoc; to: RawLoc }
  | { k: 'retreat'; type?: UnitType; at: RawLoc; to: RawLoc }
  | { k: 'disband'; type?: UnitType; at: RawLoc }
  | { k: 'build'; type: UnitType; at: RawLoc }
  | { k: 'waive' };

export type Order =
  | { k: 'hold'; unit: Unit }
  | { k: 'move'; unit: Unit; to: NodeId; convoyed: boolean }
  | { k: 'support'; unit: Unit; ofType: UnitType; of: ProvinceId; to: ProvinceId | null; toCoast: CoastTag | null }
  | { k: 'convoy'; unit: Unit; ofType: UnitType; of: ProvinceId; to: ProvinceId }
  | { k: 'retreat'; unit: Unit; to: NodeId }
  | { k: 'disband'; unit: Unit }
  | { k: 'build'; power: Power; type: UnitType; at: NodeId }
  | { k: 'waive'; power: Power };

export type ParseErrorCode =
  | 'not_string'
  | 'too_long'
  | 'non_ascii'
  | 'bad_whitespace'
  | 'empty'
  | 'bad_token'
  | 'unknown_province'
  | 'unknown_coast'
  | 'trailing_tokens'
  | 'bad_json';

export interface ParseError {
  error: ParseErrorCode;
  detail: string;
}

export type IllegalReason =
  | 'wrong_phase'
  | 'no_unit'
  | 'not_your_unit'
  | 'move_to_self'
  | 'army_to_sea'
  | 'no_convoy_route'
  | 'fleet_convoy'
  | 'not_adjacent'
  | 'bad_coast'
  | 'coast_required'
  | 'support_own_area'
  | 'support_unreachable'
  | 'unsupportable_move'
  | 'convoy_from_coast'
  | 'convoy_not_army'
  | 'convoy_bad_destination'
  | 'convoy_not_needed'
  | 'retreat_not_allowed'
  | 'no_disbands'
  | 'no_builds'
  | 'build_not_home'
  | 'build_not_owned'
  | 'build_occupied'
  | 'build_fleet_inland'
  | 'too_many_orders';

export interface OrderReport {
  power: Power;
  index: number;
  raw: string;
  status: 'used' | 'illegal' | 'superseded';
  reason?: IllegalReason;
  normalised?: string;
}

export interface LegalizeResult {
  orders: readonly Order[];
  report: readonly OrderReport[];
}

export type Submissions = Readonly<Partial<Record<Power, readonly RawOrder[]>>>;

export interface OrderResult {
  power: Power;
  order: string; // formatOrder
  result: 'success' | 'failure' | 'void';
}

export type DipEvent =
  | { kind: 'dislodged'; unit: Unit; attackerFrom: ProvinceId }
  | { kind: 'retreat_disbanded'; unit: Unit }
  | { kind: 'built'; unit: Unit }
  | { kind: 'removed'; unit: Unit }
  | { kind: 'civil_disorder_removed'; unit: Unit }
  | { kind: 'sc_changed'; province: ProvinceId; from: Power | null; to: Power }
  | { kind: 'eliminated'; power: Power }
  | { kind: 'adjudicator_anomaly'; decisions: readonly string[] };

export interface PhaseOutcome {
  phaseId: PhaseId;
  legal: LegalizeResult;
  results: readonly OrderResult[];
  next: DipState;
  contested: readonly ProvinceId[];
  events: readonly DipEvent[];
}
