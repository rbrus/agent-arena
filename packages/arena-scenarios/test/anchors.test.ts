/**
 * Self-test 1, 2, 6 (arena-scenarios.md §4.4): the frozen anchors reproduce
 * THROUGH THE ADAPTER in squad and member seating at every tier, the duel pair
 * and the Byzantine gate seeds reproduce, and the coordinated reference squads
 * reproduce their anchors when driven ONLY by the target-facing egress (the
 * shape of a squad-mode REST reference target, open question 2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaidObservation, credulousSquad, orderedLockSquad, runRaid } from 'wot-engine';
import {
  anchorFor,
  BOSS_OF,
  canonicalMemberActions,
  dissentFirst,
  egressFromInternal,
  internalShapeFromEgress,
  RaidScenario,
  createScenario,
  egressSquadDriver,
  GATE_SEEDS_BYZANTINE,
  lockOrderDiscipline,
  RAID_SCENARIO_IDS,
  REFERENCE,
  runEpisode,
  runToTerminal,
  scenarioModule,
  SCENARIO_IDS,
  SELF_TESTS,
  tierOf,
  type EvalRaidObservationBody,
} from '../src/index.ts';

const KEY = '0f'.repeat(32);
const S0 = 20260720;

/**
 * The Core anchors of the arena's reference pairs. Eleven are the frozen engine
 * anchors verbatim (wot-engine test/raid.test.ts:51-56,189-210); `deadlock
 * coordinated` is the B2c re-freeze of lockOrderDiscipline(orderedLockSquad)
 * (src/anchors.ts). ENGINE_DEADLOCK_COORDINATED pins that the engine policy
 * itself still reproduces its own anchor.
 */
const ENGINE_DEADLOCK_COORDINATED = 'sha256:11fbe677d5be18bb9bc8999b6827a0574efb465f1cc1043063dfaad604bd953f';
const FROZEN_CORE: Record<string, string> = {
  'hallucinator coordinated': 'sha256:584b6d339ab958e9a02130297c32adce444a5f18d41a62af92b99d748d78cf77',
  'hallucinator naive': 'sha256:a615dda08da9eafcb0fb6d3d5cb3c6a9d3b7e80f8659df60815eccfd277f804c',
  'overfit coordinated': 'sha256:731ccfcd4ed56a23c712c23f4f62cea7d453f0e31f911b5c70ade782666be076',
  'overfit naive': 'sha256:ccdcbb7b0ef1100d217d5534550a84c1a243f2fcec9e786fea70d5cb287203bd',
  'byzantine coordinated': 'sha256:e533088162409df5afbca9b03f069b1d904ecf4943d1dbaa21b2ff23bd436147',
  'byzantine naive': 'sha256:cb237d18baf40625877ee4e61d0b2c7aae4671421296ec474e0f1c0bb134b2e6',
  'deadlock coordinated': 'sha256:a1dee423dec7039435917a8db912d3c12dc8ec26c5cc7e396f7b9fae18eccc57',
  'deadlock naive': 'sha256:0a5552f7b9c0f7ce774c77639224f385f06fa56982a4fe944727be68670b0f14',
  'split_brain coordinated': 'sha256:c36d373491052726b5696b76c078aa30d9a1ec000c47b75452dde3cb0f030ad7',
  'split_brain naive': 'sha256:1dc27f78da69d7820c751ab7f316b47d12d8e4e02234d370757673126ee000e7',
  'latency coordinated': 'sha256:104cc9959eca56aeae6cbc3a29b47b63e46d85419310bf7474b407d90ca75143',
  'latency naive': 'sha256:42989e45c735b1238861e4c8dff3273f148c69f989c12a9337e000cb55c5802a',
};

test('the self-test table covers every scenario and the frozen Core anchors verbatim', () => {
  assert.equal(SELF_TESTS.length, 86);
  for (const id of SCENARIO_IDS) assert.ok(scenarioModule(id).selfTests().length > 0, `${id} ships self-tests`);
  for (const [k, h] of Object.entries(FROZEN_CORE)) {
    const [id, which] = k.split(' ');
    const row = SELF_TESTS.find((c) => c.scenario === id && c.tier === 'core' && c.seed === S0 && c.opts.mode === 'squad' && c.opts.targetDriver === `ref:${which}`);
    assert.equal(row?.expect.replayHash, h, `${k}: self-test row equals the frozen anchor`);
  }
});

for (const c of SELF_TESTS) {
  test(`self-test: ${c.name} → ${c.expect.outcome} @${c.expect.ticks}`, () => {
    const scn = runEpisode(c.scenario, c.seed, c.tier, { ...c.opts, blindingKey: KEY });
    const t = scn.terminal()!;
    assert.equal(t.outcome, c.expect.outcome);
    assert.equal(t.ticks, c.expect.ticks);
    assert.equal(scn.replayHash(), c.expect.replayHash);
    // verify round-trip: pure re-derivation from the record reproduces the hash.
    const v = scenarioModule(c.scenario).verify(scn.record());
    assert.equal(v.replayHash, c.expect.replayHash);
    assert.equal(v.integrity, true);
  });
}

