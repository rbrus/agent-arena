/**
 * `toSarif`: Report → one SARIF 2.1.0 log, per contracts/sarif-mapping.md.
 * A pure function of the Report: the same Report always renders the same
 * bytes. No target-originated text is emitted anywhere: `message.text` is a
 * template filled with engine values, plus the oracle-templated
 * `evidence_ref.message`, which is re-sanitised here anyway (the Report is a
 * file that can be edited before it is rendered). `target.url`,
 * `target.auth`, `target.label` and `labels` are never emitted.
 */

import { sha256Hex } from './canonical.ts';
import { NOT_APPLICABLE_REASONS, runReplayHash } from './build.ts';
import { TOOL_INFORMATION_URI } from './catalog.ts';
import { sanitizeForReport } from './sanitize.ts';
import type { CatalogOracle, Report, SarifKind, SarifLevel, SarifLog, SarifResult, SarifRule, Severity, Verdict } from './types.ts';

export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';

export interface ToSarifOptions {
  /** Emit pass verdicts as `kind: pass` results (`--sarif-include-passes`). Default false. */
  includePasses?: boolean;
  /** The RunSpec file as a repo-relative path (CLI `--spec`). Default `.agent-arena/<scenario_id>.run.json`. */
  specPath?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, note: 1 };
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_SPEC_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;
/** sarif-mapping.md §4: `evidence_ids` keeps only ids in engine id syntax (message, order, intent, commitment, canary ids). */
export const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_:./#-]{0,79}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const RISKS: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low']);
/** sarif-mapping.md §4: the fixed last sentence of a review-required fail. */
export const REVIEW_SENTENCE = 'Review required: statistical signal, not proof; inspect the replay before acting.';

function mostSevere(severities: readonly Severity[]): Severity {
  return [...severities].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0] ?? 'note';
}

function rule(report: Report, o: CatalogOracle): SarifRule {
  const tags = ['agent-arena', report.scenario.scenario_id];
  if (report.scenario.failure_mode_id) tags.push(report.scenario.failure_mode_id);
  const review = o.review_required === true;
  if (review) tags.push('review-required');
  // §2 member order: basis, level, primary, risk, review_required.
  const agentArena: SarifRule['properties']['agentArena'] = { basis: o.basis, level: o.level, primary: o.primary === true };
  if (o.risk && RISKS.has(o.risk)) agentArena.risk = o.risk;
  if (review) agentArena.review_required = true;
  const r: SarifRule = {
    id: o.oracle_id,
    name: o.oracle_id.replace('.', '/'),
    shortDescription: { text: sanitizeForReport(o.title, { maxLength: 120, escapeMarkdown: false }) },
    defaultConfiguration: { level: mostSevere(o.severities) },
    properties: {
      tags,
      // A review-required rule is a statistical signal, not a determination: medium whatever its basis (§2).
      precision: review ? 'medium' : o.basis === 'resim' ? 'very-high' : 'high',
      agentArena,
    },
  };
  if (o.help_uri && /^https:\/\/github\.com\/rbrus\/agent-arena\//.test(o.help_uri)) r.helpUri = o.help_uri;
  return r;
}

/** sarif-mapping.md §3. */
export function kindAndLevel(v: Verdict): { kind: SarifKind; level: SarifLevel } {
  if (v.verdict === 'fail') return { kind: 'fail', level: v.severity };
  if (v.verdict === 'pass') return { kind: 'pass', level: 'none' };
  return { kind: NOT_APPLICABLE_REASONS.has(v.reason_code ?? '') ? 'notApplicable' : 'open', level: 'none' };
}

/** The inputs that identify one finding (sarif-mapping.md §5, corrected in contracts 2.1.0). */
export interface FingerprintInput {
  ruleId: string;
  scenarioId: string;
  tier: string;
  /** EpisodeResult seat (`squad` in squad mode); the literal `run` for a run-level verdict. */
  seat: string;
  /** Episode seed in decimal; the literal `run` for a run-level verdict. */
  seed: number | 'run';
  /** replay_hash; for a run-level verdict, the sorted-episode-hash digest. */
  replayHash: string;
  /** Appended to H when the EpisodeResult carries one (diplomacy_standard). */
  transcriptHash?: string;
}

/**
 * sarif-mapping.md §5 (2.1.0):
 *   H = replay_hash [+ "|" + transcript_hash]
 *   F = sha256_hex(rule_id|scenario_id|budget_tier|seat|seed|H)
 * The seed, tier and scenario are explicit because replay_hash alone collides
 * across seeds for the duel (obstacles are not hashed), Overfit and Deadlock
 * (seed-invariant), which would merge distinct alerts on GitHub.
 */
export function fingerprint(x: FingerprintInput): { 'agentArena/v1': string; primaryLocationLineHash: string } {
  const h = x.transcriptHash ? `${x.replayHash}|${x.transcriptHash}` : x.replayHash;
  const f = sha256Hex(`${x.ruleId}|${x.scenarioId}|${x.tier}|${x.seat}|${x.seed}|${h}`);
  return { 'agentArena/v1': f, primaryLocationLineHash: `${f.slice(0, 16)}:1` };
}

function reasonOf(v: Verdict): string {
  return v.reason_code && REASON_CODE.test(v.reason_code) ? v.reason_code : 'unspecified';
}

function findingText(v: Verdict): string {
  const ev = v.evidence_ref;
  if (ev?.message) {
    const m = sanitizeForReport(ev.message, { maxLength: 280 });
    if (m) return m;
  }
  if (ev?.code && CODE.test(ev.code)) return ev.code;
  return 'see the evidence ticks in the replay';
}

/**
 * §4: the `evidence_ref.items[].id` list in item order, ids only (never an
 * item's text), filtered to engine id syntax; a Report is an editable file,
 * so anything else is dropped rather than rendered.
 */
export function evidenceIds(v: Verdict): string[] {
  const items = v.evidence_ref?.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items) {
    const id = it !== null && typeof it === 'object' ? (it as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && EVIDENCE_ID.test(id)) out.push(id);
  }
  return out;
}

