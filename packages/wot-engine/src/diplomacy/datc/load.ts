/**
 * DATC fixture loader and runner (design §5.2). Zero dependencies: a hand
 * validator for fixture.schema.json, conversion to DipState + submissions, and
 * a runner that drives every step through the PUBLIC `adjudicate` (no
 * test-only code path) and reports every mismatch as a string.
 *
 * Extension to §5.2: `status: "todo"` marks a DATC case id that is reserved but
 * not encoded yet; it needs no setup/steps and is reported as coverage, not run.
 */

import { isProvince, provinceOf } from '../map.ts';
import { isParseError, parseOrder } from '../parse.ts';
import { adjudicate, normalise, standardCenters, RULESET } from '../state.ts';
import type { DipState, Dislodged, NodeId, PhaseKind, Power, ProvinceId, RawOrder, Season, Unit } from '../types.ts';
import { POWERS } from '../types.ts';

export type OrderEntry = string | { o: string; result?: ExpectedResult; reason?: string };
export type ExpectedResult = 'success' | 'failure' | 'void' | 'illegal' | 'superseded' | 'parse_error';

export interface FixtureUnit {
  power: Power;
  type: 'A' | 'F';
  at: NodeId;
}
export interface FixtureDislodged extends FixtureUnit {
  retreat_options?: NodeId[];
}
export interface FixtureStep {
  orders: Partial<Record<Power, OrderEntry[]>>;
  expect: {
    units_after: FixtureUnit[];
    dislodged_after?: FixtureDislodged[];
    contested_after?: ProvinceId[];
    supply_centers_after?: Record<ProvinceId, Power | null>;
    phase_after?: string;
  };
}
export interface FixtureCase {
  id: string;
  title: string;
  status: 'standard' | 'deviation' | 'informative' | 'todo';
  deviation?: { datc_expects: string; we_expect: string; why: string };
  rules?: string[];
  requires?: ('movement' | 'convoy' | 'retreat' | 'adjustment')[];
  transcription_notes?: string;
  setup?: {
    phase: string;
    units: FixtureUnit[];
    supply_centers_base?: 'standard_1901' | 'none';
    supply_centers?: Record<ProvinceId, Power | null>;
    dislodged?: (FixtureUnit & { attacker_from: ProvinceId; by_convoy: boolean; retreat_options: NodeId[] })[];
  };
  steps?: FixtureStep[];
}
export interface FixtureFile {
  datc_version: '3.0';
  section: string;
  cases: FixtureCase[];
}

// ------------------------------------------------------------------ validation