test('B2c: the engine orderedLockSquad is untouched (its anchor reproduces); the arena reference is the disciplined wrapper', () => {
  const engine = runRaid(S0, 'deadlock', orderedLockSquad, undefined, { config: { allowance: tierOf('core').actionAllowance } });
  assert.equal(engine.replayHash, ENGINE_DEADLOCK_COORDINATED);
  assert.equal(REFERENCE.deadlock.coordinated.name, 'orderedLockSquad.disciplined');
  // The wrapper is inert where there are no locks: it reproduces every other coordinated anchor.
  for (const id of RAID_SCENARIO_IDS.filter((x) => x !== 'deadlock')) {
    const w = runRaid(S0, BOSS_OF[id], lockOrderDiscipline(REFERENCE[id].coordinated.policy), undefined, { config: { allowance: tierOf('core').actionAllowance } });
    assert.equal(w.replayHash, FROZEN_CORE[`${id} coordinated`], id);
  }
});

test('golden pairs separate in every tier: coordinated CLEARS, naive WIPES, hashes differ', () => {
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    for (const id of RAID_SCENARIO_IDS) {
      const c = SELF_TESTS.find((x) => x.scenario === id && x.tier === tier && x.seed === S0 && x.opts.mode === 'squad' && x.opts.targetDriver === 'ref:coordinated')!;
      const n = SELF_TESTS.find((x) => x.scenario === id && x.tier === tier && x.seed === S0 && x.opts.mode === 'squad' && x.opts.targetDriver === 'ref:naive')!;
      assert.equal(c.expect.outcome, 'clear', `${id} ${tier} coordinated`);
      assert.equal(n.expect.outcome, 'wipe', `${id} ${tier} naive`);
      assert.notEqual(c.expect.replayHash, n.expect.replayHash);
    }
    const r = SELF_TESTS.find((x) => x.scenario === 'grid_tactics' && x.tier === tier && x.seed === 2 && x.opts.targetDriver === 'ref:reflex')!;
    const z = SELF_TESTS.find((x) => x.scenario === 'grid_tactics' && x.tier === tier && x.seed === 2 && x.opts.targetDriver === 'ref:null')!;
    assert.equal(r.expect.outcome, 'win', `duel ${tier} seed 2 reflex wins`);
    assert.equal(z.expect.outcome, 'loss', `duel ${tier} seed 2 null loses`);
  }
  // Recorded finding: the S0 duel pair separates at Core/Frontier but not at Edge.
  const edgeReflexS0 = SELF_TESTS.find((x) => x.scenario === 'grid_tactics' && x.tier === 'edge' && x.seed === S0 && x.opts.targetDriver === 'ref:reflex')!;
  assert.equal(edgeReflexS0.expect.outcome, 'loss');
});

test('tier anchors: hashes differ per tier (remaining is hashed), outcomes and ticks do not', () => {
  for (const id of RAID_SCENARIO_IDS) {
    for (const w of ['coordinated', 'naive'] as const) {
      const rows = (['edge', 'core', 'frontier'] as const).map(
        (tier) => SELF_TESTS.find((x) => x.scenario === id && x.tier === tier && x.seed === S0 && x.opts.mode === 'squad' && x.opts.targetDriver === `ref:${w}`)!,
      );
      assert.equal(new Set(rows.map((r) => r.expect.replayHash)).size, 3, `${id} ${w}: three distinct tier hashes`);
      assert.equal(new Set(rows.map((r) => `${r.expect.outcome}@${r.expect.ticks}`)).size, 1, `${id} ${w}: tier-invariant outcome`);
    }
  }
});

test('the adapter equals a direct engine run at every tier (config.allowance is the only tier input)', () => {
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    for (const id of RAID_SCENARIO_IDS) {
      const direct = runRaid(S0, BOSS_OF[id], REFERENCE[id].coordinated.policy, undefined, { config: { allowance: tierOf(tier).actionAllowance } });
      const scn = runEpisode(id, S0, tier, { mode: 'squad', targetDriver: 'ref:coordinated', blindingKey: KEY });
      assert.equal(scn.replayHash(), direct.replayHash, `${id} ${tier}`);
      assert.deepEqual(scn.record().perTickHashes, direct.perTickHashes);
    }
  }
});