interface Where {
  episodeIndex?: number;
  seed?: number;
  seat: string;
  replayHash: string;
  transcriptHash?: string;
}

function message(v: Verdict, w: Where): string {
  const scope = w.episodeIndex === undefined ? 'the run' : `episode ${w.episodeIndex} (seed ${w.seed}${v.verdict === 'fail' ? `, seat ${w.seat}` : ''})`;
  if (v.verdict === 'fail') return `${v.oracle_id} failed (${v.severity}) in ${scope}: ${findingText(v)}${v.review_required === true ? ` ${REVIEW_SENTENCE}` : ''}`;
  if (v.verdict === 'not_assessed') return `NOT ASSESSED (${reasonOf(v)}): ${v.oracle_id} in ${scope}. This is not a pass.`;
  return `${v.oracle_id} passed in ${scope}.`;
}

function result(report: Report, ruleIndex: number, v: Verdict, w: Where, specPath: string): SarifResult {
  const { kind, level } = kindAndLevel(v);
  const scenarioId = report.scenario.scenario_id;
  const fq = w.episodeIndex === undefined ? `${scenarioId}/run` : `${scenarioId}/episode/${w.episodeIndex}/seat/${w.seat}`;
  const props: Record<string, unknown> = {
    ...(w.episodeIndex !== undefined ? { episode_index: w.episodeIndex, seed: w.seed, seat: w.seat } : {}),
    verdict: v.verdict,
    basis: v.basis,
    replay_hash: w.replayHash,
  };
  // §4 member order: … replay_hash, transcript_hash?, reason_code?, measures?, thresholds?, evidence_ticks?, evidence_ids?, review_required?
  if (w.episodeIndex !== undefined && w.transcriptHash) props.transcript_hash = w.transcriptHash;
  if (v.verdict === 'not_assessed') props.reason_code = reasonOf(v);
  if (v.measures && Object.keys(v.measures).length) props.measures = { ...v.measures };
  if (v.thresholds && Object.keys(v.thresholds).length) props.thresholds = { ...v.thresholds };
  if (v.evidence_ref?.ticks.length) props.evidence_ticks = [...v.evidence_ref.ticks];
  const ids = evidenceIds(v);
  if (ids.length) props.evidence_ids = ids;
  if (v.review_required === true) props.review_required = true;
  return {
    ruleId: v.oracle_id,
    ruleIndex,
    locations: [
      {
        physicalLocation: { artifactLocation: { uri: specPath }, region: { startLine: 1 } },
        logicalLocations: [{ fullyQualifiedName: fq, kind: 'object' }],
      },
    ],
    partialFingerprints: fingerprint({
      ruleId: v.oracle_id,
      scenarioId,
      tier: report.run.spec.budget_tier,
      seat: w.episodeIndex === undefined ? 'run' : w.seat,
      seed: w.episodeIndex === undefined ? 'run' : w.seed!,
      replayHash: w.replayHash,
      ...(w.transcriptHash ? { transcriptHash: w.transcriptHash } : {}),
    }),
    kind,
    level,
    message: { text: message(v, w) },
    properties: { agentArena: props },
  };
}

/**
 * sarif-mapping.md §1.1 (contracts 2.2.0, K3). Hosted members only when the
 * Report has `run.hosted`; `not_assessed_section` and `recorded_seats` on any
 * Report that has the fields. Copied from the Report only; never `signing`,
 * `verified_origin`, `org_ref`, `scan_id`, `observed_connections`,
 * `sealed_by`, the run manifest, or an episode secret. A 2.1.0 Report renders
 * none of them, so its SARIF bytes are unchanged.
 */
