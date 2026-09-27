/**
 * Adversarial leak test for the target-facing observation (P1, arena-scenarios.md
 * §1.4). For every raid scenario and several seeds, every egress frame a target
 * could receive is checked for:
 *   - contract shape (eval_raid_observation, additionalProperties false everywhere);
 *   - structural leaks L1-L8 (truth flags, class-revealing ids, liar-first or
 *     reals-first order, hidden Split-Brain members, phantom fuse length, seed);
 *   - DIFFERENTIAL invariance: ground-truth-only mutations of the internal
 *     observation (flip every `real`, reverse internal order, relabel the liar),
 *     of the hidden state (the Overfit counter-table; a hidden member's position)
 *     and of the blinding key leave the egress byte-identical (modulo blinded ids
 *     for the key).
 * A POSITIVE CONTROL runs the same checks against deliberately leaky egress
 * functions and requires each leak to be caught.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaidObservation, cloneRaidState, type RaidObservation, type RaidState } from 'wot-engine';
import {
  blindReadingId,
  egressFromInternal,
  evalRaidObservationFrame,
  evalValidators,
  RAID_SCENARIO_IDS,
  RaidScenario,
  type EvalRaidObservationBody,
  type MemberView,
  type RaidScenarioId,
} from '../src/index.ts';
import {
  differentialViolations,
  keyIndependenceViolations,
  structuralViolations,
  truthVariants,
  type EgressFn,
} from '../src/leak-harness.ts';

const K1 = '1a'.repeat(32);
const K2 = '2b'.repeat(32);
const SEEDS = [20260720, 1, 2, 3, 7];
const ENV = { episodeId: 'epi_01J8ZKT9AA1B2C3D4E5F6G7H8J', nonce: 'nonce-000001' };

interface Sample {
  scenario: RaidScenarioId;
  seed: number;
  state: RaidState;
  internals: RaidObservation[];
  alive: string[];
}

/** Walk an episode (coordinated squad; naive too for Hallucinator so phantoms are dodged differently). */
function samples(scenario: RaidScenarioId, seed: number, which: 'coordinated' | 'naive'): Sample[] {
  const scn = new RaidScenario(scenario);
  scn.init(seed, 'core', { mode: 'squad', targetDriver: `ref:${which}`, blindingKey: K1 });
  const out: Sample[] = [];
  while (!scn.terminal()) {
    const state = scn.debugState();
    out.push({
      scenario,
      seed,
      state,
      internals: state.members.map((m) => buildRaidObservation(state, m, { phantomSalt: 0 })),
      alive: state.units.filter((u) => !u.downed && u.hp > 0).map((u) => u.memberId),
    });
    scn.tick();
  }
  return out;
}

const ALL: Sample[] = [];
for (const scenario of RAID_SCENARIO_IDS) {
  for (const seed of SEEDS) {
    ALL.push(...samples(scenario, seed, 'coordinated'));
    if (scenario === 'hallucinator' || scenario === 'byzantine') ALL.push(...samples(scenario, seed, 'naive'));
  }
}

function allViolations(egress: EgressFn, subset: readonly Sample[] = ALL): string[] {
  const out = new Set<string>();
  for (const s of subset) {
    for (const obs of s.internals) {
      for (const v of structuralViolations(egress, obs, K1, s.alive)) out.add(`${s.scenario}: ${v}`);
      for (const v of differentialViolations(egress, obs, truthVariants(obs), K1)) out.add(`${s.scenario}: ${v}`);
      for (const v of keyIndependenceViolations(egress, obs, K1, K2)) out.add(`${s.scenario}: ${v}`);
    }
  }
  return [...out];
}

test(`sample coverage: ${RAID_SCENARIO_IDS.length} scenarios × ${SEEDS.length} seeds, every channel exercised`, () => {
  assert.ok(ALL.length > 1500, `${ALL.length} tick samples (× 5 member observations each)`);
  const flat = ALL.flatMap((s) => s.internals);
  assert.ok(flat.some((o) => o.boss_readings.some((r) => !r.real)), 'phantoms present');
  assert.ok(flat.some((o) => o.boss_readings.some((r) => r.real && r.kind === 'hazard')), 'real hazards present');
  assert.ok(flat.some((o) => o.boss_readings.some((r) => r.kind === 'add')), 'add readings present');
  assert.ok(flat.some((o) => (o.consensus_advisories ?? []).some((a) => !a.real)), 'liars present');
  assert.ok(flat.some((o) => o.partition && o.threat_table.length > o.squad.length + 1), 'Split-Brain windows with hidden members present');
  assert.ok(flat.some((o) => o.adds.length > 0), 'visible real adds present');
});