test('member seating: every seat m0..m4 driven by the coordinated slice reproduces the frozen Core anchor', () => {
  for (const id of RAID_SCENARIO_IDS) {
    for (const seat of ['m0', 'm1', 'm2', 'm3', 'm4'] as const) {
      const scn = runEpisode(id, S0, 'core', { mode: 'member', targetSeat: seat, targetDriver: 'ref:coordinated', blindingKey: KEY });
      assert.equal(scn.replayHash(), FROZEN_CORE[`${id} coordinated`], `${id} ${seat}`);
    }
  }
});

test('Byzantine gate seeds: every (seed x tier) cell frozen; coordinated clears / naive wipes; tier-invariant outcome', () => {
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    const hashes = new Set<string>();
    for (const seed of GATE_SEEDS_BYZANTINE) {
      const c = anchorFor({ scenario: 'byzantine', seat: 'squad', tier, seed, policy: 'coordinated' });
      const n = anchorFor({ scenario: 'byzantine', seat: 'squad', tier, seed, policy: 'naive' });
      assert.ok(c && n, `${tier} seed ${seed}: both anchors frozen`);
      assert.equal(c.outcome, 'clear');
      assert.equal(n.outcome, 'wipe');
      const core = anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed, policy: 'coordinated' })!;
      assert.equal(c.ticks, core.ticks, `${tier} seed ${seed}: tier-invariant tick`);
      hashes.add(c.replayHash);
    }
    assert.equal(hashes.size, 5, `${tier}: five distinct coordinated trajectories`);
  }
});

/** Drive a squad episode from the egress frames only (a served reference target). */
function egressRun(id: (typeof RAID_SCENARIO_IDS)[number], seed: number, tier: 'edge' | 'core' | 'frontier', which: 'coordinated' | 'naive') {
  const drive = egressSquadDriver(id, which);
  const scn = createScenario(id);
  scn.init(seed, tier, { mode: 'squad', blindingKey: KEY });
  runToTerminal(scn, (obs) => {
    const b = obs as EvalRaidObservationBody;
    const payload = { members: drive(b.views!, b.turn_id) };
    return { kind: 'action', payload, latencyMs: 1, frameBytes: JSON.stringify(payload).length };
  });
  return scn;
}

test('C2e: the egress-driven naive squads reproduce every frozen naive anchor (all six raids x three tiers at S0; Byzantine at every gate seed)', () => {
  const cells = SELF_TESTS.filter((c) => c.scenario !== 'grid_tactics' && c.opts.mode === 'squad' && c.opts.targetDriver === 'ref:naive');
  // 18 = six raids x three tiers at S0; 13 = Byzantine gate naive rows (Core S0..5, the S0 row repeated as '(gate)', + Edge/Frontier seeds 1,2,3,5).
  assert.equal(cells.length, 18 + 13);
  for (const c of cells) {
    const scn = egressRun(c.scenario as (typeof RAID_SCENARIO_IDS)[number], c.seed, c.tier, 'naive');
    assert.equal(scn.replayHash(), c.expect.replayHash, c.name);
    assert.equal(scn.record().timing.filter((e) => e.event === 'rejected').length, 0, `${c.name}: every frame accepted`);
  }
});

test('C2e: the egress-driven coordinated squads reproduce every Byzantine gate anchor in every tier', () => {
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    for (const seed of GATE_SEEDS_BYZANTINE) {
      const a = anchorFor({ scenario: 'byzantine', seat: 'squad', tier, seed, policy: 'coordinated' })!;
      assert.equal(egressRun('byzantine', seed, tier, 'coordinated').replayHash(), a.replayHash, `${tier} seed ${seed}`);
    }
  }
});

test('egress-only reference squads (local REST-reference shape) reproduce every coordinated anchor', () => {
  for (const id of RAID_SCENARIO_IDS) {
    const drive = egressSquadDriver(id, 'coordinated');
    const scn = createScenario(id);
    scn.init(S0, 'core', { mode: 'squad', blindingKey: KEY });
    runToTerminal(scn, (obs) => {
      const b = obs as EvalRaidObservationBody;
      const payload = { members: drive(b.views!, b.turn_id) };
      return { kind: 'action', payload, latencyMs: 1, frameBytes: JSON.stringify(payload).length };
    });
    assert.equal(scn.replayHash(), FROZEN_CORE[`${id} coordinated`], `${id}: egress-driven coordinated squad`);
    assert.equal(scn.record().timing.filter((e) => e.event === 'rejected').length, 0, `${id}: every frame accepted`);
  }
});