export function hostedProperties(report: Report): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const h = report.run.hosted;
  if (h) {
    out.hosted = true;
    out.signing_key_id = h.signing_key_id;
    out.region = h.region;
    out.packs = h.packs.map((p) => ({ id: p.id, version: p.version, digest: p.digest }));
  }
  if (report.not_assessed) out.not_assessed_section = { entries: report.not_assessed.length, pointer: '/not_assessed' };
  const recorded = new Set<string>();
  for (const e of report.episodes) {
    for (const s of e.seats ?? []) {
      const primary = e.mode === 'squad' || s.seat === e.seat;
      if (s.driver !== 'engine' && !primary) recorded.add(s.seat);
    }
  }
  if (recorded.size) out.recorded_seats = [...recorded].sort();
  return out;
}

export function toSarif(report: Report, opts: ToSarifOptions = {}): SarifLog {
  const scenarioId = report.scenario.scenario_id;
  const specPath = opts.specPath && SAFE_SPEC_PATH.test(opts.specPath) && !opts.specPath.includes('..') ? opts.specPath : `.agent-arena/${scenarioId}.run.json`;
  const rules = report.scenario.oracles.map((o) => rule(report, o));
  const index = new Map(rules.map((r, i) => [r.id, i]));
  const emit = (v: Verdict): boolean => v.verdict !== 'pass' || opts.includePasses === true;

  const results: SarifResult[] = [];
  const notifications: NonNullable<SarifLog['runs'][0]['invocations'][0]['toolExecutionNotifications']> = [];
  let notAssessed = 0;
  for (const e of report.episodes) {
    if (e.status === 'aborted') {
      notifications.push({
        level: 'warning',
        descriptor: { id: 'agent-arena/episode-aborted' },
        message: { text: `Episode ${e.episode_index} (seed ${e.seed}) aborted: ${e.abort_reason ?? 'unknown'}. Its oracles are not assessed.` },
      });
    }
    for (const v of e.oracles) {
      if (v.verdict === 'not_assessed') notAssessed++;
      const ri = index.get(v.oracle_id);
      if (ri === undefined) throw new Error(`verdict for ${v.oracle_id} has no rule in scenario.oracles`);
      const transcriptHash = HASH.test(e.transcript_hash ?? '') ? e.transcript_hash : undefined;
      if (emit(v))
        results.push(
          result(report, ri, v, { episodeIndex: e.episode_index, seed: e.seed, seat: v.seat ?? e.seat, replayHash: e.replay_hash, ...(transcriptHash ? { transcriptHash } : {}) }, specPath),
        );
    }
  }
  const runHash = runReplayHash(report.episodes);
  for (const v of report.run_oracles) {
    if (v.verdict === 'not_assessed') notAssessed++;
    const ri = index.get(v.oracle_id);
    if (ri === undefined) throw new Error(`run verdict for ${v.oracle_id} has no rule in scenario.oracles`);
    if (emit(v)) results.push(result(report, ri, v, { seat: 'run', replayHash: runHash }, specPath));
  }

  const spec = report.run.spec;
  const seatMode = spec.seat?.mode ?? (scenarioId === 'grid_tactics' ? 'duel' : 'member');
  const gitSha = spec.labels?.git_sha;
  const disclosure = {
    conflict_of_interest: report.disclosure.conflict_of_interest,
    ...(report.disclosure.determinism ? { determinism: report.disclosure.determinism } : {}),
  };

  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: report.run.tool.name,
            semanticVersion: report.run.tool.version,
            informationUri: TOOL_INFORMATION_URI,
            rules,
            properties: { agentArena: disclosure },
          },
        },
        automationDetails: { id: `agent-arena/${scenarioId}/${spec.budget_tier}/${seatMode}/` },
        invocations: [
          {
            executionSuccessful: !report.episodes.some((e) => e.abort_reason === 'harness_error'),
            ...(notifications.length ? { toolExecutionNotifications: notifications } : {}),
          },
        ],
        results,
        properties: {
          agentArena: {
            report_version: report.report_version,
            run_id: report.run.run_id,
            engine_build_hash: report.engine.build_hash,
            scenario_id: scenarioId,
            scenario_version: report.scenario.version,
            budget_tier: spec.budget_tier,
            seat_mode: seatMode,
            verdict: report.summary.verdict,
            episodes_total: report.summary.episodes_total,
            effective_episodes: report.summary.effective_episodes,
            not_assessed: notAssessed,
            conflict_of_interest: report.disclosure.conflict_of_interest,
            ...(gitSha && /^[0-9a-f]{7,40}$/.test(gitSha) ? { revision_id: gitSha } : {}),
            ...hostedProperties(report),
          },
        },
      },
    ],
  };
}
