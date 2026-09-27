/**
 * The Sixi Arena evidence report renderer (Phase 9 B3):
 * docs/phase-9/EVIDENCE-REPORT-TEMPLATE.md rendered as Markdown, plus the
 * machine-readable `evidence.json` (contracts/schemas/evidence_report.schema.json, K8).
 *
 * Inputs: one or more sealed Reports (one per scenario x tier run of a scan),
 * and optionally the pack manifests they mounted, a `sixi-assure-rules` corpus
 * map, the cross-check record of the image digest, the `verify` result(s), the
 * bundle file digests and the admission record's retention dates.
 *
 * Rules enforced here (template Part 2):
 *   R1  every rendered string (Markdown and JSON) is linted for the forbidden
 *       conformity words; a hit throws `EvidenceRenderError` (code `wording`).
 *       Customer-supplied strings (target label, CI label keys and values, the
 *       target path) are data, not Sixi's wording: one that trips the rule is
 *       withheld (`[label withheld]`, path `(withheld)`) instead of failing.
 *   R2  not_assessed is never counted as a pass; §6 always renders; a scan with
 *       no completed episode renders the short "never reached" notice.
 *   R3  ids and counts only: no evidence_ref message, outcome_reason, press
 *       text or URL query is ever rendered. The two customer-supplied strings
 *       (target label, CI labels) pass through `sanitizeForReport`.
 *   R4  every clause id a mounted pack names is looked up in the corpus map
 *       (contracts 2.5.0). An unknown id renders as "no clause found" in the
 *       Markdown and is listed under Not assessed with reason
 *       `clause_unresolved` (`evidence.json` `not_assessed.unresolved_clauses`);
 *       it is never invented, and it appears in no finding, record,
 *       assessed-no-finding or coverage list.
 *   R5  reproduced N of M: M counts assessed episodes only; distinct
 *       trajectories always shown; run-level oracles are "not measured".
 *   R6  (contracts 2.9.0, signing.md §11.3 step 6a) a pack whose
 *       `coverage.clauses` omits a clause its clause map or rules cite is
 *       not loaded: it is listed as "not loaded" under Build identity, none
 *       of its clauses, rules or scenarios is cited anywhere (never a partial
 *       citation), and no evidence.json is produced, since that document has
 *       no way to say a mounted pack was not loaded.
 *
 * When `json` is null. `evidence.json` is a hosted, sealed document by
 * contract (its `status_line` is the hosted statement, and region, image
 * digest, cross-check, retention and signature are required). It is therefore
 * null for a local report, and for a hosted report whose sealed inputs were
 * not all supplied (`verifyResult` verified, `crosscheckRecord`, `bundle`,
 * `admission`, and a corpus when a pack is in scope). The Markdown says which.
 *
 * Cross-check record. It is schema-checked; with `crosscheckKey` its Ed25519
 * signature is verified too (CROSSCHECK_PAYLOAD_TYPE), and a record that does
 * not verify is refused. A `scope: local` record is refused: it never promotes
 * a digest and is never cited by an evidence report (contracts 2.5.0).
 *
 * Pack rules. The renderer has no CEL engine. A rule is evaluated only when
 * its condition is the canonical single-oracle form
 * `v.oracle_id == "<id>" && v.verdict == "fail"` with scope `verdict`; any
 * other rule is listed under Not assessed as not evaluated by this renderer.
 * Clause citations otherwise come from the pack's clause map (`oracles[]`).
 *
 * Pure apart from reading the contract schemas and CHANGELOG at module load.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { SCENARIO_IDS } from 'arena-scenarios';
import { NOT_APPLICABLE_REASONS } from './build.ts';
import { CONFLICT_OF_INTEREST } from './catalog.ts';
import { canonicalDigest } from './canonical.ts';
import { sanitizeForReport } from './sanitize.ts';
import { formatErrors, isDateTime, isUri, SCHEMAS_DIR } from './schemas.ts';
import { CROSSCHECK_PAYLOAD_TYPE, verifyDocumentSignature, type Ed25519KeyInput } from './signing.ts';
import type { CatalogOracle, EpisodeResult, Report, SeatMode, Severity, TierId, Verdict, VerdictSeat } from './types.ts';
import type { VerifyResult } from './verify.ts';

/* ------------------------------------------------------------------ R1 -- */

/** Template R1, verbatim: the forbidden conformity words, case-insensitive. */
export const R1_PATTERN = /\bcomplian(t|ce)\b|\bcertif(y|ied|ies|ication)\b|\bguarant\w*|\bconfirm\w*/i;

export type EvidenceErrorCode = 'wording' | 'input' | 'schema';

export class EvidenceRenderError extends Error {
  readonly code: EvidenceErrorCode;
  constructor(code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceRenderError';
    this.code = code;
  }
}

/** Throws `EvidenceRenderError('wording')` when `text` contains a forbidden word (R1). */
export function lintWording(text: string, where: string): void {
  const m = R1_PATTERN.exec(text);
  if (!m) return;
  const at = m.index;
  const ctx = text.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' ');
  throw new EvidenceRenderError('wording', `R1 wording rule: "${m[0]}" in ${where} (…${ctx}…). The report assesses and evidences; it never uses this word.`);
}

/** Every string leaf of a JSON value, with its pointer. */
function* stringLeaves(v: unknown, path = ''): Generator<[string, string]> {
  if (typeof v === 'string') yield [path || '/', v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* stringLeaves(v[i], `${path}/${i}`);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    yield [`${path}/${k} (key)`, k];
    yield* stringLeaves(x, `${path}/${k}`);
  }
}

/* --------------------------------------------------------------- inputs -- */

/** One record of the `sixi-assure-rules` corpus, reduced to what the report shows. */
export interface CorpusRecord {
  /** The instrument, e.g. "Regulation (EU) 2024/1689 (AI Act)". */
  instrument: string;
  /** The reference inside it, e.g. "Art. 14". */
  reference: string;
  /** Sixi's own paraphrase (never the source's wording). */
  paraphrase: string;
  /** The official source URL (https). */
  url: string;
  /** The clause heading, e.g. "Human oversight", when the record has one. */
  title?: string;
}

/** `REGIME:DOC:REF` → record, e.g. `{ 'AIACT:2024/1689:Art14': { … } }`. */
export type EvidenceCorpus = Readonly<Record<string, CorpusRecord>>;

export interface PackRule {
  id: string;
  title: string;
  scope: 'verdict' | 'episode' | 'run';
  oracles: string[];
  condition: string;
  severity: PackSeverity;
  message: string;
  clauses: string[];
  techniques?: string[];
  remediation: string;
  [k: string]: unknown;
}

/** contracts/schemas/pack_manifest.schema.json (validated on input). */
export interface PackManifest {
  manifest_version: '1.0';
  id: string;
  version: string;
  kinds: string[];
  title: string;
  corpus: { repo: string; ref: string; lenses: { atlas: string } };
  regimes: string[];
  disclaimer: string;
  scenarios?: { id: string; base?: string; scenario_version: string; seat_modes: SeatMode[]; tiers: TierId[]; reproducibility: { method: string; trials: number }; peers?: unknown[] }[];
  oracles?: { oracle_id: string; clauses: string[]; techniques?: string[] }[];
  rules?: PackRule[];
  coverage: { clauses: string[] };
  [k: string]: unknown;
}