test('X-NAIVE-SERVED diagnosis: raw credulousSquad over egress departs from the anchor (it read the faulty-first POSITION of consensus_advisories[0])', () => {
  // The pre-C2e served driver: credulousSquad on re-hydrated egress views, whose
  // advisories are in member order (L4). It follows m0's claim, not the liar's.
  const scn = createScenario('byzantine');
  scn.init(1, 'core', { mode: 'squad', blindingKey: KEY });
  runToTerminal(scn, (obs) => {
    const b = obs as EvalRaidObservationBody;
    const joint = credulousSquad([...b.views!].sort((x, y) => (x.member_id < y.member_id ? -1 : 1)).map((v) => internalShapeFromEgress(v, b.turn_id)));
    const members: Record<string, unknown> = {};
    for (const m of Object.keys(joint).sort()) members[m] = canonicalMemberActions(joint[m]);
    return { kind: 'action', payload: { members }, latencyMs: 1, frameBytes: 100 };
  });
  assert.equal(scn.terminal()!.outcome, 'clear', 'seed 1: the old served naive squad CLEARS (the gate finding)');
  assert.notEqual(scn.replayHash(), anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed: 1, policy: 'naive' })!.replayHash);
});

test('X-NAIVE-SERVED invariant: on every tick of every gate cell, dissentFirst over the EGRESS advisories names the claim the internal faulty-first order puts at [0]', () => {
  let ticks = 0;
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    for (const seed of GATE_SEEDS_BYZANTINE) {
      const scn = createScenario('byzantine') as RaidScenario;
      scn.init(seed, tier, { mode: 'squad', targetDriver: 'ref:naive', blindingKey: KEY });
      while (!scn.terminal()) {
        const st = scn.debugState();
        for (const m of st.members) {
          const internal = buildRaidObservation(st, m, { phantomSalt: 0 });
          const served = dissentFirst(internalShapeFromEgress(egressFromInternal(internal, m, KEY), st.tick));
          assert.equal(served.consensus_advisories?.[0]?.claimed_anchor, internal.consensus_advisories?.[0]?.claimed_anchor, `${tier} seed ${seed} tick ${st.tick} ${m}`);
          // and it is the identity on the internal order's head
          assert.equal(dissentFirst(internal).consensus_advisories?.[0]?.claimed_anchor, internal.consensus_advisories?.[0]?.claimed_anchor);
          assert.ok(served.consensus_advisories?.every((a) => a.real === false), 'no truth flag reaches the served policy');
        }
        scn.tick();
        ticks++;
      }
    }
  }
  assert.ok(ticks > 900);
});

test('anchorFor: keyed lookup over squad, member and duel seating', () => {
  assert.equal(anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'edge', seed: 3, policy: 'coordinated' })?.replayHash, 'sha256:188015b02487d5a29576122983a8ba83771dc0ca043061ddf72b9eebac3a3848');
  assert.equal(anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed: S0, policy: 'naive' })?.replayHash, FROZEN_CORE['byzantine naive']);
  assert.equal(anchorFor({ scenario: 'deadlock', seat: 'm1', tier: 'core', seed: S0, policy: 'coordinated' })?.replayHash, FROZEN_CORE['deadlock coordinated']);
  assert.equal(anchorFor({ scenario: 'deadlock', seat: 'm1', tier: 'core', seed: S0, policy: 'naive', fill: 'naive' })?.replayHash, FROZEN_CORE['deadlock naive']);
  assert.equal(anchorFor({ scenario: 'deadlock', seat: 'm1', tier: 'core', seed: S0, policy: 'naive' }), undefined, 'naive target over the default coordinated fill: no anchor');
  assert.equal(anchorFor({ scenario: 'deadlock', seat: 'm2', tier: 'core', seed: S0, policy: 'coordinated' }), undefined);
  assert.equal(anchorFor({ scenario: 'grid_tactics', seat: 'A', tier: 'core', seed: 2, policy: 'coordinated' })?.name, 'grid_tactics core seed 2 A reflex vs silver');
  assert.equal(anchorFor({ scenario: 'grid_tactics', seat: 'A', tier: 'core', seed: 2, policy: 'null' })?.outcome, 'loss');
  assert.equal(anchorFor({ scenario: 'grid_tactics', seat: 'B', tier: 'core', seed: 2, policy: 'coordinated' }), undefined);
  assert.equal(anchorFor({ scenario: 'byzantine', seat: 'squad', tier: 'core', seed: 4, policy: 'coordinated' }), undefined);
  assert.equal(anchorFor({ scenario: 'byzantine', seat: 'A', tier: 'core', seed: S0, policy: 'coordinated' }), undefined);
  // every frozen row is reachable through the key
  for (const c of SELF_TESTS) {
    const seat = c.opts.mode === 'squad' ? 'squad' : (c.opts.targetSeat ?? (c.opts.mode === 'duel' ? 'A' : 'm1'));
    const policy = c.opts.targetDriver!.replace('ref:', '');
    const hit = anchorFor({ scenario: c.scenario, seat, tier: c.tier, seed: c.seed, policy, ...(c.opts.fill ? { fill: c.opts.fill } : {}) });
    assert.equal(hit?.replayHash, c.expect.replayHash, c.name);
  }
});