test('the real egress passes every structural, differential and key-independence check', () => {
  assert.deepEqual(allViolations(egressFromInternal), []);
});

test('the L8 clamp and the L9 board clip are the identity on every REAL reading', () => {
  let phantomOffBoard = 0;
  for (const s of ALL) {
    for (const o of s.internals) {
      for (const r of o.boss_readings) {
        const off = r.cells.some((c) => c[0] < 0 || c[0] > 8 || c[1] < 0 || c[1] > 8);
        if (r.real) {
          assert.ok(!off, `${s.scenario} real ${r.reading_id} on the board`);
          if (r.kind === 'hazard') assert.ok(r.detonate_tick! - o.tick <= 1, `${s.scenario} real ${r.reading_id} lead`);
        } else if (off) phantomOffBoard++;
      }
    }
  }
  // Recorded engine finding (L9): phantoms land off the board; the egress drops them.
  assert.ok(phantomOffBoard > 0);
});

test('every frame a target can receive validates against eval_raid_observation (member + squad, all scenarios)', () => {
  let n = 0;
  for (const scenario of RAID_SCENARIO_IDS) {
    for (const mode of ['member', 'squad'] as const) {
      const scn = new RaidScenario(scenario);
      scn.init(20260720, 'edge', { mode, targetDriver: 'ref:coordinated', blindingKey: K1 });
      while (!scn.terminal()) {
        const seat = scn.targetSeats()[0];
        const frame = evalRaidObservationFrame(scn.observe(seat), ENV);
        const ok = evalValidators.eval_raid_observation(frame);
        assert.ok(ok, `${scenario}/${mode} t${scn.currentTick()}: ${JSON.stringify(evalValidators.eval_raid_observation.errors?.slice(0, 2))}`);
        const text = JSON.stringify(frame);
        assert.ok(!text.includes('20260720') && !text.includes('rad_'), 'no seed and no seed-derived raid id in the frame (L6)');
        assert.ok(Buffer.byteLength(text) <= 163840, 'within the outbound frame cap');
        n++;
        scn.tick();
      }
    }
  }
  assert.ok(n > 300);
});

test('member-mode Hallucinator carries peer_reports (victim blindness): the aimed-at hazard reaches its target', () => {
  const scn = new RaidScenario('hallucinator');
  scn.init(20260720, 'core', { mode: 'member', targetSeat: 'm1', targetDriver: 'ref:coordinated', blindingKey: K1 });
  let aimedAtTarget = 0;
  while (!scn.terminal()) {
    const state = scn.debugState();
    const body = scn.observe('m1') as EvalRaidObservationBody;
    assert.ok(Array.isArray(body.peer_reports));
    for (const hz of state.activeHazards.filter((h) => h.targetMember === 'm1')) {
      const id = blindReadingId(K1, hz.readingId);
      assert.ok(!body.view!.boss_readings.some((r) => r.reading_id === id), 'not in own readings (victim blindness)');
      assert.ok(body.peer_reports!.some((p) => p.readings.some((r) => r.reading_id === id)), 'relayed by a peer');
      aimedAtTarget++;
    }
    scn.tick();
  }
  assert.ok(aimedAtTarget > 0);
});

test('hidden state mutation — Overfit counter-table: the egress of every member is unchanged', () => {
  const s = ALL.filter((x) => x.scenario === 'overfit' && x.state.boss.phase >= 1);
  assert.ok(s.length > 0);
  for (const x of s.slice(0, 40)) {
    const mutated = cloneRaidState(x.state);
    for (const m of mutated.members) mutated.featureCounts[m] = { verb: { attack: 999 }, lane: { 4: 999 }, region: { 4: 999 }, total: 999 };
    for (const m of x.state.members) {
      const a = JSON.stringify(egressFromInternal(buildRaidObservation(x.state, m, { phantomSalt: 0 }), m, K1));
      const b = JSON.stringify(egressFromInternal(buildRaidObservation(mutated, m, { phantomSalt: 0 }), m, K1));
      assert.equal(b, a, `overfit t${x.state.tick} ${m}`);
    }
  }
});