/** contracts/schemas/crosscheck_record.schema.json (validated on input; its signature is not checked here). */
export interface CrosscheckRecordInput {
  record_version: '1.0';
  image_digest: { index: string; platform_manifest: string; platform: 'linux/amd64' | 'linux/arm64' };
  tool_version: string;
  engine_build_hash: string;
  job_verdict: 'pass' | 'inconclusive' | 'fail';
  finished_at: string;
  /** 2.5.0: absent = hosted. A `local` record is refused by the renderer. */
  scope?: 'hosted' | 'local';
  signing?: { signing_key_id: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** The sealed bundle's file digests and the published key set (template §11). */
export interface EvidenceBundle {
  jwks_url: string;
  files: { path: 'report.json' | 'report.sarif' | 'bundle-manifest.json'; sha256: string; run_id?: string }[];
}

/** From the admission record (template Appendix B: Sixi's statement). */
export interface EvidenceAdmission {
  reports_until: string;
  audit_until: string;
  credential_destroyed_at?: string;
  requested_by?: { actor_kind: 'user' | 'pipeline_token' | 'system'; actor_id: string };
  /** Set when a cross-check on this digest failed after the run was sealed. */
  incident_ref?: string;
}

export type VerifyResultLike = Pick<VerifyResult, 'status' | 'unverified'>;

export interface EvidenceRenderOptions {
  packManifests?: readonly PackManifest[];
  corpus?: EvidenceCorpus;
  crosscheckRecord?: CrosscheckRecordInput;
  /** The published public key of the cross-check record's signer; when given, the record's signature must verify. */
  crosscheckKey?: Ed25519KeyInput;
  /** One per report, in report order (a single result is accepted for a single report). */
  verifyResult?: VerifyResultLike | readonly VerifyResultLike[];
  bundle?: EvidenceBundle;
  admission?: EvidenceAdmission;
  /** `https://<host>/…` of the hosted replay inspector build; deep links are added when given. */
  inspectorBaseUrl?: string;
}

/* ------------------------------------------------------ evidence.json -- */

export type PackSeverity = 'critical' | 'high' | 'medium' | 'low';
type BehaviourState = 'broke' | 'held' | 'not_assessed';

export interface EvidenceEvidenceRef {
  run_id: string;
  episode_index: number;
  seed: number;
  ticks: number[];
  replay_hash: string;
  evidence_ids?: string[];
  inspector_link?: string;
}

export interface EvidenceFinding {
  finding_id: string;
  rule_id?: string;
  oracle_id: string;
  run_id: string;
  seat: VerdictSeat;
  verdict_severity: Severity;
  pack_severity?: PackSeverity;
  reproduced: number;
  trials: number;
  distinct_trajectories: number;
  clauses: string[];
  techniques: string[];
  evidence: EvidenceEvidenceRef[];
  review_required: boolean;
}

export interface EvidenceRun {
  run_id: string;
  scenario_id: string;
  base_scenario_id?: string;
  scenario_version: string;
  budget_tier: TierId;
  seat_mode: SeatMode;
  seat_position?: string;
  fill?: 'coordinated' | 'naive';
  diplomacy_profile?: 'security' | 'clean' | 'table';
  seeds: number[];
  seed_source: 'fixed' | 'fresh' | 'explicit';
  episodes_total: number;
  episodes_completed: number;
  episodes_aborted: number;
  effective_episodes: number;
  summary_verdict: 'pass' | 'fail' | 'inconclusive';
  sarif_category: string;
  report_sha256: string;
  within_budget_episodes: number;
  budget: { soft_deadline_ms: number; hard_deadline_ms: number; token_allowance: number; soft_misses: number; hard_misses: number; frames_too_large: number };
  recorded_seats?: { seat: VerdictSeat; driver: 'target' | 'recorded_peer'; inputs_source: 'recorded' | 'llm_peer' }[];
}

export interface EvidenceReport {
  schema: 'sixi.arena.evidence/v1';
  evidence_version: '1.0';
  producer: { name: 'sixi-arena'; version: string; region: string; sealed_at: string };
  status_line: typeof HOSTED_STATUS;
  assessed: boolean;
  not_assessed_reason?: 'no_episode_completed';
  scope: {
    org_ref: string;
    scan_id?: string;
    target_label: string;
    verified_origin: { origin: string; method: 'dns' | 'well-known'; verified_at: string; checked_at: string; record_id?: string };
    target_path_redacted?: string;
    transport: 'rest' | 'ws' | 'mcp' | 'a2a';
    credential_mode: string;
    credential_destroyed_at?: string;
    region: string;
    run_window: { started_at: string; finished_at: string };
    requested_by?: { actor_kind: string; actor_id: string };
    ci?: { repository?: string; run_id?: string; sha?: string };
  };
  build: {
    engine_build_hash: string;
    engine_version: string;
    engine_commit?: string;
    image_digest: { index: string; platform_manifest: string; platform: string };
    tool: { name: string; version: string };
    contracts_version: string;
    report_version: '1.0';
    packs: { id: string; version: string; digest: string }[];
    corpus?: { repo: string; ref: string; atlas_lens: string };
    crosscheck: { ref: string; verdict: string; date: string; record_digest: string; failed_after_seal?: boolean; incident_ref?: string };
    seal_verification: { status: 'verified'; unverified_fields: string[] };
  };
  runs: EvidenceRun[];
  behaviour: { run_id: string; oracle_id: string; title?: string; state: BehaviourState; fail_n: number; pass_n: number; not_assessed_n: number; basis: 'resim' | 'attested' }[];
  findings: EvidenceFinding[];
  records: { clause_id: string; decision: 'gap'; severity: PackSeverity; findings: string[]; statement?: string; disclaimer?: string }[];
  assessed_no_finding_clauses: string[];
  not_assessed: {
    scenarios_not_run: { scenario_id: string; availability: 'open' | 'pack'; pack?: string; reason: 'not_requested' | 'not_in_plan' | 'profile_excludes' }[];
    oracles: { run_id: string; oracle_id: string; seat?: VerdictSeat; episodes_not_assessed: number; episodes: number; reason_codes: Record<string, number>; sarif_kind: 'notApplicable' | 'open' }[];
    aborted_episodes: { run_id: string; episode_index: number; seed: number; abort_reason: string; terminal_tick: number }[];
    coverage: { tiers_not_run: TierId[]; seat_modes_not_run: SeatMode[]; pack_clauses_not_assessed: string[]; unmapped_clauses: string[] };
    report_entries: NonNullable<Report['not_assessed']>;
    standing_exclusions: typeof STANDING_EXCLUSIONS;
    /** 2.5.0: pack-named clause ids the renderer's corpus snapshot does not resolve (never cited elsewhere). */
    unresolved_clauses?: { clause_id: string; pack: string; reason_code: 'clause_unresolved' }[];
  };
  limitations: string[];
  disclosure: { conflict_of_interest: string; hosted_addendum: string; llm_peers_addendum?: string; wording: 'assesses and evidences only' };
  retention: { transcripts_until: string; replays_until: string; reports_until: string; audit_until: string };
  signature: { algorithm: 'ed25519'; signing_key_id: string; jwks_url: string; files: { path: string; run_id?: string; sha256: string; envelope: string }[] };
}

/* ------------------------------------------------------------ constants -- */

export const HOSTED_STATUS = 'Reproducible, run by Sixi against a verified origin.' as const;
export const LOCAL_STATUS = 'Reproducible, self-reported.' as const;
export const HOSTED_ADDENDUM = 'Sixi AI operated this run and sells the hosted evaluation. The referee ran no model.';
export const EVIDENCE_WORDING = 'assesses and evidences only' as const;

/** Template §6.5, as the schema's codes, in template order. */
export const STANDING_EXCLUSIONS = ['model_identity', 'production_equivalence', 'beyond_scenario_frames', 'undefined_harms', 'single_target_collusion', 'content_quality_and_unmapped_obligations'] as const;
const STANDING_EXCLUSION_TEXT: Record<(typeof STANDING_EXCLUSIONS)[number], string> = {
  model_identity: 'The identity, version or provider of the model behind the endpoint.',
  production_equivalence: 'The behaviour of the production system outside the verified origin and the run window.',
  beyond_scenario_frames: 'Anything the agent does beyond the frames of these scenarios (its tools, data stores, other users, other endpoints).',
  undefined_harms: 'Harms that no oracle defines.',
  single_target_collusion: 'Multi-owner collusion in single-target runs (`collusion` is not applicable there).',
  content_quality_and_unmapped_obligations: 'Content quality, factual accuracy outside the scenario, bias, or any regulatory obligation that is not cited in this report.',
};

const BASE_LIMITATIONS = ['live_agent_nondeterminism', 'egress_ip_behaviour', 'attested_basis', 'public_seed_tuning', 'learnable_oracles', 'review_required_statistical', 'clause_mapping_is_a_reading'] as const;

/** The published gate seeds (`seeds: fixed`). */
const GATE_SEEDS = [20260720, 1, 2, 3, 5];
/** Every tier (contracts 2.10.0 adds `extended`): a tier not run is listed, never implied covered. */
const TIERS: readonly TierId[] = ['edge', 'core', 'frontier', 'extended'];
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
const PACK_RANK: Record<PackSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const CLAUSE_ID = /^(OWASP:(AgenticTop10:ASI(0[1-9]|10)|LLMTop10:LLM(0[1-9]|10)|[A-Za-z][A-Za-z0-9]{1,31}:[A-Za-z0-9().-]{1,32})|AIACT:2024\/1689:(Art[0-9]{1,3}(\([0-9]{1,2}\))?(\([a-z]\))?|Annex[IVX]{1,4}(\([0-9]{1,2}\))?))$/;
const EVIDENCE_ID = /^[a-z][a-z0-9_]{0,15}:[A-Za-z0-9:_.-]{1,47}$/;
const CODE_ID = /^[a-z][a-z0-9_]{0,63}$/;
const SHA = /^sha256:[0-9a-f]{64}$/;
const POINTER = /^(\/[A-Za-z0-9_.~-]{1,64}){1,6}$/;
const CANONICAL_CONDITION = /^\s*v\.oracle_id\s*==\s*"([a-z][a-z0-9_]{0,39}\.[a-z][a-z0-9_]{0,47})"\s*&&\s*v\.verdict\s*==\s*"fail"\s*$/;
const SAFE_PATH = /^\/[A-Za-z0-9._~\/-]{0,255}$/;
const DOCS_URI = /^https:\/\/github\.com\/rbrus\/agent-arena\/[A-Za-z0-9._~\/#-]{1,200}$/;

/* ------------------------------------------------------ schemas / version -- */

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const kw of ['x-max-frame-bytes', 'x-frame-name', 'x-direction']) ajv.addKeyword({ keyword: kw });
ajv.addFormat('date-time', isDateTime);
ajv.addFormat('uri', isUri);
const loadSchema = (f: string) => JSON.parse(readFileSync(join(SCHEMAS_DIR, f), 'utf8')) as Record<string, unknown>;
export const validateEvidenceReportSchema: ValidateFunction = ajv.compile(loadSchema('evidence_report.schema.json'));
export const validatePackManifestSchema: ValidateFunction = ajv.compile(loadSchema('pack_manifest.schema.json'));
export const validateCrosscheckRecordSchema: ValidateFunction = ajv.compile(loadSchema('crosscheck_record.schema.json'));

/** The contracts release this renderer validates against: the newest released version in contracts/CHANGELOG.md. */
export const EVIDENCE_CONTRACTS_VERSION: string = (() => {
  const log = readFileSync(join(dirname(SCHEMAS_DIR), 'CHANGELOG.md'), 'utf8');
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(log);
  if (!m) throw new Error('contracts/CHANGELOG.md names no released version');
  return m[1];
})();

/* -------------------------------------------------------------- helpers -- */

const fail = (msg: string): never => {
  throw new EvidenceRenderError('input', msg);
};

/** An id rendered as inline code. Ids never carry a backtick or a line break; anything else is refused. */
function code(s: string | number): string {
  const t = String(s);
  if (/[`\r\n\u0000-\u001f]/.test(t) || t.length === 0 || t.length > 300) fail(`refusing to render ${JSON.stringify(t.slice(0, 40))} as an id`);
  return `\`${t}\``;
}

/** Untrusted or free text: sanitised and escaped for Markdown (threat-model-arena.md §4.1). */
const text = (s: unknown, max = 280) => sanitizeForReport(s, { maxLength: max });
/** Untrusted text for JSON: controls and escapes removed, no Markdown escaping. */
const plain = (s: unknown, max: number) => sanitizeForReport(s, { maxLength: max, escapeMarkdown: false });

/** What a customer-supplied label that trips the R1 wording rule renders as. */
export const LABEL_WITHHELD = '[label withheld]';
const tripsR1 = (raw: unknown, shown: string) => R1_PATTERN.test(shown) || (typeof raw === 'string' && R1_PATTERN.test(raw));
/**
 * A customer-supplied label (target label, CI label), sanitised for Markdown or JSON. The label is the
 * customer's text, not the report's wording, so a forbidden word withholds the label (R1) instead of
 * failing the rendering; ids and Sixi's own text still fail on a hit.
 */
function customerLabel(raw: unknown, max: number, markdown: boolean): string {
  const shown = markdown ? text(raw, max) : plain(raw, max);
  return tripsR1(raw, shown) ? LABEL_WITHHELD : shown;
}

const shortHash = (h: string) => (SHA.test(h) ? `sha256:${h.slice(7, 19)}` : fail(`not a sha256 digest: ${h.slice(0, 20)}`));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const regimeOf = (clause: string) => clause.slice(0, clause.indexOf(':'));

function addDays(iso: string, days: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) fail(`not a date-time: ${iso}`);
  return new Date(t + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function reproducedText(n: number, m: number, d: number): string {
  if (m === 0) return 'reproduction not measured';
  return `reproduced ${n} of ${m} (${plural(d, 'distinct trajectory', 'distinct trajectories')})`;
}

/** The target origin and path of a RunSpec URL; the query and fragment are dropped (R3). */
function targetParts(url: string): { origin: string; path: string | null; loopback: boolean } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { origin: 'unparseable target URL', path: null, loopback: false };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  // The path is customer text: withheld when unsafe or when it trips R1 (e.g. `/certified-agent`).
  const path = SAFE_PATH.test(u.pathname) && !R1_PATTERN.test(u.pathname) ? u.pathname : null;
  return { origin: `${u.protocol}//${u.host}`, path, loopback };
}

function seatModeOf(r: Report): SeatMode {
  const m = r.run.spec.seat?.mode;
  if (m) return m;
  if (r.scenario.scenario_id === 'diplomacy_standard' || r.scenario.base_scenario_id === 'diplomacy_standard') return 'power';
  if (r.scenario.scenario_id === 'grid_tactics') return 'duel';
  return (r.episodes[0]?.mode as SeatMode | undefined) ?? 'member';
}

/** The seat modes a scenario can be run in (open registry, or the pack manifest for `sx_`). */
function applicableModes(scenarioId: string, packScenario?: { seat_modes: SeatMode[] }): SeatMode[] {
  if (packScenario) return [...packScenario.seat_modes];
  if (scenarioId === 'grid_tactics') return ['duel'];
  if (scenarioId === 'diplomacy_standard') return ['power'];
  return ['member', 'squad'];
}

function seatLabel(r: Report): string {
  const s = r.run.spec.seat as { mode?: string; position?: string; fill?: string } | undefined;
  const mode = seatModeOf(r);
  const parts: string[] = [mode];
  if (s?.position) parts.push(s.position);
  else if (mode === 'power') parts.push('auto');
  if (s?.fill) parts.push(s.fill);
  return parts.join(' ');
}

function seedSource(r: Report): 'fixed' | 'fresh' | 'explicit' {
  const hosted = r.run.hosted?.seed_source as 'fixed' | 'fresh' | 'explicit' | undefined;
  if (hosted) return hosted;
  const s = r.run.spec.seeds;
  return s.length === GATE_SEEDS.length && s.every((x, i) => x === GATE_SEEDS[i]) ? 'fixed' : 'explicit';
}

function verdictSeat(v: Verdict, e?: EpisodeResult): VerdictSeat {
  return (v.seat ?? e?.seat ?? 'squad') as VerdictSeat;
}

/* --------------------------------------------------------- clause model -- */

interface ClauseSource {
  clauses: string[];
  techniques: string[];
  packs: string[];
  disclaimer?: string;
}

/**
 * Contracts 2.9.0 load rule (signing.md §11.3 step 6a): the clauses cited by `oracles[].clauses` or
 * `rules[].clauses` that `coverage.clauses` omits, in citation order (oracles first, then rules). Empty = the pack
 * satisfies coverage ⊇ clause map ∪ rule clauses. The reverse (a coverage clause no oracle maps) is allowed.
 */
export function packCoverageMissing(p: Pick<PackManifest, 'coverage' | 'oracles' | 'rules'>): string[] {
  const cov = new Set(p.coverage?.clauses ?? []);
  const cited = [...(p.oracles ?? []).flatMap((o) => o.clauses ?? []), ...(p.rules ?? []).flatMap((r) => r.clauses ?? [])];
  return uniq(cited.filter((c) => !cov.has(c)));
}

/** Clause map of the packs in scope: oracle id → clauses, techniques, packs. */
function clauseMap(packs: readonly PackManifest[]): Map<string, ClauseSource> {
  const map = new Map<string, ClauseSource>();
  for (const p of packs) {
    for (const o of p.oracles ?? []) {
      const cur = map.get(o.oracle_id) ?? { clauses: [], techniques: [], packs: [], disclaimer: p.disclaimer };
      cur.clauses = uniq([...cur.clauses, ...o.clauses]);
      cur.techniques = uniq([...cur.techniques, ...(o.techniques ?? [])]);
      cur.packs = uniq([...cur.packs, p.id]);
      map.set(o.oracle_id, cur);
    }
  }
  return map;
}

interface RuleMatch {
  pack: PackManifest;
  rule: PackRule;
  oracleId: string;
}

/** Split pack rules into the canonical single-oracle ones this renderer evaluates and the rest. */
function classifyRules(packs: readonly PackManifest[]): { evaluable: RuleMatch[]; notEvaluated: { pack: string; rule: string }[] } {
  const evaluable: RuleMatch[] = [];
  const notEvaluated: { pack: string; rule: string }[] = [];
  for (const pack of packs) {
    for (const rule of pack.rules ?? []) {
      const m = CANONICAL_CONDITION.exec(rule.condition);
      if (rule.scope === 'verdict' && m && rule.oracles.length === 1 && rule.oracles[0] === m[1]) evaluable.push({ pack, rule, oracleId: m[1] });
      else notEvaluated.push({ pack: pack.id, rule: rule.id });
    }
  }
  return { evaluable, notEvaluated };
}

/** `{{v.oracle_id}}`, `{{v.seat}}`, `{{n}}`, `{{m}}` only: ids and counts (R3). */
function renderRuleMessage(rule: PackRule, vars: { oracle: string; seat: string; n: number; m: number }): string {
  return rule.message.replace(/\{\{\s*([a-z._]+)\s*\}\}/g, (_all, name: string) => {
    switch (name) {
      case 'v.oracle_id':
        return vars.oracle;
      case 'v.seat':
        return vars.seat;
      case 'n':
        return String(vars.n);
      case 'm':
        return String(vars.m);
      default:
        return fail(`pack rule ${rule.id}: message variable {{${name}}} is not an id or a count this renderer can fill`);
    }
  });
}

/* --------------------------------------------------------- the renderer -- */

interface FindingWork {
  finding: EvidenceFinding;
  runIndex: number;
  title: string;
  risk?: CatalogOracle['risk'];
  rule?: PackRule;
  rulePack?: string;
  clauseState: 'mapped' | 'no_pack' | 'unmapped';
  /** Every clause the mapping names, in mapping order, unresolved ids included (the Markdown's "no clause found"); `finding.clauses` keeps only resolved ids. */
  mappedClauses: string[];
  disclaimer?: string;
  observed: string[];
  helpUri?: string;
}

/**
 * Render the evidence report for one sealed Report, or for the runs of one scan.
 * Throws `EvidenceRenderError` on an R1 word anywhere in the output (`wording`),
 * on inconsistent or invalid inputs (`input`), and when a produced
 * `evidence.json` does not validate (`schema`).
 */
export function renderEvidenceReport(reportOrReports: Report | readonly Report[], opts: EvidenceRenderOptions = {}): { markdown: string; json: EvidenceReport | null } {
  const reports: readonly Report[] = Array.isArray(reportOrReports) ? reportOrReports : [reportOrReports as Report];
  if (reports.length === 0) fail('no report to render');
  const first = reports[0];
  const hosted = first.run.mode === 'hosted';

  /* -------- input consistency -------- */
  for (const r of reports) {
    if (r.run.mode !== first.run.mode) fail('the reports mix local and hosted runs');
    if (r.engine.build_hash !== first.engine.build_hash) fail('the reports come from different engine builds');
    if (r.run.tool.version !== first.run.tool.version) fail('the reports come from different tool versions');
    if (r.disclosure.conflict_of_interest !== CONFLICT_OF_INTEREST) fail(`report ${r.run.run_id}: the conflict-of-interest disclosure is not the published text`);
    if (hosted) {
      const h = r.run.hosted;
      if (!h || !r.signing) fail(`report ${r.run.run_id}: a hosted report without run.hosted or a signing seal`);
      const fh = first.run.hosted!;
      const vo = (x: typeof h) => (x!.verified_origin as { origin: string }).origin;
      if (vo(h) !== vo(fh) || h!.org_ref !== fh.org_ref || h!.region !== fh.region || JSON.stringify(h!.image_digest) !== JSON.stringify(fh.image_digest)) {
        fail(`report ${r.run.run_id}: origin, organisation, region or image digest differs from the first run`);
      }
    }
  }
  const verifyResults: (VerifyResultLike | undefined)[] = Array.isArray(opts.verifyResult)
    ? (opts.verifyResult as readonly VerifyResultLike[]).slice()
    : reports.map((_r, i) => (i === 0 ? (opts.verifyResult as VerifyResultLike | undefined) : undefined));
  if (Array.isArray(opts.verifyResult) && opts.verifyResult.length !== reports.length) fail('verifyResult: one result per report, in report order');
  for (const [i, v] of verifyResults.entries()) {
    if (v && v.status !== 'verified') fail(`report ${reports[i].run.run_id}: verify returned "${v.status}"; an evidence report is issued only over a verified report`);
  }
  const allVerified = verifyResults.length === reports.length && verifyResults.every((v) => v?.status === 'verified');

  for (const p of opts.packManifests ?? []) {
    if (!validatePackManifestSchema(p)) fail(`pack manifest ${String((p as { id?: unknown }).id)}: ${formatErrors(validatePackManifestSchema.errors).join('; ')}`);
  }
  if (opts.crosscheckRecord && !validateCrosscheckRecordSchema(opts.crosscheckRecord)) {
    fail(`cross-check record: ${formatErrors(validateCrosscheckRecordSchema.errors).join('; ')}`);
  }
  if (opts.crosscheckRecord?.scope === 'local') fail('the cross-check record has scope local: it never promotes a digest and is never cited by an evidence report');
  let crosscheckSignature: { status: 'valid'; kid: string } | undefined;
  if (opts.crosscheckKey !== undefined) {
    if (!opts.crosscheckRecord) fail('crosscheckKey was given without a cross-check record');
    const c = verifyDocumentSignature(opts.crosscheckRecord, opts.crosscheckKey, CROSSCHECK_PAYLOAD_TYPE);
    if (!c.ok || !c.kid) fail(`the cross-check record's signature is ${c.status}: ${c.errors.join('; ').slice(0, 300)}`);
    crosscheckSignature = { status: 'valid', kid: c.kid! };
  }
  for (const [id, rec] of Object.entries(opts.corpus ?? {})) {
    if (!CLAUSE_ID.test(id)) fail(`corpus: ${JSON.stringify(id.slice(0, 80))} is not a REGIME:DOC:REF clause id`);
    for (const k of ['instrument', 'reference', 'paraphrase', 'url'] as const) if (typeof rec?.[k] !== 'string') fail(`corpus ${id}: ${k} missing`);
  }

  /* -------- packs in scope: the mounted id@version of every hosted run -------- */
  const mounted = new Map<string, { id: string; version: string; digest: string }>();
  for (const r of reports) for (const p of r.run.hosted?.packs ?? []) mounted.set(`${p.id}@${p.version}`, p);
  // R6: a mounted pack that fails the coverage rule is not loaded, so nothing of it is cited (never partially).
  const notLoaded = new Map<string, { missing: string[] }>();
  for (const p of opts.packManifests ?? []) {
    if (!mounted.has(`${p.id}@${p.version}`)) continue;
    const missing = packCoverageMissing(p);
    if (missing.length) notLoaded.set(`${p.id}@${p.version}`, { missing });
  }
  const packs = (opts.packManifests ?? []).filter((p) => mounted.has(`${p.id}@${p.version}`) && !notLoaded.has(`${p.id}@${p.version}`));
  const corpusRefs = uniq(packs.map((p) => `${p.corpus.repo}@${p.corpus.ref}@${p.corpus.lenses.atlas}`));
  if (corpusRefs.length > 1) fail(`the packs in scope name different corpus snapshots: ${corpusRefs.join(', ')}`);
  const cmap = clauseMap(packs);
  const { evaluable, notEvaluated } = classifyRules(packs);
  const packScenario = new Map<string, NonNullable<PackManifest['scenarios']>[number] & { pack: string }>();
  for (const p of packs) for (const s of p.scenarios ?? []) if (!packScenario.has(s.id)) packScenario.set(s.id, { ...s, pack: p.id });

  /* -------- R4: every clause id a mounted pack names, resolved against the corpus snapshot -------- */
  const clauseOwner = new Map<string, string>(); // clause id -> first pack (by id) that names it
  for (const p of [...packs].sort((a, b) => a.id.localeCompare(b.id))) {
    const named = [...(p.oracles ?? []).flatMap((o) => o.clauses), ...(p.rules ?? []).flatMap((r) => r.clauses), ...p.coverage.clauses];
    for (const c of named) if (!clauseOwner.has(c)) clauseOwner.set(c, p.id);
  }
  const resolvesInCorpus = (c: string) => !!opts.corpus && Object.prototype.hasOwnProperty.call(opts.corpus, c);
  const unresolved = [...clauseOwner.keys()].filter((c) => !resolvesInCorpus(c)).sort();
  const unresolvedSet = new Set(unresolved);
  // Without a corpus nothing can be resolved: the Markdown lists every id as unresolved and cites none by
  // title, the clause lists keep their ids, and no evidence.json is produced (a blocker below).
  const resolved = (cs: readonly string[]) => (opts.corpus ? cs.filter((c) => !unresolvedSet.has(c)) : [...cs]);

  /* -------- runs, behaviour, findings -------- */
  const runs: EvidenceRun[] = [];
  const behaviour: EvidenceReport['behaviour'] = [];
  const work: FindingWork[] = [];
  const naOracles: EvidenceReport['not_assessed']['oracles'] = [];
  const aborted: EvidenceReport['not_assessed']['aborted_episodes'] = [];
  const assessedOracles = new Set<string>();
  const heldOracles = new Set<string>();
  const brokeOracles = new Set<string>();
  const recordedSeatNotes: { runIndex: number; seat: string; driver: string; inputs_source: string; agent?: string; provider?: string }[] = [];

  reports.forEach((r, runIndex) => {
    const runId = r.run.run_id;
    const completed = r.episodes.filter((e) => e.status === 'completed');
    const mode = seatModeOf(r);
    const s = r.run.spec.seat as { position?: string; fill?: 'coordinated' | 'naive' } | undefined;
    const primarySeats = new Set(r.episodes.map((e) => e.seat as string));
    const recorded = new Map<string, NonNullable<EvidenceRun['recorded_seats']>[number]>();
    for (const e of r.episodes) {
      for (const st of e.seats ?? []) {
        if (st.driver === 'engine' || primarySeats.has(st.seat)) continue;
        if (!recorded.has(st.seat)) {
          recorded.set(st.seat, { seat: st.seat, driver: st.driver as 'target' | 'recorded_peer', inputs_source: st.inputs_source as 'recorded' | 'llm_peer' });
          recordedSeatNotes.push({ runIndex, seat: st.seat, driver: st.driver, inputs_source: st.inputs_source, agent: st.peer?.agent ?? st.agent, provider: st.peer?.provider });
        }
      }
    }
    const budget = { soft_misses: 0, hard_misses: 0, frames_too_large: 0 };
    for (const e of r.episodes) {
      budget.soft_misses += e.budget.soft_deadline_misses;
      budget.hard_misses += e.budget.hard_deadline_misses;
      budget.frames_too_large += e.budget.frames_too_large;
    }
    const reportFile = opts.bundle?.files.find((f) => f.path === 'report.json' && (f.run_id === undefined || f.run_id === runId));
    const diplomacy = r.run.spec.diplomacy as { profile?: 'security' | 'clean' | 'table' } | undefined;
    runs.push({
      run_id: runId,
      scenario_id: r.scenario.scenario_id,
      ...(r.scenario.base_scenario_id ? { base_scenario_id: r.scenario.base_scenario_id } : {}),
      scenario_version: r.scenario.version,
      budget_tier: r.run.spec.budget_tier,
      seat_mode: mode,
      ...(s?.position ? { seat_position: s.position } : mode === 'power' ? { seat_position: 'auto' } : {}),
      ...(s?.fill ? { fill: s.fill } : {}),
      ...(diplomacy?.profile ? { diplomacy_profile: diplomacy.profile } : {}),
      seeds: [...r.run.spec.seeds],
      seed_source: seedSource(r),
      episodes_total: r.summary.episodes_total,
      episodes_completed: r.summary.episodes_completed,
      episodes_aborted: r.summary.episodes_aborted,
      effective_episodes: r.summary.effective_episodes,
      summary_verdict: r.summary.verdict,
      sarif_category: `agent-arena/${r.scenario.scenario_id}/${r.run.spec.budget_tier}/${mode}/`,
      report_sha256: reportFile?.sha256 ?? '',
      within_budget_episodes: r.summary.within_budget_episodes,
      budget: { soft_deadline_ms: r.budget_limits.soft_deadline_ms, hard_deadline_ms: r.budget_limits.hard_deadline_ms, token_allowance: r.budget_limits.token_allowance, ...budget },
      ...(recorded.size ? { recorded_seats: [...recorded.values()].sort((a, b) => a.seat.localeCompare(b.seat)) } : {}),
    });

    for (const e of r.episodes) {
      if (e.status === 'aborted') aborted.push({ run_id: runId, episode_index: e.episode_index, seed: e.seed, abort_reason: e.abort_reason ?? 'harness_error', terminal_tick: e.terminal_tick });
    }

    // Behaviour: one row per catalog oracle, in catalog order (template §4).
    for (const o of r.scenario.oracles) {
      const sum = r.summary.oracles.find((x) => x.oracle_id === o.oracle_id) ?? { pass: 0, fail: 0, not_assessed: 0 };
      const state: BehaviourState = sum.fail > 0 ? 'broke' : sum.pass > 0 ? 'held' : 'not_assessed';
      behaviour.push({ run_id: runId, oracle_id: o.oracle_id, title: plain(o.title, 120), state, fail_n: sum.fail, pass_n: sum.pass, not_assessed_n: sum.not_assessed, basis: o.basis });
      if (sum.fail + sum.pass > 0) assessedOracles.add(o.oracle_id);
      if (state === 'held') heldOracles.add(o.oracle_id);
      if (state === 'broke') brokeOracles.add(o.oracle_id);
    }

    // Verdicts grouped by oracle x seat (episode level) and by oracle (run level).
    type Group = { oracle: CatalogOracle; seat: VerdictSeat; items: { v: Verdict; e?: EpisodeResult }[]; runLevel: boolean };
    const groups = new Map<string, Group>();
    const catalog = new Map(r.scenario.oracles.map((o) => [o.oracle_id, o]));
    const push = (v: Verdict, e: EpisodeResult | undefined) => {
      const oracle = catalog.get(v.oracle_id) ?? fail(`report ${runId}: verdict for ${v.oracle_id}, which is not in the catalog`);
      const seat = verdictSeat(v, e);
      const key = `${v.oracle_id}|${e ? seat : 'run'}`;
      const g = groups.get(key) ?? { oracle, seat, items: [], runLevel: !e };
      g.items.push({ v, e });
      groups.set(key, g);
    };
    for (const e of r.episodes) for (const v of e.oracles) push(v, e);
    for (const v of r.run_oracles) push(v, undefined);

    const catalogOrder = (id: string) => r.scenario.oracles.findIndex((o) => o.oracle_id === id);
    const ordered = [...groups.values()].sort((a, b) => catalogOrder(a.oracle.oracle_id) - catalogOrder(b.oracle.oracle_id) || String(a.seat).localeCompare(String(b.seat)));
    for (const g of ordered) {
      const na = g.items.filter((x) => x.v.verdict === 'not_assessed');
      if (na.length > 0) {
        const reasons: Record<string, number> = {};
        for (const x of na) {
          const rc = x.v.reason_code && CODE_ID.test(x.v.reason_code) ? x.v.reason_code : 'unspecified';
          reasons[rc] = (reasons[rc] ?? 0) + 1;
        }
        const sortedReasons = Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b)));
        naOracles.push({
          run_id: runId,
          oracle_id: g.oracle.oracle_id,
          ...(g.runLevel ? {} : { seat: g.seat }),
          episodes_not_assessed: na.length,
          episodes: g.items.length,
          reason_codes: sortedReasons,
          sarif_kind: Object.keys(reasons).every((k) => NOT_APPLICABLE_REASONS.has(k)) ? 'notApplicable' : 'open',
        });
      }
      const fails = g.items.filter((x) => x.v.verdict === 'fail');
      if (fails.length === 0) continue;
      const assessed = g.items.filter((x) => x.v.verdict !== 'not_assessed');
      const trials = g.runLevel ? 0 : assessed.length;
      const reproduced = g.runLevel ? 0 : fails.length;
      const distinct = g.runLevel ? 0 : uniq(assessed.map((x) => x.e!.trajectory_class ?? `unclassified:${x.e!.episode_index}`)).length;
      const verdictSeverity = fails.map((x) => x.v.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];
      const evidenceEpisodes = g.runLevel ? completed.map((e) => ({ e, v: fails[0].v })) : fails.map((x) => ({ e: x.e!, v: x.v }));
      const evidence: EvidenceEvidenceRef[] = evidenceEpisodes.slice(0, 32).map(({ e, v }) => {
        const ticks = g.runLevel ? [] : (v.evidence_ref?.ticks ?? []).filter((t) => Number.isInteger(t) && t >= 0 && t <= 120).slice(0, 32);
        const ids = g.runLevel ? [] : uniq((v.evidence_ref?.items ?? []).map((it) => (it && typeof it === 'object' ? (it as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string' && EVIDENCE_ID.test(id))).slice(0, 32);
        const ref: EvidenceEvidenceRef = { run_id: runId, episode_index: e.episode_index, seed: e.seed, ticks, replay_hash: e.replay_hash };
        if (ids.length) ref.evidence_ids = ids;
        const base = opts.inspectorBaseUrl?.replace(/\/+$/, '');
        if (base) {
          if (!/^https:\/\/[^\s?#]+$/.test(base)) fail('inspectorBaseUrl must be an https URL without query or fragment');
          const sample = runId.toLowerCase().replace(/_/g, '-');
          ref.inspector_link = `${base}/inspector/#sample=${sample}&ep=${e.episode_index}&t=${ticks[0] ?? 0}`;
        }
        return ref;
      });
      const observed = fails.slice(0, 5).map(({ v, e }) => {
        const where = e ? `episode ${e.episode_index} (seed ${e.seed})` : 'run level';
        const nums = (o?: Record<string, number>) =>
          Object.entries(o ?? {})
            .filter(([k, x]) => CODE_ID.test(k) && Number.isFinite(x))
            .map(([k, x]) => `${code(k)} ${x}`)
            .join(', ');
        const parts = [where];
        const m = nums(v.measures);
        const t = nums(v.thresholds);
        if (m) parts.push(`measures ${m}`);
        if (t) parts.push(`thresholds ${t}`);
        if (v.evidence_ref?.code && CODE_ID.test(v.evidence_ref.code)) parts.push(`code ${code(v.evidence_ref.code)}`);
        return parts.join('; ');
      });
      const base = {
        oracle_id: g.oracle.oracle_id,
        run_id: runId,
        seat: g.runLevel ? ((r.episodes[0]?.seat as VerdictSeat | undefined) ?? 'squad') : g.seat,
        verdict_severity: verdictSeverity,
        reproduced,
        trials,
        distinct_trajectories: distinct,
        evidence,
        review_required: g.oracle.review_required === true || fails.some((x) => x.v.review_required === true),
      };
      const common = { runIndex, title: g.oracle.title, risk: g.oracle.risk, observed, helpUri: g.oracle.help_uri && DOCS_URI.test(g.oracle.help_uri) ? g.oracle.help_uri : undefined };
      const rules = evaluable.filter((x) => x.oracleId === g.oracle.oracle_id);
      if (rules.length > 0) {
        for (const m of rules) {
          work.push({
            ...common,
            rule: m.rule,
            rulePack: m.pack.id,
            clauseState: 'mapped',
            mappedClauses: [...m.rule.clauses],
            disclaimer: m.pack.disclaimer,
            finding: { finding_id: '', rule_id: m.rule.id, ...base, pack_severity: m.rule.severity, clauses: resolved(m.rule.clauses), techniques: [...(m.rule.techniques ?? [])] },
          });
        }
      } else {
        const cm = cmap.get(g.oracle.oracle_id);
        work.push({
          ...common,
          clauseState: cm ? 'mapped' : packs.length ? 'unmapped' : 'no_pack',
          mappedClauses: cm ? [...cm.clauses] : [],
          disclaimer: cm?.disclaimer,
          finding: { finding_id: '', ...base, clauses: cm ? resolved(cm.clauses) : [], techniques: cm ? [...cm.techniques] : [] },
        });
      }
    }
  });

  // Order: severity, then oracle id (template §5); then run, seat, rule.
  work.sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.verdict_severity] - SEVERITY_RANK[b.finding.verdict_severity] ||
      a.finding.oracle_id.localeCompare(b.finding.oracle_id) ||
      a.runIndex - b.runIndex ||
      String(a.finding.seat).localeCompare(String(b.finding.seat)) ||
      (a.finding.rule_id ?? '').localeCompare(b.finding.rule_id ?? ''),
  );
  work.forEach((w, i) => (w.finding.finding_id = `F${i + 1}`));
  const findings = work.map((w) => w.finding);

  /* -------- clauses: records, assessed-no-finding, coverage, resolution -------- */
  const mappedClausesOf = (oracleId: string): string[] => resolved(uniq([...(cmap.get(oracleId)?.clauses ?? []), ...evaluable.filter((x) => x.oracleId === oracleId).flatMap((x) => x.rule.clauses)]));
  const recordMap = new Map<string, { findings: FindingWork[] }>();
  for (const w of work) for (const c of w.finding.clauses) (recordMap.get(c) ?? recordMap.set(c, { findings: [] }).get(c)!).findings.push(w);
  const records: EvidenceReport['records'] = [...recordMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clause, { findings: fs }]) => {
      const sev = fs
        .map((w): PackSeverity => w.finding.pack_severity ?? w.risk ?? (w.finding.verdict_severity === 'error' ? 'high' : w.finding.verdict_severity === 'warning' ? 'medium' : 'low'))
        .sort((a, b) => PACK_RANK[a] - PACK_RANK[b])[0];
      const parts = fs.map((w) => `${w.finding.rule_id ?? w.finding.oracle_id} ${reproducedText(w.finding.reproduced, w.finding.trials, w.finding.distinct_trajectories)}`);
      let statement = `${plural(fs.length, 'finding')} ${fs.length === 1 ? 'bears' : 'bear'} on this clause: ${parts.join('; ')}.`;
      if (statement.length > 400) statement = `${plural(fs.length, 'finding')} bear on this clause: ${fs.map((w) => w.finding.finding_id).join(', ')}.`.slice(0, 400);
      const disclaimer = fs.find((w) => w.disclaimer)?.disclaimer;
      return { clause_id: clause, decision: 'gap' as const, severity: sev, findings: fs.map((w) => w.finding.finding_id), statement, ...(disclaimer ? { disclaimer } : {}) };
    });
  const cited = new Set(recordMap.keys());
  const assessedClauses = new Set([...assessedOracles].flatMap(mappedClausesOf));
  const assessedNoFinding = [...assessedClauses].filter((c) => !cited.has(c)).sort();
  const coverage = resolved(uniq(packs.flatMap((p) => p.coverage.clauses)));
  const packClausesNotAssessed = coverage.filter((c) => !assessedClauses.has(c)).sort();
  const allMapped = new Set([...cmap.values()].flatMap((x) => x.clauses).concat(evaluable.flatMap((x) => x.rule.clauses)));
  const regimes = new Set(packs.flatMap((p) => p.regimes));
  const unmapped = Object.keys(opts.corpus ?? {})
    .filter((c) => regimes.has(regimeOf(c)) && !allMapped.has(c))
    .sort();

  /* -------- scenarios not run, coverage -------- */
  const runIds = new Set(reports.map((r) => r.scenario.scenario_id));
  const scenariosNotRun: EvidenceReport['not_assessed']['scenarios_not_run'] = [];
  for (const id of SCENARIO_IDS) if (!runIds.has(id)) scenariosNotRun.push({ scenario_id: id, availability: 'open', reason: 'not_requested' });
  for (const [id, s] of packScenario) if (!runIds.has(id) && !(SCENARIO_IDS as readonly string[]).includes(id)) scenariosNotRun.push({ scenario_id: id, availability: 'pack', pack: s.pack, reason: 'not_requested' });
  const tiersRun = new Set(reports.map((r) => r.run.spec.budget_tier));
  const modesRun = new Set(reports.map(seatModeOf));
  const modesApplicable = uniq(reports.flatMap((r) => applicableModes(r.scenario.scenario_id, packScenario.get(r.scenario.scenario_id))));
  const coverageBlock = {
    tiers_not_run: TIERS.filter((t) => !tiersRun.has(t)),
    seat_modes_not_run: (['duel', 'member', 'squad', 'power'] as SeatMode[]).filter((m) => modesApplicable.includes(m) && !modesRun.has(m)),
    pack_clauses_not_assessed: packClausesNotAssessed,
    unmapped_clauses: unmapped,
  };
  // An unresolved id is listed only under unresolved_clauses, never as a report entry either.
  // R6: a clause entry the report attributes to a pack that is not loaded is not carried over (never a partial citation).
  const notLoadedIds = new Set([...notLoaded.keys()].map((k) => k.slice(0, k.lastIndexOf('@'))));
  const reportEntries = reports
    .flatMap((r) => r.not_assessed ?? [])
    .filter((e) => !(opts.corpus && e.kind === 'clause' && unresolvedSet.has(e.id)))
    .filter((e) => !(e.kind === 'clause' && e.pack && notLoadedIds.has(e.pack)));

  /* -------- limitations, disclosure -------- */
  const completedTotal = reports.reduce((n, r) => n + r.summary.episodes_completed, 0);
  const episodesTotal = reports.reduce((n, r) => n + r.summary.episodes_total, 0);
  const limitations: string[] = [...BASE_LIMITATIONS];
  if (reports.some((r) => r.summary.effective_episodes < r.summary.episodes_completed)) limitations.push('effective_episodes_below_count');
  if (aborted.some((a) => a.abort_reason.startsWith('target_'))) limitations.push('target_transport_failure');
  if (recordedSeatNotes.length) limitations.push('recorded_peer_seats');
  const llmPeerPacks = uniq(reports.flatMap((r) => r.episodes.flatMap((e) => (e.seats ?? []).filter((s) => s.inputs_source === 'llm_peer' && s.peer).map((s) => s.peer!.pack))));
  const llmPeersAddendum = llmPeerPacks.length
    ? `The run included Sixi-operated LLM peers from pack ${llmPeerPacks.join(', ')}. They are players, not judges, and their messages are recorded inputs.`
    : undefined;

  /* -------- evidence.json (hosted, sealed, fully resolved only) -------- */
  const jsonBlockers: string[] = [];
  if (!hosted) jsonBlockers.push('local run: evidence.json is a hosted, sealed document');
  else {
    if (!allVerified) jsonBlockers.push('no verified `verify` result was supplied for every run');
    if (!opts.crosscheckRecord) jsonBlockers.push('no cross-check record was supplied');
    if (!opts.bundle) jsonBlockers.push('no bundle file digests were supplied');
    if (!opts.admission) jsonBlockers.push('no admission record (report and audit retention) was supplied');
    if (packs.length && !opts.corpus) jsonBlockers.push('no clause corpus was supplied for the mounted packs');
    for (const [key, n] of notLoaded) jsonBlockers.push(`pack ${key} was not loaded: its coverage.clauses omits ${n.missing[0]} (signing.md §11.3 step 6a)`);
    if (runs.some((x) => !SHA.test(x.report_sha256))) jsonBlockers.push('the bundle names no report.json digest for every run');
  }
  const h = first.run.hosted;
  const xc = opts.crosscheckRecord;
  if (xc && h) {
    const idx = (h.image_digest as { index: string }).index;
    if (xc.image_digest.index !== idx) fail(`the cross-check record is for image ${xc.image_digest.index}, not ${idx}`);
  }
  const sealedAt = reports.map((r) => r.signing?.sealed_at ?? '').sort().at(-1) ?? '';
  const failedAfterSeal = !!xc && xc.job_verdict === 'fail' && Date.parse(xc.finished_at) > Date.parse(sealedAt);

  let json: EvidenceReport | null = null;
  if (jsonBlockers.length === 0 && h && xc && opts.bundle && opts.admission) {
    const hv = h.verified_origin as EvidenceReport['scope']['verified_origin'];
    const labels = first.run.spec.labels ?? {};
    const ci: NonNullable<EvidenceReport['scope']['ci']> = {};
    if (labels.repository) ci.repository = customerLabel(labels.repository, 128, false);
    if (labels.ci_run) ci.run_id = customerLabel(labels.ci_run, 64, false);
    if (labels.git_sha && /^[0-9a-f]{7,40}$/.test(labels.git_sha)) ci.sha = labels.git_sha;
    const tp = targetParts(first.run.spec.target.url);
    const retentionDays = h.retention as { transcripts_days: number; replays_days: number };
    const finishedAt = reports.map((r) => r.run.finished_at).sort().at(-1)!;
    const startedAt = reports.map((r) => r.run.started_at).sort()[0];
    const unverifiedFields = uniq(verifyResults.flatMap((v) => v!.unverified)).sort();
    for (const p of unverifiedFields) if (!POINTER.test(p)) fail(`verify listed an unverified field that is not a JSON Pointer: ${p.slice(0, 80)}`);
    const pack0 = packs[0];
    json = {
      schema: 'sixi.arena.evidence/v1',
      evidence_version: '1.0',
      producer: { name: 'sixi-arena', version: first.run.tool.version, region: h.region, sealed_at: sealedAt },
      status_line: HOSTED_STATUS,
      assessed: completedTotal > 0,
      ...(completedTotal === 0 ? { not_assessed_reason: 'no_episode_completed' as const } : {}),
      scope: {
        org_ref: h.org_ref as string,
        ...(h.scan_id ? { scan_id: h.scan_id as string } : {}),
        target_label: first.run.spec.target.label ? customerLabel(first.run.spec.target.label, 64, false) : '',
        verified_origin: { origin: hv.origin, method: hv.method, verified_at: hv.verified_at, checked_at: hv.checked_at, ...(hv.record_id ? { record_id: hv.record_id } : {}) },
        ...(tp.path ? { target_path_redacted: tp.path } : {}),
        transport: first.run.spec.target.transport,
        credential_mode: h.credential_mode as string,
        ...(opts.admission.credential_destroyed_at ? { credential_destroyed_at: opts.admission.credential_destroyed_at } : {}),
        region: h.region,
        run_window: { started_at: startedAt, finished_at: finishedAt },
        ...(opts.admission.requested_by ? { requested_by: { ...opts.admission.requested_by } } : {}),
        ...(Object.keys(ci).length ? { ci } : {}),
      },
      build: {
        engine_build_hash: first.engine.build_hash,
        engine_version: first.engine.version,
        ...(first.engine.commit ? { engine_commit: first.engine.commit } : {}),
        image_digest: { ...(h.image_digest as EvidenceReport['build']['image_digest']) },
        tool: { ...first.run.tool },
        contracts_version: EVIDENCE_CONTRACTS_VERSION,
        report_version: '1.0',
        packs: [...mounted.values()].map((p) => ({ id: p.id, version: p.version, digest: p.digest })),
        ...(pack0 ? { corpus: { repo: pack0.corpus.repo, ref: pack0.corpus.ref, atlas_lens: pack0.corpus.lenses.atlas } } : {}),
        crosscheck: {
          ref: `crosscheck/${xc.image_digest.index}.json`,
          verdict: xc.job_verdict,
          date: xc.finished_at,
          record_digest: canonicalDigest(xc),
          failed_after_seal: failedAfterSeal,
          ...(opts.admission.incident_ref ? { incident_ref: opts.admission.incident_ref } : {}),
        },
        seal_verification: { status: 'verified', unverified_fields: unverifiedFields },
      },
      runs,
      behaviour,
      findings,
      records,
      assessed_no_finding_clauses: assessedNoFinding,
      not_assessed: {
        scenarios_not_run: scenariosNotRun,
        oracles: naOracles,
        aborted_episodes: aborted,
        coverage: coverageBlock,
        report_entries: reportEntries,
        standing_exclusions: STANDING_EXCLUSIONS,
        ...(unresolved.length ? { unresolved_clauses: unresolved.map((c) => ({ clause_id: c, pack: clauseOwner.get(c)!, reason_code: 'clause_unresolved' as const })) } : {}),
      },
      limitations,
      disclosure: {
        conflict_of_interest: CONFLICT_OF_INTEREST,
        hosted_addendum: HOSTED_ADDENDUM,
        ...(llmPeersAddendum ? { llm_peers_addendum: llmPeersAddendum } : {}),
        wording: EVIDENCE_WORDING,
      },
      retention: {
        transcripts_until: addDays(finishedAt, retentionDays.transcripts_days),
        replays_until: addDays(finishedAt, retentionDays.replays_days),
        reports_until: opts.admission.reports_until,
        audit_until: opts.admission.audit_until,
      },
      signature: {
        algorithm: 'ed25519',
        signing_key_id: h.signing_key_id,
        jwks_url: opts.bundle.jwks_url,
        files: opts.bundle.files.map((f) => ({ path: f.path, ...(f.run_id ? { run_id: f.run_id } : {}), sha256: f.sha256, envelope: `${f.path}.dsse.json` })),
      },
    };
    if (completedTotal === 0) {
      json.findings = [];
      json.records = [];
    }
    for (const [p, s] of stringLeaves(json)) lintWording(s, `evidence.json ${p}`);
    if (!validateEvidenceReportSchema(json)) {
      throw new EvidenceRenderError('schema', `evidence.json does not validate against evidence_report.schema.json: ${formatErrors(validateEvidenceReportSchema.errors).join('; ')}`);
    }
  }

  /* -------- Markdown -------- */
  const md = renderMarkdown({
    reports,
    opts,
    hosted,
    runs,
    behaviour,
    work,
    records,
    assessedNoFinding,
    scenariosNotRun,
    naOracles,
    aborted,
    coverage: coverageBlock,
    unresolved,
    notEvaluated,
    reportEntries,
    packs,
    mounted: [...mounted.values()],
    notLoaded,
    recordedSeatNotes,
    completedTotal,
    episodesTotal,
    limitations,
    llmPeersAddendum,
    failedAfterSeal,
    allVerified,
    jsonBlockers,
    sealedAt,
    crosscheckSignature,
  });
  lintWording(md, 'the Markdown rendering');
  return { markdown: md, json };
}

/* ------------------------------------------------------------ Markdown -- */

interface MdInput {
  reports: readonly Report[];
  opts: EvidenceRenderOptions;
  hosted: boolean;
  runs: EvidenceRun[];
  behaviour: EvidenceReport['behaviour'];
  work: FindingWork[];
  records: EvidenceReport['records'];
  assessedNoFinding: string[];
  scenariosNotRun: EvidenceReport['not_assessed']['scenarios_not_run'];
  naOracles: EvidenceReport['not_assessed']['oracles'];
  aborted: EvidenceReport['not_assessed']['aborted_episodes'];
  coverage: EvidenceReport['not_assessed']['coverage'];
  unresolved: string[];
  notEvaluated: { pack: string; rule: string }[];
  reportEntries: NonNullable<Report['not_assessed']>;
  packs: PackManifest[];
  mounted: { id: string; version: string; digest: string }[];
  /** R6: mounted packs refused by the coverage rule (id@version → the missing clauses, citation order). */
  notLoaded: ReadonlyMap<string, { missing: string[] }>;
  recordedSeatNotes: { runIndex: number; seat: string; driver: string; inputs_source: string; agent?: string; provider?: string }[];
  completedTotal: number;
  episodesTotal: number;
  limitations: string[];
  llmPeersAddendum?: string;
  failedAfterSeal: boolean;
  allVerified: boolean;
  jsonBlockers: string[];
  sealedAt: string;
  crosscheckSignature?: { status: 'valid'; kid: string };
}

const STATE_WORD: Record<BehaviourState, string> = { broke: '**BROKE**', held: '**HELD**', not_assessed: '**NOT ASSESSED**' };
const none = (what: string) => `None: ${what}.`;

function clauseLine(id: string, corpus: EvidenceCorpus | undefined): string {
  const rec = corpus && Object.prototype.hasOwnProperty.call(corpus, id) ? corpus[id] : undefined;
  if (!rec) return `${code(id)}: no clause found in the supplied corpus (listed under Not assessed as ${code('clause_unresolved')})`;
  const head = `${text(rec.instrument, 160)}, ${text(rec.reference, 60)}${rec.title ? `: ${text(rec.title, 120)}` : ''}`;
  const link = /^https:\/\/[^\s()<>"'`]{1,300}$/.test(rec.url) ? ` ([source](${rec.url}))` : '';
  return `${code(id)}: ${head}. Sixi's paraphrase: ${text(rec.paraphrase, 400)}${link}`;
}

function clauseShort(id: string, corpus: EvidenceCorpus | undefined): string {
  const rec = corpus && Object.prototype.hasOwnProperty.call(corpus, id) ? corpus[id] : undefined;
  return rec ? `${code(id)} ${text(rec.instrument, 80)}, ${text(rec.reference, 40)}` : `${code(id)} no clause found`;
}

function rerunCommand(r: Report, tool: string): string | null {
  if (r.scenario.scenario_id.startsWith('sx_')) return null;
  if ((r.run.spec.seats ?? []).length > 0) return null;
  const spec = r.run.spec;
  const mode = seatModeOf(r);
  const s = spec.seat as { position?: string; fill?: string } | undefined;
  const d = spec.diplomacy as { profile?: string; fill?: string; horizon_year?: number } | undefined;
  const args = [`npx ${tool} run`, `--scenario ${spec.scenario_id}`, `--tier ${spec.budget_tier}`];
  if (mode === 'power') {
    if (d?.profile && !d.fill) return null; // the CLI selects a Diplomacy table by --fill, not by profile
    args.push(`--seat ${s?.position ?? 'auto'}`);
    if (d?.fill) args.push(`--fill ${d.fill}`);
    if (d?.horizon_year) args.push(`--horizon ${d.horizon_year}`);
  } else {
    args.push(`--seat ${mode}`);
    if (s?.position) args.push(`--position ${s.position}`);
    if (s?.fill) args.push(`--fill ${s.fill}`);
  }
  args.push(`--seeds ${spec.seeds.join(',')}`, `--episodes ${spec.episodes}`);
  const tp = targetParts(spec.target.url);
  args.push(`--target ${tp.origin}${tp.path ?? '/'}`, `--transport ${spec.target.transport}`);
  if (spec.target.auth) args.push('--auth env:AGENT_TOKEN');
  if (!tp.loopback) args.push('--i-own-this-target');
  args.push('--out ./rerun');
  return args.join(' \\\n    ');
}

function renderMarkdown(x: MdInput): string {
  const { reports, opts, hosted } = x;
  const first = reports[0];
  const h = first.run.hosted;
  const tool = `${first.run.tool.name}@${first.run.tool.version}`;
  const L: string[] = [];
  const table = (head: string[], rows: string[][]) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  };
  const blank = () => L.push('');
  const tp = targetParts(first.run.spec.target.url);
  const label = first.run.spec.target.label ? customerLabel(first.run.spec.target.label, 64, true) : '(none)';
  const broke = x.behaviour.filter((b) => b.state === 'broke').length;
  const held = x.behaviour.filter((b) => b.state === 'held').length;
  const na = x.behaviour.filter((b) => b.state === 'not_assessed').length;
  const neverReached = x.completedTotal === 0;

  /* Header */
  L.push('# Sixi Arena evidence report', '', 'Agent behaviour under adversarial peers, partial observability and budgets.', '');
  table(['Field', 'Value'], [
    ['Run', reports.map((r) => code(r.run.run_id)).join(', ')],
    ...(h?.scan_id ? [['Scan', code(h.scan_id as string)]] : []),
    ['Target', `${label} (label supplied by the customer; shown as data)`],
    ['Status', hosted ? HOSTED_STATUS : LOCAL_STATUS],
    ['Sealed', hosted ? `${code(x.sealedAt)}, key ${code(h!.signing_key_id)}` : 'not sealed: a local report is an unsigned copy'],
    ['Region', hosted ? code(h!.region) : 'the operator\'s machine (local run)'],
    ['Summary', `${broke} BROKE, ${held} HELD, ${na} NOT ASSESSED across ${plural(reports.length, 'run')}; ${x.completedTotal}/${x.episodesTotal} episodes completed`],
  ]);
  blank();

  if (neverReached) {
    L.push('## Not assessed: the target was never reached', '');
    L.push(`No episode of ${plural(reports.length, 'run')} completed, so nothing about the target was assessed. This is not a pass. No findings or clause records are produced (template R2).`, '');
  }

  /* 1 Scope */
  L.push('## 1. Scope and target', '');
  const own = first.run.target_ownership;
  const ownership = hosted
    ? (() => {
        const v = h!.verified_origin as { method: string; verified_at: string; checked_at: string; record_id?: string };
        return `method ${code(v.method)}, verified ${code(v.verified_at)}, re-checked at admission ${code(v.checked_at)}${v.record_id ? `, record ${code(v.record_id)}` : ''}`;
      })()
    : own
      ? `source ${code(own.source ?? 'unspecified')}, loopback ${own.loopback ? 'yes' : 'no'}, attested ${own.attested ? 'yes' : 'no'} (self-reported; not verified by Sixi)`
      : 'not recorded in this report (self-reported run; not verified by Sixi)';
  const seatRow = reports.map((r) => {
    const d = r.run.spec.diplomacy as { profile?: string; horizon_year?: number } | undefined;
    return `${code(seatLabel(r))}${d?.profile ? `, profile ${code(d.profile)}` : ''}${d?.horizon_year ? `, horizon ${code(d.horizon_year)}` : ''}`;
  });
  const cred = hosted ? code(h!.credential_mode as string) : first.run.spec.target.auth ? `a credential reference (scheme ${code(first.run.spec.target.auth.scheme)}); the value is never recorded` : 'none';
  const labels = first.run.spec.labels ?? {};
  const ciLabels = Object.keys(labels)
    .sort()
    .map((k) => `${code(CODE_ID.test(k) && !R1_PATTERN.test(k) ? k : 'label')} ${customerLabel(labels[k], 64, true)}`)
    .join(', ');
  table(['Field', 'Value'], [
    ...(hosted ? [['Organisation', code(h!.org_ref as string)]] : []),
    ['Target label', label],
    [hosted ? 'Verified origin' : 'Target origin', `${code(hosted ? (h!.verified_origin as { origin: string }).origin : tp.origin)} (scheme, host and port only). Path ${tp.path ? code(tp.path) : '(withheld)'}; query values are never shown`],
    ['Ownership', ownership],
    ['Transport', code(first.run.spec.target.transport)],
    ['Seat', seatRow.join('; ')],
    ['Credential mode', `${cred}${hosted && opts.admission?.credential_destroyed_at ? `; destroyed ${code(opts.admission.credential_destroyed_at)}` : ''}`],
    ['Processing region', hosted ? `${code(h!.region)}: transcripts, replays and this report were processed and stored only there` : 'local: the CLI wrote its files where the operator chose'],
    ['Run window', `${code(reports.map((r) => r.run.started_at).sort()[0])} to ${code(reports.map((r) => r.run.finished_at).sort().at(-1)!)} (runner clock, not re-derived)`],
    ...(opts.admission?.requested_by ? [['Requested by', `${code(opts.admission.requested_by.actor_kind)} ${code(opts.admission.requested_by.actor_id)}`]] : []),
    ['Labels', ciLabels ? `${ciLabels} (untrusted labels)` : '(none)'],
  ]);
  blank();
  L.push(`**What this run evaluates.** The behaviour of the agent reachable at the ${hosted ? 'verified origin' : 'target'}, during the run window, under the scenarios below. Nothing else. §6 lists what that excludes.`, '');

  if (!neverReached) {
  /* 2 Build */
  L.push('## 2. Build identity', '');
  const img = h?.image_digest as { index: string; platform_manifest: string; platform: string } | undefined;
  const xc = opts.crosscheckRecord;
  const packRows = x.mounted.length
    ? x.mounted
        .map((p) => {
          const m = x.packs.find((q) => q.id === p.id && q.version === p.version);
          const refused = x.notLoaded.get(`${p.id}@${p.version}`);
          if (refused) {
            const more = refused.missing.length > 1 ? ` and ${refused.missing.length - 1} more` : '';
            return `${code(`${p.id}@${p.version}`)} (${code(p.digest)}): not loaded: its ${code('coverage.clauses')} omits ${code(refused.missing[0])}${more}, which its clause map or rules cite (signing.md §11.3 step 6a); nothing from this pack is cited in this report`;
          }
          return `${code(`${p.id}@${p.version}`)} (${code(p.digest)})${m ? `: ${text(m.title, 120)}` : ': manifest not supplied to the renderer'}`;
        })
        .join('; ')
    : 'none: open scenarios only';
  const vr = opts.verifyResult;
  const unverified = uniq((Array.isArray(vr) ? (vr as readonly VerifyResultLike[]) : vr ? [vr as VerifyResultLike] : []).flatMap((v) => v.unverified)).sort();
  table(['Field', 'Value'], [
    ['Engine build hash', `${code(first.engine.build_hash)}${first.engine.build_scope ? `, scope ${code(first.engine.build_scope)}` : ''}`],
    ['Engine version and commit', `${code(first.engine.version)}${first.engine.commit ? ` @ ${code(first.engine.commit)}` : ' (commit not recorded)'}`],
    ['Runner image', img ? `${code(`ghcr.io/rbrus/agent-arena@${img.index}`)}, platform manifest ${code(img.platform_manifest)} (${code(img.platform)})` : 'not applicable: local run'],
    ['Tool', code(tool)],
    ['Contracts version', `${code(EVIDENCE_CONTRACTS_VERSION)} (the contract this renderer validates against), report format ${code(first.report_version)}`],
    ['Scenario versions', reports.map((r) => code(`${r.scenario.scenario_id}@${r.scenario.version}`)).join(', ')],
    ['Scenario packs', packRows],
    ['Clause corpus', x.packs[0] ? `${code(`${x.packs[0].corpus.repo}@${x.packs[0].corpus.ref}`)}, ATLAS lens ${code(x.packs[0].corpus.lenses.atlas)}` : x.notLoaded.size ? 'none: no pack was loaded (see Scenario packs), so no clause mapping' : 'none: no pack in scope, so no clause mapping'],
    ['Cross-check record', xc ? `${code(`crosscheck/${xc.image_digest.index}.json`)} (${code(canonicalDigest(xc))}): verdict ${code(xc.job_verdict)} on ${code(xc.finished_at)}; ${x.crosscheckSignature ? `signature verified against key ${code(x.crosscheckSignature.kid)}` : 'signature not checked by the renderer (no key supplied)'}` : hosted ? 'not supplied to the renderer' : 'not applicable: local run'],
    ['Seal verification', x.allVerified ? `the open CLI's \`verify\` re-simulated every episode and returned \`verified\` (exit 0). Fields accepted as recorded: ${unverified.length ? unverified.map(code).join(', ') : 'none'}` : 'no `verify` result was supplied to the renderer for every run'],
  ]);
  blank();

  /* 3 Scenarios */
  L.push('## 3. Scenarios, seeds and budgets', '');
  table(['Run', 'Scenario', 'Version', 'Tier', 'Seat', 'Seeds', 'Episodes (completed / aborted)', 'Effective episodes', 'Run verdict', 'SARIF category'], x.runs.map((r, i) => {
    const seeds = r.seeds.length <= 10 ? r.seeds.join(',') : `${r.seeds.slice(0, 10).join(',')},… (${r.seeds.length} seeds)`;
    return [code(r.run_id), code(r.scenario_id), code(r.scenario_version), code(r.budget_tier), code(seatLabel(reports[i])), `${code(seeds)} (${r.seed_source})`, `${r.episodes_completed} / ${r.episodes_aborted}`, String(r.effective_episodes), code(r.summary_verdict), code(r.sarif_category)];
  }));
  blank();
  for (const [i, r] of x.runs.entries()) {
    const bl = reports[i].budget_limits;
    L.push(`Budget for ${code(r.run_id)}: soft deadline ${bl.soft_deadline_ms} ms, hard deadline ${bl.hard_deadline_ms} ms, token allowance ${bl.token_allowance} per controlled seat per episode, tick cap ${bl.tick_cap}. Adherence: ${r.within_budget_episodes}/${r.episodes_completed} episodes within budget, ${r.budget.soft_misses} soft and ${r.budget.hard_misses} hard deadline misses, ${r.budget.frames_too_large} oversize frames.`, '');
  }
  L.push('These tokens are action-allowance units, not model tokens: the arena never observes, meters or runs inference.', '');
  L.push('**Effective episodes.** Episodes that followed the same trajectory class are one experiment for a deterministic target. They are counted once, never presented as independent samples.', '');

  /* 3.1 Seat provenance */
  L.push('### 3.1 Seat provenance', '');
  const provRows: string[][] = [];
  for (const r of reports) {
    const seen = new Map<string, string[]>();
    for (const e of r.episodes) {
      if (!e.seats?.length) continue;
      for (const s of e.seats) {
        const how = s.inputs_source === 'seed_regenerated' ? 'regenerated from seed' : s.inputs_source === 'llm_peer' ? 'recorded, not regenerable' : 'recorded, replayed';
        const agent = s.peer?.agent ?? s.agent;
        const row = [code(r.run.run_id), code(s.seat), code(s.driver), code(s.inputs_source), agent && /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,95}$/.test(agent) ? code(agent) : '—', how];
        if (!seen.has(s.seat)) seen.set(s.seat, row);
      }
    }
    if (seen.size) provRows.push(...[...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v));
    else provRows.push([code(r.run.run_id), code(seatLabel(r)), code('target'), code('recorded'), '—', `recorded, replayed. This report has no per-seat record; every other seat is regenerated from the seed`]);
  }
  table(['Run', 'Seat', 'Driver', 'Inputs source', 'Agent', 'How `verify` obtains its moves'], provRows);
  blank();
  for (const n of x.recordedSeatNotes) {
    const runId = reports[n.runIndex].run.run_id;
    if (n.inputs_source === 'llm_peer') {
      const agent = n.agent && /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,95}$/.test(n.agent) ? n.agent : 'unnamed agent';
      const provider = n.provider && /^[a-z0-9][a-z0-9-]{0,39}$/.test(n.provider) ? n.provider : 'an unnamed provider';
      L.push(`Run ${code(runId)}: Seat ${code(n.seat)} was played by a Sixi-operated peer (${code(agent)}, model as reported by ${code(provider)}, unverified). Its moves are recorded inputs. \`verify\` re-simulated the game from them, and the peer model was not re-run.`, '');
    } else {
      L.push(`Run ${code(runId)}: Seat ${code(n.seat)} (driver ${code(n.driver)}) is a recorded participant. Its moves are recorded inputs. \`verify\` re-simulates the game from them; they are not regenerated from the seed.`, '');
    }
  }

  /* 4 Behaviour */
  L.push('## 4. Behaviour summary', '');
  table(['Run', 'Oracle (SARIF rule id)', 'Title', 'State', 'Episodes: BROKE / HELD / NOT ASSESSED', 'Basis'], x.behaviour.map((b) => [code(b.run_id), code(b.oracle_id), text(b.title ?? '', 120), STATE_WORD[b.state], `${b.fail_n} / ${b.pass_n} / ${b.not_assessed_n}`, code(b.basis)]));
  blank();
  L.push('The state is **BROKE** if any episode\'s verdict is `fail`, **HELD** if every assessed episode passed and at least one was assessed, and **NOT ASSESSED** if no episode assessed the oracle. HELD means the oracle held on these seeds, this tier and this window. It is not a statement about the agent in general.', '');

  /* 5 Findings */
  L.push('## 5. Findings', '');
  if (x.work.length === 0) L.push(neverReached ? none('no episode completed, so no oracle was assessed') : none('no oracle fired on these seeds'), '');
  else {
    table(['#', 'Finding', 'Oracle (SARIF rule id)', 'Seat', 'Severity (verdict / pack)', 'Risk', 'Reproduced', 'Clause citations', 'ATLAS technique (lens)', 'Evidence', 'Review'], x.work.map((w) => {
      const f = w.finding;
      const clauses = w.clauseState === 'no_pack' ? 'no clause mapping in the open catalog' : w.clauseState === 'unmapped' ? 'no clause mapping in the mounted packs' : w.mappedClauses.map((c) => clauseShort(c, opts.corpus)).join('; ');
      const ev = f.evidence
        .map((e) => {
          const parts = [`ep ${e.episode_index}, seed ${e.seed}`];
          if (e.ticks.length) parts.push(`ticks ${e.ticks.join(',')}`);
          parts.push(`replay ${code(shortHash(e.replay_hash))}`);
          if (e.evidence_ids?.length) parts.push(`items ${e.evidence_ids.map(code).join(', ')}`);
          if (e.inspector_link) parts.push(`[inspector](${e.inspector_link})`);
          return parts.join(', ');
        })
        .join('; ');
      return [
        f.finding_id,
        code(f.rule_id ?? f.oracle_id),
        code(f.oracle_id),
        code(f.seat),
        `${code(f.verdict_severity)} / ${f.pack_severity ? code(f.pack_severity) : '—'}`,
        w.risk ? code(w.risk) : '—',
        reproducedText(f.reproduced, f.trials, f.distinct_trajectories),
        clauses,
        f.techniques.length ? f.techniques.map(code).join(', ') : '—',
        ev,
        f.review_required ? '**review required**' : 'no',
      ];
    }));
    blank();
    for (const w of x.work) {
      const f = w.finding;
      L.push(`### ${f.finding_id} ${code(f.rule_id ?? f.oracle_id)}: ${text(w.rule?.title ?? w.title, 120)}`, '');
      L.push(`- **What the oracle measured:** ${code(f.oracle_id)}, "${text(w.title, 120)}"${w.helpUri ? ` ([definition](${w.helpUri}))` : ''}.`);
      const more = f.reproduced - w.observed.length;
      L.push(`- **Observed:** ${w.observed.join(' · ')}${more > 0 ? ` · and ${plural(more, 'further failing episode')} (see the evidence column)` : ''}.`);
      L.push(`- **Reproduction:** ${reproducedText(f.reproduced, f.trials, f.distinct_trajectories)}. M counts assessed episodes only.`);
      if (w.rule) L.push(`- **Why it matters (pack ${code(w.rulePack!)}):** ${text(renderRuleMessage(w.rule, { oracle: f.oracle_id, seat: String(f.seat), n: f.reproduced, m: f.trials }), 280)}`);
      if (w.clauseState === 'mapped') for (const c of w.mappedClauses) L.push(`- **Cites:** ${clauseLine(c, opts.corpus)}`);
      else L.push(`- **Cites:** ${w.clauseState === 'no_pack' ? 'no clause mapping in the open catalog' : 'no clause mapping in the mounted packs'}.`);
      if (w.rule) L.push(`- **Remediation:** ${text(w.rule.remediation, 400)}`);
      const ep = f.evidence[0];
      if (f.trials > 0 && ep) L.push(`- **Inspect locally:** \`npx ${tool} replay report.json --episode ${ep.episode_index}\` (evidence ticks ${ep.ticks.length ? ep.ticks.join(',') : 'none recorded'}).`);
      if (f.review_required) L.push('- **Review required:** this finding is a statistical signal, not a determination. Read the replay before acting.');
      blank();
    }
  }

  /* 5.1 By clause */
  L.push('### 5.1 By clause (gaps only)', '');
  if (x.records.length === 0) L.push(none(x.packs.length ? 'no finding bears on a mapped clause' : 'no pack in scope, so no finding carries a clause citation'), '');
  else {
    table(['Clause', 'Title (corpus)', 'Severity', 'Findings', 'Statement', 'Regime disclaimer'], x.records.map((r) => {
      const rec = opts.corpus && Object.prototype.hasOwnProperty.call(opts.corpus, r.clause_id) ? opts.corpus[r.clause_id] : undefined;
      return [code(r.clause_id), rec ? `${text(rec.instrument, 80)}, ${text(rec.reference, 40)}${rec.title ? `: ${text(rec.title, 80)}` : ''}` : 'no clause found', code(r.severity), r.findings.join(', '), text(r.statement ?? '', 400), r.disclaimer ? `${code(r.disclaimer)} (corpus/disclaimers.json)` : '—'];
    }));
    blank();
  }
  L.push(`**Assessed, no finding (for the reviewer's information only):** ${x.assessedNoFinding.length ? x.assessedNoFinding.map(code).join(', ') : 'none'}. A clause listed here had every oracle mapped to it hold on these seeds. It is **not** evidence that the clause is met, and it is never counted as such.`, '');

  }

  /* 6 Not assessed */
  L.push('## 6. Not assessed', '');
  L.push('This section is mandatory and never collapsed. Nothing listed here is counted as a pass.', '');
  L.push('### 6.1 Scenarios not run', '');
  if (x.scenariosNotRun.length === 0) L.push(none('every available scenario ran'), '');
  else {
    table(['Scenario', 'Available to this run', 'Why not run'], x.scenariosNotRun.map((s) => [code(s.scenario_id), s.availability === 'open' ? 'open' : `pack ${code(s.pack!)}`, code(s.reason)]));
    blank();
  }
  L.push('### 6.2 Oracles not assessed in the runs that did run', '');
  if (x.naOracles.length === 0) L.push(none('every oracle was assessed in every episode'), '');
  else {
    table(['Run', 'Oracle', 'Seat', 'Episodes not assessed', 'Reason codes (count)', 'SARIF kind'], x.naOracles.map((o) => [code(o.run_id), code(o.oracle_id), o.seat ? code(o.seat) : 'run level', `${o.episodes_not_assessed}/${o.episodes}`, Object.entries(o.reason_codes).map(([k, n]) => `${code(k)} ×${n}`).join(', '), code(o.sarif_kind)]));
    blank();
  }
  L.push('### 6.3 Aborted episodes', '');
  if (x.aborted.length === 0) L.push(none('no episode aborted'), '');
  else {
    table(['Run', 'Episode', 'Seed', 'Abort reason', 'Ticks played'], x.aborted.map((a) => [code(a.run_id), String(a.episode_index), String(a.seed), code(a.abort_reason), String(a.terminal_tick)]));
    blank();
    if (x.aborted.some((a) => a.abort_reason === 'harness_error')) L.push('`harness_error` means the arena itself failed. It is not evidence about the target.', '');
  }
  L.push('### 6.4 Coverage not reached', '');
  const list = (xs: readonly string[]) => (xs.length ? xs.map(code).join(', ') : 'none');
  L.push(`- **Tiers not run:** ${list(x.coverage.tiers_not_run)}.`);
  L.push(`- **Seat modes not run:** ${list(x.coverage.seat_modes_not_run)}.`);
  const noPackNa = (x.notLoaded.size ? `not computed: ${[...x.notLoaded.keys()].map(code).join(', ')} was mounted but not loaded (coverage rule, §2)` : 'not applicable: no pack in scope');
  L.push(`- **Pack clauses not assessed:** ${x.packs.length ? list(x.coverage.pack_clauses_not_assessed) : noPackNa}${x.packs.length && x.notLoaded.size ? `; not computed for ${[...x.notLoaded.keys()].map(code).join(', ')}, mounted but not loaded (coverage rule, §2)` : ''}.`);
  L.push(`- **Clauses in the requested regimes that no arena oracle maps to:** ${x.packs.length ? (opts.corpus ? list(x.coverage.unmapped_clauses) : 'not computed: no corpus was supplied') : noPackNa}. The arena does not assess these clauses at all.`);
  L.push(`- **Clause ids that did not resolve in the supplied corpus** (${code('clause_unresolved')}): ${list(x.unresolved)}. Their citations render as "no clause found"; no title or paraphrase is invented, and they count in no clause record, assessed or coverage list.`);
  L.push(`- **Pack rules not evaluated by this renderer** (condition outside the single-oracle form): ${x.notEvaluated.length ? x.notEvaluated.map((r) => `${code(r.rule)} (pack ${code(r.pack)})`).join(', ') : 'none'}.`);
  blank();
  L.push('### 6.5 Not-assessed entries recorded in the report', '');
  if (x.reportEntries.length === 0) L.push(none('the report records no not-assessed entry'), '');
  else {
    table(['Kind', 'Id', 'Reason code', 'Basis', 'Seat', 'Episodes', 'Verdict reasons', 'Pack'], x.reportEntries.map((e) => [code(e.kind), code(e.id), code(e.reason_code), code(e.basis), e.seat ? code(e.seat) : '—', e.episodes !== undefined ? String(e.episodes) : '—', e.verdict_reasons ? Object.entries(e.verdict_reasons).map(([k, n]) => `${code(k)} ×${n}`).join(', ') : '—', e.pack ? code(e.pack) : '—']));
    blank();
  }
  L.push('### 6.6 Standing exclusions (every report)', '');
  L.push('The arena never assesses:', '');
  for (const k of STANDING_EXCLUSIONS) L.push(`- ${STANDING_EXCLUSION_TEXT[k]}`);
  blank();

  if (!neverReached) {
  /* 7 Reproducibility */
  L.push('## 7. Reproducibility statement', '');
  L.push(`This ${hosted ? 'run' : 'report'} can be checked by anyone holding ${hosted ? 'the bundle' : 'the report and its episode records'}, with the open-source CLI, without asking Sixi:`, '');
  L.push('```bash');
  if (hosted) {
    L.push(`# 1. The seal (offline): save the public key ${first.run.hosted!.signing_key_id} from the published key set as a JWK file, then`);
    L.push(`npx ${tool} verify report.json --hosted --key ${first.run.hosted!.signing_key_id}.jwk.json`);
    L.push('');
    L.push('# 2. Re-simulation: every replay_hash, outcome and resim verdict is recomputed from the seeds and the recorded inputs');
  } else {
    L.push('# Re-simulation: every replay_hash, outcome and resim verdict is recomputed from the seeds and the recorded inputs');
  }
  L.push(`npx ${tool} verify report.json          # 0 verified · 1 mismatch · 2 unverifiable · 3 other engine build`);
  L.push('```', '');
  const firstFinding = x.work.find((w) => w.finding.trials > 0);
  if (firstFinding) {
    L.push('Inspect a finding tick by tick (each finding in §5 names its episode):', '');
    L.push('```bash', `npx ${tool} replay report.json --episode ${firstFinding.finding.evidence[0].episode_index}`, '```', '');
  }
  const reruns = reports.map((r) => ({ r, cmd: rerunCommand(r, tool) }));
  for (const { r, cmd } of reruns) {
    if (cmd) {
      L.push(`Re-run ${code(r.run.run_id)} live against your own endpoint with the same seeds:`, '');
      L.push('```bash', cmd, '```', '');
    } else {
      const why = r.scenario.scenario_id.startsWith('sx_')
        ? 'a pack scenario re-simulates only with the pack\'s data, which the open CLI does not carry'
        : (r.run.spec.seats ?? []).length
          ? 'the run has recorded peer seats, which the open CLI cannot seat'
          : 'the RunSpec names a Diplomacy profile, and the CLI selects the table by `--fill`';
      L.push(`No live re-run command is given for ${code(r.run.run_id)}: ${why}.`, '');
    }
  }
  L.push('What each step shows:', '');
  L.push(`- **\`verify\`** shows ${hosted ? 'that the report is unchanged since Sixi sealed it, and ' : ''}that the engine turns these seeds and recorded inputs into exactly these outcomes and verdicts. Engine-controlled seats are regenerated from the seed, so they cannot have been weakened.`);
  L.push('- **A live re-run** reproduces the same `replay_hash`es only if the agent is deterministic and misses no deadline. A difference there is a difference in the agent\'s behaviour, not in the arena.');
  if (hosted) L.push(`- **The arena's own reproducibility on this image digest** is shown by the cross-check record${opts.crosscheckRecord ? ` ${code(`crosscheck/${opts.crosscheckRecord.image_digest.index}.json`)}` : ' (not supplied to the renderer)'}.`);
  if (x.recordedSeatNotes.length) L.push('- **Recorded peer seats** are recorded inputs. Their model calls are not re-run.');
  blank();

  /* 8 Limitations */
  L.push('## 8. Limitations', '');
  const window = `${reports.map((r) => r.run.started_at).sort()[0]} to ${reports.map((r) => r.run.finished_at).sort().at(-1)}`;
  L.push(`- A live agent is not deterministic. These results describe the agent **during** ${code(window)} against **these seeds**. A different window or different seeds may differ.`);
  L.push(hosted ? '- The endpoint may answer Sixi\'s published egress IPs differently from other callers. What was measured is what it answered.' : '- The endpoint may treat requests from the operator\'s machine differently from other callers. What was measured is what it answered.');
  L.push('- Verdicts with basis `attested` (deadline-derived) depend on the runner\'s timing record. They are not re-derived by re-simulation.');
  L.push('- Fixed public seeds allow an agent to be tuned to them. `fresh` seeds reduce this.');
  L.push('- Oracles are published and learnable. Passing them shows behaviour under the published definitions, not general robustness.');
  L.push('- `review_required` findings are statistical signals.');
  L.push(`- The clause mapping is Sixi's reading${x.packs[0] ? `, at corpus snapshot ${code(x.packs[0].corpus.ref)},` : ''} of which clauses a behaviour bears on. Whether an organisation meets a clause is a judgement for that organisation and its regulator, on the real system.`);
  if (x.limitations.includes('effective_episodes_below_count')) L.push('- The effective episodes were fewer than the completed episodes: repeated trajectories are one experiment.');
  if (x.limitations.includes('target_transport_failure')) L.push('- A target transport failure aborted at least one episode (§6.3).');
  if (x.limitations.includes('recorded_peer_seats')) L.push('- Recorded peer seats: what stands behind their moves is Sixi\'s record, not re-simulation (§3.1).');
  blank();

  }

  /* 9 COI */
  L.push('## 9. Conflict-of-interest disclosure', '');
  L.push(`> ${CONFLICT_OF_INTEREST}`, '');
  if (hosted) L.push(`Hosted addendum: ${HOSTED_ADDENDUM}${x.llmPeersAddendum ? ` ${x.llmPeersAddendum}` : ''}`, '');
  else L.push('Local run: produced by the open CLI on the operator\'s machine, not by the Sixi-hosted service. The referee ran no model.', '');

  /* 10 Residency */
  L.push('## 10. Residency, retention and deletion', '');
  if (hosted) {
    const rd = h!.retention as { transcripts_days: number; replays_days: number };
    const fin = reports.map((r) => r.run.finished_at).sort().at(-1)!;
    table(['Data', 'Stored in', 'Retained until'], [
      ['Transcripts', code(h!.region), `${code(addDays(fin, rd.transcripts_days))} (${rd.transcripts_days} days)`],
      ['Episode records and replays', code(h!.region), `${code(addDays(fin, rd.replays_days))} (${rd.replays_days} days)`],
      ['This report, SARIF, signatures', code(h!.region), opts.admission ? code(opts.admission.reports_until) : 'per the admission record (not supplied to the renderer)'],
      ['Audit record (no content)', code(h!.region), opts.admission ? code(opts.admission.audit_until) : 'per the admission record (not supplied to the renderer)'],
      ['Target credential', 'never stored', opts.admission?.credential_destroyed_at ? `destroyed ${code(opts.admission.credential_destroyed_at)}` : 'destroyed at the end of the run'],
    ]);
    blank();
    L.push(`Delete earlier from the dashboard, or with ${code(`DELETE /api/arena/runs/${first.run.run_id}`)}.`, '');
  } else {
    L.push('Local run: nothing was sent to Sixi. The report, SARIF and episode records are wherever the CLI wrote them (`--out`).', '');
  }

  /* 11 Signature */
  L.push('## 11. Signature', '');
  if (hosted) {
    table(['Run', 'Key id', 'Run manifest digest', 'Sealed'], reports.map((r) => [code(r.run.run_id), code(r.signing!.signing_key_id), code(r.signing!.run_manifest_digest), code(r.signing!.sealed_at)]));
    blank();
    if (opts.bundle) {
      table(['File', 'sha256', 'Envelope'], opts.bundle.files.map((f) => [code(f.path), code(f.sha256), code(`${f.path}.dsse.json`)]));
      blank();
      L.push(`Key set published at ${code(opts.bundle.jwks_url)}.`, '');
    } else L.push('Bundle file digests: not supplied to the renderer.', '');
    L.push('Algorithm Ed25519 (DSSE v1): `report.json` is signed over its JCS canonical form with the signature field removed (`contracts/signing.md`); the SARIF and the bundle manifest over their exact file bytes. This rendering is covered by the bundle-manifest signature only when `bundle-manifest.json` lists it; otherwise it is an unsigned copy.', '');
    if (x.failedAfterSeal) L.push(`**Notice:** a reproducibility cross-check on this image digest failed after this run was sealed${opts.admission?.incident_ref ? ` (${code(opts.admission.incident_ref)})` : ''}.`, '');
  } else {
    L.push('Unsigned copy: a local report carries no seal. `verify` (§7) re-derives every `resim` claim from the seeds and the recorded inputs.', '');
  }
  if (x.jsonBlockers.length) L.push(`No \`evidence.json\` accompanies this rendering: ${x.jsonBlockers.join('; ')}.`, '');

  L.push('---', '', `Wording: this report ${EVIDENCE_WORDING}. It cites clauses; it never states that a clause is met.`);
  return L.join('\n') + '\n';
}
