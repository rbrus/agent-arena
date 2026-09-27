/**
 * Benchmark (definition of done: every engine-path change lands with a number).
 * Measures, per raid tick, (a) the live adapter path: internal observations,
 * reference fill, resolve, hash, and the five egress views of a squad target
 * (HMAC blinding included); (b) the oracle path: re-sim tap + every verdict.
 * The design budget is ≤ 250 µs per tick for engine + egress + tap on the dev
 * box (arena-scenarios.md §3.4); the CI gate here is deliberately loose (runner
 * variance) and the measured numbers are printed for the gate report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RAID_SCENARIO_IDS, RaidScenario, computeRaidVerdicts } from '../src/index.ts';

const KEY = '7a'.repeat(32);

test('benchmark: µs per tick (live adapter + squad egress) and (re-sim tap + oracles)', () => {
  const rows: string[] = [];
  let liveTotal = 0;
  let oracleTotal = 0;
  let tickTotal = 0;
  for (const id of RAID_SCENARIO_IDS) {
    let live = 0;
    let orc = 0;
    let ticks = 0;
    for (let rep = 0; rep < 5; rep++) {
      for (const which of ['coordinated', 'naive'] as const) {
        const scn = new RaidScenario(id);
        scn.init(20260720 + rep, 'core', { mode: 'squad', targetDriver: `ref:${which}`, blindingKey: KEY });
        const t0 = performance.now();
        while (!scn.terminal()) {
          scn.observe('squad');
          scn.tick();
          ticks++;
        }
        const t1 = performance.now();
        computeRaidVerdicts(scn.record());
        const t2 = performance.now();
        live += t1 - t0;
        orc += t2 - t1;
      }
    }
    rows.push(`${id.padEnd(13)} live ${((live * 1000) / ticks).toFixed(1).padStart(7)} µs/tick   oracles ${((orc * 1000) / ticks).toFixed(1).padStart(7)} µs/tick   (${ticks} ticks)`);
    liveTotal += live;
    oracleTotal += orc;
    tickTotal += ticks;
  }
  const liveUs = (liveTotal * 1000) / tickTotal;
  const orcUs = (oracleTotal * 1000) / tickTotal;
  console.log(`\n[bench] arena-scenarios (node ${process.version}, ${process.arch})\n${rows.join('\n')}\n[bench] ALL live ${liveUs.toFixed(1)} µs/tick, oracles ${orcUs.toFixed(1)} µs/tick`);
  assert.ok(liveUs < 5000 && orcUs < 10000, 'loose CI gate (see header)');
});

test('benchmark: diplomacy_standard ms per tick (live adapter: six reference agents + engine step + the target\'s validated egress frame) and oracle path', async () => {
  const { DiplomacyScenario, computeDipVerdicts } = await import('../src/index.ts');
  let live = 0;
  let egress = 0;
  let orc = 0;
  let ticks = 0;
  for (const [fill, drv] of [['injector-table', 'ref:robust'], ['injector-table', 'ref:credulous'], ['house', 'ref:robust']] as const) {
    const scn = new DiplomacyScenario();
    scn.init(20261115, 'core', { mode: 'power', targetSeat: 'germany', targetDriver: drv, blindingKey: KEY, diplomacy: { fill, horizonYear: 1904 } });
    const t0 = performance.now();
    while (!scn.terminal()) {
      const e0 = performance.now();
      scn.observe('germany');
      egress += performance.now() - e0;
      scn.tick();
      ticks++;
    }
    const t1 = performance.now();
    computeDipVerdicts(scn.record());
    orc += performance.now() - t1;
    live += t1 - t0;
  }
  console.log(
    `\n[bench] diplomacy_standard core horizon 1904 (${ticks} ticks): live ${(live / ticks).toFixed(2)} ms/tick (of which egress+schema ${((egress * 1000) / ticks).toFixed(0)} µs), oracles ${(orc / ticks).toFixed(2)} ms/tick (re-sim + registry rebuild + 6 oracles + validity)`,
  );
  assert.ok(live / ticks < 200 && orc / ticks < 400, 'loose CI gate');
});
