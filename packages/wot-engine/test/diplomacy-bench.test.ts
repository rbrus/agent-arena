/**
 * Benchmark (design §4.6). Skipped unless BENCH=1. Reports median and p99 of
 * `adjudicate` over (a) S1901M standard openings, (b) the 6.F.24 second-order
 * paradox position, (c) random 34-unit boards; budget p99 ≤ 2 ms, ceiling 50 ms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../src/rng.ts';
import { setupState, type FixtureFile } from '../src/diplomacy/datc/load.ts';
import { armyNeighbours, canFleetOccupy, fleetNeighbours, MAP, provinceOf } from '../src/diplomacy/map.ts';
import { isParseError, parseOrder } from '../src/diplomacy/parse.ts';
import { adjudicate, initialState, normalise, standardCenters } from '../src/diplomacy/state.ts';
import { POWERS, type DipState, type Power, type RawOrder, type Submissions, type Unit } from '../src/diplomacy/types.ts';

const RUNS = Number(process.env.BENCH_RUNS ?? 10000);

function measure(label: string, cases: { s: DipState; subs: Submissions }[]): { median: number; p99: number } {
  const t: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const c = cases[i % cases.length];
    const t0 = process.hrtime.bigint();
    adjudicate(c.s, c.subs);
    t.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  t.sort((a, b) => a - b);
  const r = { median: t[t.length >> 1], p99: t[Math.floor(t.length * 0.99)] };
  console.log(`bench ${label}: median ${r.median.toFixed(3)} ms, p99 ${r.p99.toFixed(3)} ms over ${RUNS} runs`);
  return r;
}

const subsOf = (o: Record<string, string[]>): Submissions => {
  const s: Partial<Record<Power, RawOrder[]>> = {};
  for (const [p, l] of Object.entries(o)) s[p as Power] = l.map((x) => parseOrder(x)).filter((r): r is RawOrder => !isParseError(r));
  return s;
};

test('bench: adjudicate p99 within budget', { skip: process.env.BENCH !== '1' }, () => {
  const openings = subsOf({
    austria: ['A vie - gal', 'A bud - ser', 'F tri - alb'],
    england: ['F edi - nth', 'F lon - eng', 'A lvp - yor'],
    france: ['F bre - mao', 'A mar - spa', 'A par - bur'],
    germany: ['F kie - den', 'A ber - kie', 'A mun - ruh'],
    italy: ['F nap - ion', 'A rom - apu', 'A ven H'],
    russia: ['A mos - ukr', 'A war - gal', 'F sev - bla', 'F stp/sc - bot'],
    turkey: ['F ank - bla', 'A con - bul', 'A smy - con'],
  });
  const a = measure('S1901M openings', [{ s: initialState(), subs: openings }]);

  const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/diplomacy/datc/fixtures');
  const f24 = (JSON.parse(readFileSync(join(dir, '6F.json'), 'utf8')) as FixtureFile).cases.find((c) => c.id === '6.F.24')!;
  const subs24: Record<string, string[]> = {};
  for (const [p, l] of Object.entries(f24.steps![0].orders)) subs24[p] = l!.map((e) => (typeof e === 'string' ? e : e.o));
  const b = measure('6.F.24 paradox', [{ s: setupState(f24), subs: subsOf(subs24) }]);

  const rng = mulberry32(34);
  const pick = <T,>(x: readonly T[]): T => x[Math.floor(rng() * x.length)];
  const land = MAP.provinces.filter((p) => p.kind !== 'sea').map((p) => p.id);
  const fleetNodes = MAP.nodes.filter((n) => canFleetOccupy(n));
  const boards: { s: DipState; subs: Submissions }[] = [];
  for (let k = 0; k < 200; k++) {
    const units: Unit[] = [];
    const used = new Set<string>();
    while (units.length < 34) {
      const fleet = rng() < 0.45;
      const at = fleet ? pick(fleetNodes) : pick(land);
      if (used.has(provinceOf(at))) continue;
      used.add(provinceOf(at));
      units.push({ power: pick(POWERS), type: fleet ? 'F' : 'A', at });
    }
    const s = normalise({ ruleset: 'wot-dip/1', year: 1901, season: 'S', phase: 'M', units, dislodged: [], sc: standardCenters() });
    const o: Record<string, string[]> = {};
    for (const u of s.units) {
      const here = provinceOf(u.at);
      const other = pick(s.units);
      const ns = u.type === 'A' ? armyNeighbours(here) : fleetNeighbours(u.at);
      (o[u.power] ??= []).push(rng() < 0.6 ? `${u.type} ${u.at} - ${pick(ns)}` : `${u.type} ${here} S ${provinceOf(other.at)} - ${pick(ns).slice(0, 3)}`);
    }
    boards.push({ s, subs: subsOf(o) });
  }
  const c = measure('random 34-unit boards', boards);
  for (const r of [a, b, c]) assert.ok(r.p99 <= 50, 'hard ceiling 50 ms');
});
