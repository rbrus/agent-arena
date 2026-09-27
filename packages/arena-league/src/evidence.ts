/**
 * `perModelEvidence(reports, model_id)`: the per-model evidence pack body
 * (HOSTED-PROFILE §6.6) over every table a model sat at.
 *
 * Input: perspective reports (reports.ts), i.e. reports whose PRIMARY seat is
 * a peer; the model is read from the RunSpec labels `ng.provider` / `ng.model`
 * the harness writes, never from free text. Per oracle it counts the model's
 * own verdicts across those tables: `reproduced N of M` where M counts tables
 * in which the oracle was assessed (pass or fail) and N the fails;
 * not-assessed verdicts are counted separately by reason and never as passes
 * (template R2, R5). The Markdown is arena-report's `renderEvidenceReport`
 * over those reports (one run per table), preceded by a model header.
 *
 * Naming: the provider appears only as its provider id and the model only as
 * the id the provider reported (unverified). Nothing here names a country,
 * flag or region label (the one region shown is the inference endpoint's
 * cloud region id, which the contract records as `inference_region`).
 */

import { lintWording, renderEvidenceReport, type EvidenceRenderOptions, type Report } from 'arena-report';
import type { Power } from 'wot-engine';
import type { TableRecord } from './record.ts';

export interface OracleAggregate {
  oracle_id: string;
  pass: number;
  fail: number;
  not_assessed: number;
  /** Tables where the oracle was assessed for this model (pass + fail). */
  assessed: number;
  /** `reproduced N of M`: N = fail, M = assessed. */
  reproduced: string;
  not_assessed_reasons: Record<string, number>;
}

export interface ModelTable {
  table_id: string;
  run_id: string;
  seed: number;
  power: Power;
  status: 'completed' | 'aborted';
  outcome: string;
  replay_hash: string;
  cost_chf?: number;
}

export interface ModelEvidence {
  provider_id: string;
  model_id: string;
  tables: ModelTable[];
  powers_played: Partial<Record<Power, number>>;
  oracles: OracleAggregate[];
  not_assessed_total: number;
  cost: { total_chf: number; per_game_chf: number | null; games_metered: number };
  markdown: string;
}

export interface PerModelOptions {
  /** Restrict to one provider id (a model id is only unique per provider). */
  provider_id?: string;
  /** Table records, to aggregate the model's metered cost per game. */
  records?: readonly TableRecord[];
  /** Passed through to `renderEvidenceReport` (verify results, inspector deep links). */
  render?: EvidenceRenderOptions;
}

const label = (r: Report, k: string): string | undefined => r.run.spec.labels?.[k];

export function perModelEvidence(reports: readonly Report[], model_id: string, opts: PerModelOptions = {}): ModelEvidence {
  const mine = reports.filter((r) => label(r, 'ng.model') === model_id && (opts.provider_id === undefined || label(r, 'ng.provider') === opts.provider_id));
  if (mine.length === 0) throw new Error(`no table report has model ${JSON.stringify(model_id.slice(0, 96))} at its primary seat`);
  const providers = [...new Set(mine.map((r) => label(r, 'ng.provider')))];
  if (providers.length !== 1 || !providers[0]) throw new Error(`model ${model_id} appears under several providers (${providers.join(', ')}); pass provider_id`);
  const provider_id = providers[0];

  const byId = new Map<string, OracleAggregate>();
  const tables: ModelTable[] = [];
  const powers: Partial<Record<Power, number>> = {};
  let na = 0;
  let total = 0;
  let metered = 0;
  for (const r of mine) {
    const tableId = label(r, 'ng.table') ?? r.run.run_id;
    for (const e of r.episodes) {
      const power = e.seat as Power;
      powers[power] = (powers[power] ?? 0) + 1;
      const rec = opts.records?.find((x) => x.table_id === tableId && x.seed === e.seed);
      const c = rec?.cost.by_power[power]?.chf;
      if (c !== undefined) {
        total += c;
        metered++;
      }
      tables.push({ table_id: tableId, run_id: r.run.run_id, seed: e.seed, power, status: e.status, outcome: e.outcome, replay_hash: e.replay_hash, ...(c !== undefined ? { cost_chf: c } : {}) });
      for (const v of e.oracles) {
        const a = byId.get(v.oracle_id) ?? { oracle_id: v.oracle_id, pass: 0, fail: 0, not_assessed: 0, assessed: 0, reproduced: '', not_assessed_reasons: {} };
        if (v.verdict === 'pass') a.pass++;
        else if (v.verdict === 'fail') a.fail++;
        else {
          a.not_assessed++;
          na++;
          const why = v.reason_code ?? 'unspecified';
          a.not_assessed_reasons[why] = (a.not_assessed_reasons[why] ?? 0) + 1;
        }
        byId.set(v.oracle_id, a);
      }
    }
  }
  const oracles = [...byId.values()].map((a) => ({ ...a, assessed: a.pass + a.fail, reproduced: `reproduced ${a.fail} of ${a.pass + a.fail}` }));

  const L: string[] = [];
  L.push(`# Neutral Ground: \`${provider_id}\` / \`${model_id}\``);
  L.push('');
  L.push(`Provider id \`${provider_id}\`. Model id \`${model_id}\` as reported by the provider API (unverified). Tables: ${tables.length}. The referee ran no model; the seat's moves are recorded inputs, and every other seat was re-simulated from the seed.`);
  L.push('');
  L.push('| Oracle | Result across tables | Not assessed |');
  L.push('|---|---|---|');
  for (const a of oracles) L.push(`| \`${a.oracle_id}\` | ${a.assessed === 0 ? 'not measured' : a.reproduced} | ${a.not_assessed}${a.not_assessed ? ` (${Object.entries(a.not_assessed_reasons).map(([k, n]) => `\`${k}\` ${n}`).join(', ')})` : ''} |`);
  L.push('');
  L.push('| Table | Seed | Power | Outcome | Cost (CHF) |');
  L.push('|---|---|---|---|---|');
  for (const t of tables) L.push(`| \`${t.table_id}\` | ${t.seed} | ${t.power} | ${t.outcome} | ${t.cost_chf === undefined ? 'n/a' : t.cost_chf.toFixed(4)} |`);
  L.push('');
  const header = L.join('\n');
  lintWording(header, 'per-model header');
  const body = renderEvidenceReport(mine, opts.render ?? {}).markdown;
  return {
    provider_id,
    model_id,
    tables,
    powers_played: powers,
    oracles,
    not_assessed_total: na,
    cost: { total_chf: total, per_game_chf: metered ? total / metered : null, games_metered: metered },
    markdown: `${header}\n${body}`,
  };
}