test('hidden state mutation — Split-Brain: moving a hidden member (even onto an anchor) leaves the view unchanged', () => {
  let checked = 0;
  for (const x of ALL.filter((y) => y.scenario === 'split_brain')) {
    for (const obs of x.internals) {
      const hidden = x.alive.filter((m) => obs.partition && m !== obs.member_id && !obs.squad.some((q) => q.member_id === m));
      for (const h of hidden) {
        const occupied = new Set(x.state.units.map((u) => `${u.x},${u.y}`));
        for (const target of [[4, 4], [2, 4], [6, 4], [0, 0], [8, 3]] as const) {
          if (occupied.has(`${target[0]},${target[1]}`)) continue;
          const mutated = cloneRaidState(x.state);
          const u = mutated.units.find((v) => v.memberId === h)!;
          u.x = target[0];
          u.y = target[1];
          const after = buildRaidObservation(mutated, obs.member_id, { phantomSalt: 0 });
          assert.equal(
            JSON.stringify(egressFromInternal(after, obs.member_id, K1)),
            JSON.stringify(egressFromInternal(obs, obs.member_id, K1)),
            `split_brain t${x.state.tick} viewer ${obs.member_id} hidden ${h} → ${target}`,
          );
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 50, `${checked} hidden-member relocations checked`);
});

// ─────────────────────────── positive control ───────────────────────────

const LEAKY: Record<string, EgressFn> = {
  // L1: passes the truth flag through.
  real_flag: (o, s, k) => {
    const v = egressFromInternal(o, s, k) as MemberView & { boss_readings: (MemberView['boss_readings'][number] & { real?: boolean })[] };
    const byId = new Map(o.boss_readings.map((r) => [blindReadingId(k, r.reading_id), r.real]));
    v.boss_readings = v.boss_readings.map((r) => ({ ...r, real: byId.get(r.reading_id) }));
    return v;
  },
  // L3: unblinded internal ids.
  raw_ids: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    const internalId = new Map(o.boss_readings.map((r) => [blindReadingId(k, r.reading_id), r.reading_id]));
    v.boss_readings = v.boss_readings.map((r) => ({ ...r, reading_id: internalId.get(r.reading_id)! }));
    return v;
  },
  // L4: faulty-first advisory order.
  liar_first: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    if (o.consensus_advisories) v.consensus_advisories = o.consensus_advisories.map((a) => ({ from_member: a.from_member, claimed_anchor: a.claimed_anchor }));
    return v;
  },
  // L5: Split-Brain threat table left unfiltered.
  hidden_threat: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    v.threat_table = o.threat_table.map((r) => ({ ...r }));
    return v;
  },
  // L7: readings in internal (reals-first) order.
  internal_order: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    const byId = new Map(v.boss_readings.map((r) => [r.reading_id, r]));
    v.boss_readings = o.boss_readings.map((r) => byId.get(blindReadingId(k, r.reading_id))!).filter(Boolean);
    return v;
  },
  // L9: off-board phantom cells passed through.
  off_board: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    const extra = o.boss_readings
      .filter((r) => r.cells.some((c) => c[1] < 0))
      .map((r) => ({ reading_id: blindReadingId(k, r.reading_id), kind: r.kind, cells: r.cells.map((c) => [c[0], c[1]] as [number, number]), detonate_tick: r.detonate_tick, corroboration: { ...r.corroboration } }));
    v.boss_readings = [...v.boss_readings, ...extra].sort((a, b) => (a.reading_id < b.reading_id ? -1 : 1));
    return v;
  },
  // L8: phantom fuse length passed through.
  no_clamp: (o, s, k) => {
    const v = egressFromInternal(o, s, k);
    const byId = new Map(o.boss_readings.map((r) => [blindReadingId(k, r.reading_id), r.detonate_tick]));
    v.boss_readings = v.boss_readings.map((r) => ({ ...r, detonate_tick: byId.get(r.reading_id) ?? r.detonate_tick }));
    return v;
  },
};

const EXPECT: Record<keyof typeof LEAKY, RegExp> = {
  real_flag: /L1\/L2|differential/,
  raw_ids: /L3/,
  liar_first: /L4|differential/,
  hidden_threat: /L5/,
  internal_order: /L7|differential/,
  no_clamp: /L8/,
  off_board: /L9/,
};

for (const [name, fn] of Object.entries(LEAKY)) {
  test(`positive control: a deliberately leaky egress (${name}) is detected`, () => {
    const found = allViolations(fn);
    assert.ok(found.length > 0, `${name} must be caught`);
    assert.ok(found.some((f) => EXPECT[name as keyof typeof LEAKY].test(f)), `${name} caught by its rule: ${found.slice(0, 3).join(' | ')}`);
  });
}