const PHASE_RE = /^[SFW][0-9]{4}[MRA]$/;
const NODE_RE = /^[a-z]{3}(\/(nc|sc|ec))?$/;
const ID_RE = /^(6\.[A-J]\.[0-9]{1,2}|X\.[A-Z]\.[0-9]{1,3})(#[0-9])?$/;
const RESULTS = ['success', 'failure', 'void', 'illegal', 'superseded', 'parse_error'];

function only(obj: object, keys: string[], where: string, errs: string[]): void {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errs.push(`${where}: unexpected key "${k}"`);
}
const isPowerStr = (v: unknown): v is Power => typeof v === 'string' && (POWERS as readonly string[]).includes(v);

function checkUnit(u: unknown, where: string, errs: string[], extra: string[] = []): void {
  if (typeof u !== 'object' || u === null) return void errs.push(`${where}: unit must be an object`);
  const x = u as Record<string, unknown>;
  only(x, ['power', 'type', 'at', ...extra], where, errs);
  if (!isPowerStr(x.power)) errs.push(`${where}: bad power`);
  if (x.type !== 'A' && x.type !== 'F') errs.push(`${where}: bad type`);
  if (typeof x.at !== 'string' || !NODE_RE.test(x.at) || !isProvince(provinceOf(x.at))) errs.push(`${where}: bad node ${String(x.at)}`);
}

/** Returns a list of schema violations (empty = valid). */
export function validateFixtureFile(v: unknown): string[] {
  const errs: string[] = [];
  if (typeof v !== 'object' || v === null) return ['file: not an object'];
  const f = v as Record<string, unknown>;
  only(f, ['datc_version', 'section', 'cases', '$comment'], 'file', errs);
  if (f.datc_version !== '3.0') errs.push('file: datc_version must be "3.0"');
  if (typeof f.section !== 'string' || !/^(6\.[A-J]|X\.[A-Z])$/.test(f.section)) errs.push('file: bad section');
  if (!Array.isArray(f.cases) || f.cases.length === 0) return [...errs, 'file: cases must be a non-empty array'];
  f.cases.forEach((c: unknown, i: number) => {
    const w = `case[${i}]`;
    if (typeof c !== 'object' || c === null) return void errs.push(`${w}: not an object`);
    const k = c as Record<string, unknown>;
    only(k, ['id', 'title', 'status', 'deviation', 'rules', 'requires', 'transcription_notes', 'setup', 'steps'], w, errs);
    if (typeof k.id !== 'string' || !ID_RE.test(k.id)) errs.push(`${w}: bad id`);
    if (typeof k.title !== 'string' || k.title.length > 120) errs.push(`${w}: bad title`);
    if (!['standard', 'deviation', 'informative', 'todo'].includes(k.status as string)) errs.push(`${w}: bad status`);
    if (k.status === 'deviation' && !k.deviation) errs.push(`${w}: deviation requires "deviation"`);
    if (k.status === 'todo') return;
    if (!Array.isArray(k.requires) || k.requires.length === 0) errs.push(`${w}: requires must be non-empty`);
    if (k.rules !== undefined && (!Array.isArray(k.rules) || k.rules.some((r) => !/^4\.[A-E]\.[0-9]$/.test(r)))) {
      errs.push(`${w}: bad rules`);
    }
    const s = k.setup as Record<string, unknown> | undefined;
    if (!s) return void errs.push(`${w}: missing setup`);
    only(s, ['phase', 'units', 'supply_centers_base', 'supply_centers', 'dislodged'], `${w}.setup`, errs);
    if (typeof s.phase !== 'string' || !PHASE_RE.test(s.phase)) errs.push(`${w}.setup: bad phase`);
    if (!Array.isArray(s.units)) errs.push(`${w}.setup: units must be an array`);
    else s.units.forEach((u, j) => checkUnit(u, `${w}.setup.units[${j}]`, errs));
    if (s.supply_centers_base !== undefined && !['standard_1901', 'none'].includes(s.supply_centers_base as string)) {
      errs.push(`${w}.setup: bad supply_centers_base`);
    }
    if (s.dislodged !== undefined) {
      (s.dislodged as unknown[]).forEach((u, j) =>
        checkUnit(u, `${w}.setup.dislodged[${j}]`, errs, ['attacker_from', 'by_convoy', 'retreat_options']),
      );
    }
    if (!Array.isArray(k.steps) || k.steps.length === 0) return void errs.push(`${w}: steps must be non-empty`);
    k.steps.forEach((st: unknown, j: number) => {
      const sw = `${w}.steps[${j}]`;
      const x = st as Record<string, unknown>;
      only(x, ['orders', 'expect'], sw, errs);
      const orders = (x.orders ?? {}) as Record<string, unknown>;
      for (const [p, list] of Object.entries(orders)) {
        if (!isPowerStr(p)) errs.push(`${sw}: bad power ${p}`);
        if (!Array.isArray(list)) {
          errs.push(`${sw}: orders.${p} must be an array`);
          continue;
        }
        list.forEach((e, n) => {
          if (typeof e === 'string') return;
          const eo = e as Record<string, unknown>;
          only(eo, ['o', 'result', 'reason'], `${sw}.orders.${p}[${n}]`, errs);
          if (typeof eo.o !== 'string' || eo.o.length > 64) errs.push(`${sw}.orders.${p}[${n}]: bad o`);
          if (eo.result !== undefined && !RESULTS.includes(eo.result as string)) errs.push(`${sw}.orders.${p}[${n}]: bad result`);
          if (eo.reason !== undefined && !/^[a-z_]+$/.test(eo.reason as string)) errs.push(`${sw}.orders.${p}[${n}]: bad reason`);
        });
      }
      const ex = x.expect as Record<string, unknown> | undefined;
      if (!ex || !Array.isArray(ex.units_after)) return void errs.push(`${sw}: expect.units_after required`);
      only(ex, ['units_after', 'dislodged_after', 'contested_after', 'supply_centers_after', 'phase_after'], `${sw}.expect`, errs);
      ex.units_after.forEach((u, n) => checkUnit(u, `${sw}.units_after[${n}]`, errs));
      if (ex.dislodged_after !== undefined) {
        (ex.dislodged_after as unknown[]).forEach((u, n) => checkUnit(u, `${sw}.dislodged_after[${n}]`, errs, ['retreat_options']));
      }
      if (ex.phase_after !== undefined && !PHASE_RE.test(ex.phase_after as string)) errs.push(`${sw}: bad phase_after`);
    });
  });
  return errs;
}

// ------------------------------------------------------------------ conversion

export function setupState(c: FixtureCase): DipState {
  const s = c.setup!;
  const m = /^([SFW])([0-9]{4})([MRA])$/.exec(s.phase)!;
  const sc: Record<ProvinceId, Power | null> = standardCenters();
  if (s.supply_centers_base === 'none') for (const k of Object.keys(sc)) sc[k] = null;
  for (const [k, v] of Object.entries(s.supply_centers ?? {})) sc[k] = v;
  const dislodged: Dislodged[] = (s.dislodged ?? []).map((d) => ({
    unit: { power: d.power, type: d.type, at: d.at },
    attackerFrom: d.attacker_from,
    byConvoy: d.by_convoy,
    options: [...d.retreat_options],
  }));
  return normalise({
    ruleset: RULESET,
    year: Number(m[2]),
    season: m[1] as Season,
    phase: m[3] as PhaseKind,
    units: s.units.map((u) => ({ power: u.power, type: u.type, at: u.at })),
    dislodged,
    sc,
  });
}

const entryText = (e: OrderEntry): string => (typeof e === 'string' ? e : e.o);
const unitKey = (u: { power: string; type: string; at: string }): string => `${u.power} ${u.type} ${u.at}`;
const sameSet = (a: string[], b: string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Run one case; returns human-readable mismatches (empty = pass). */
export function runCase(c: FixtureCase): string[] {
  const out: string[] = [];
  let state = setupState(c);
  (c.steps ?? []).forEach((step, si) => {
    const tag = (c.steps!.length > 1 ? `step ${si + 1}: ` : '') as string;
    const subs: Partial<Record<Power, RawOrder[]>> = {};
    const expectations: { power: Power; entry: OrderEntry; index: number | null }[] = [];
    for (const power of POWERS) {
      const list = step.orders[power];
      if (!list) continue;
      const raws: RawOrder[] = [];
      for (const e of list) {
        const r = parseOrder(entryText(e));
        const expected = typeof e === 'string' ? undefined : e.result;
        if (isParseError(r)) {
          if (expected !== 'parse_error') out.push(`${tag}${power} "${entryText(e)}" failed to parse: ${r.error} ${r.detail}`);
          continue;
        }
        if (expected === 'parse_error') out.push(`${tag}${power} "${entryText(e)}" parsed but a parse_error was expected`);
        expectations.push({ power, entry: e, index: raws.length });
        raws.push(r);
      }
      subs[power] = raws;
    }
    const outcome = adjudicate(state, subs);

    // per-order expectations
    const consumed = new Set<number>();
    for (const { power, entry, index } of expectations) {
      if (typeof entry === 'string' || entry.result === undefined || index === null) continue;
      const rep = outcome.legal.report.find((r) => r.power === power && r.index === index)!;
      const want = entry.result;
      if (want === 'illegal' || want === 'superseded') {
        if (rep.status !== want) out.push(`${tag}${power} "${entry.o}": expected ${want}, got ${rep.status}${rep.reason ? ` (${rep.reason})` : ''}`);
        else if (entry.reason && rep.reason !== entry.reason) out.push(`${tag}${power} "${entry.o}": expected reason ${entry.reason}, got ${rep.reason}`);
        continue;
      }
      if (rep.status !== 'used') {
        out.push(`${tag}${power} "${entry.o}": expected ${want}, but the order was ${rep.status}${rep.reason ? ` (${rep.reason})` : ''}`);
        continue;
      }
      let ri = outcome.results.findIndex((r, i) => !consumed.has(i) && r.power === power && r.order === rep.normalised);
      if (ri < 0) ri = outcome.results.findIndex((r) => r.power === power && r.order === rep.normalised);
      if (ri < 0) {
        out.push(`${tag}${power} "${entry.o}": no result for ${rep.normalised}`);
        continue;
      }
      consumed.add(ri);
      const got = outcome.results[ri].result;
      if (got !== want) out.push(`${tag}${power} "${entry.o}" (${rep.normalised}): expected ${want}, got ${got}`);
    }

    // board expectations
    const next = outcome.next;
    const gotUnits = next.units.map(unitKey);
    const wantUnits = step.expect.units_after.map(unitKey);
    if (!sameSet(gotUnits, wantUnits)) out.push(`${tag}units_after: expected [${[...wantUnits].sort().join(', ')}], got [${[...gotUnits].sort().join(', ')}]`);
    const wantDis = step.expect.dislodged_after ?? [];
    const gotDis = next.dislodged;
    if (!sameSet(gotDis.map((d) => unitKey(d.unit)), wantDis.map(unitKey))) {
      out.push(`${tag}dislodged_after: expected [${wantDis.map(unitKey).sort().join(', ')}], got [${gotDis.map((d) => unitKey(d.unit)).sort().join(', ')}]`);
    } else {
      for (const w of wantDis) {
        if (!w.retreat_options) continue;
        const g = gotDis.find((d) => unitKey(d.unit) === unitKey(w))!;
        if (!sameSet([...g.options], w.retreat_options)) {
          out.push(`${tag}retreat options of ${unitKey(w)}: expected [${[...w.retreat_options].sort().join(', ')}], got [${g.options.join(', ')}]`);
        }
      }
    }
    if (step.expect.contested_after && !sameSet([...outcome.contested], step.expect.contested_after)) {
      out.push(`${tag}contested_after: expected [${step.expect.contested_after.join(', ')}], got [${outcome.contested.join(', ')}]`);
    }
    for (const [p, owner] of Object.entries(step.expect.supply_centers_after ?? {})) {
      if (next.sc[p] !== owner) out.push(`${tag}supply centre ${p}: expected ${owner}, got ${next.sc[p]}`);
    }
    const ph = `${next.season}${next.year}${next.phase}`;
    if (step.expect.phase_after && ph !== step.expect.phase_after) out.push(`${tag}phase_after: expected ${step.expect.phase_after}, got ${ph}`);
    for (const ev of outcome.events) if (ev.kind === 'adjudicator_anomaly') out.push(`${tag}adjudicator_anomaly: ${ev.decisions.join('; ')}`);
    state = next;
  });
  return out;
}

/** Every DATC v3.0 case id in 6.A–6.J (164). */
export const DATC_SECTIONS: Readonly<Record<string, number>> = Object.freeze({
  A: 12, B: 15, C: 9, D: 34, E: 15, F: 25, G: 20, H: 16, I: 7, J: 11,
});
export function allDatcIds(): string[] {
  const ids: string[] = [];
  for (const [s, n] of Object.entries(DATC_SECTIONS)) for (let i = 1; i <= n; i++) ids.push(`6.${s}.${i}`);
  return ids;
}
export const baseId = (id: string): string => id.replace(/#[0-9]$/, '');
export type { Unit };
