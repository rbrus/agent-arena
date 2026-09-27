/**
 * Raid engine — the GATE regression (docs/design/raids-v1.md §3.4, §8).
 *
 * The two golden anchors per boss are the "coordinated wins / naive loses"
 * property frozen as a bit-for-bit hash: a consensus 5-squad CLEARS The
 * Hallucinator; a naive trust-all 5-squad WIPES. Same for The Overfit (diverse
 * clears / identical-greedy wipes). Plus: determinism re-sim, and phantom-safety
 * (phantom projections never enter the state hash).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRaidObservation,
  consensusSquad,
  createInitialRaidState,
  diverseSquad,
  greedySquad,
  isRaidTerminal,
  naiveSquad,
  raidStateHash,
  readingsFor,
  referenceSquadSpec,
  resimulateRaid,
  resolveRaidTick,
  runRaid,
  runBossWithSquad,
  realMin,
  BOSS_CATALOG,
  BOSS_MODULES,
  byzantineFaulty,
  partitionGroup,
  bftQuorumSquad,
  credulousSquad,
  orderedLockSquad,
  greedyGrabSquad,
  quorumPrimarySquad,
  dualPrimarySquad,
  leadingSquad,
  staleReactSquad,
  latencyLiveCell,
  latencyObservedCell,
  type BossId,
  type RaidSquadPolicy,
} from '../src/index.ts';

const SEED = 20260720;
const spec = referenceSquadSpec();

/** The frozen anchors (seed 20260720). Regenerate ONLY on an intended rule change. */
const GOLDEN = {
  hallucinator_consensus_clear: 'sha256:584b6d339ab958e9a02130297c32adce444a5f18d41a62af92b99d748d78cf77',
  hallucinator_naive_wipe: 'sha256:a615dda08da9eafcb0fb6d3d5cb3c6a9d3b7e80f8659df60815eccfd277f804c',
  overfit_diverse_clear: 'sha256:731ccfcd4ed56a23c712c23f4f62cea7d453f0e31f911b5c70ade782666be076',
  overfit_greedy_wipe: 'sha256:ccdcbb7b0ef1100d217d5534550a84c1a243f2fcec9e786fea70d5cb287203bd',
} as const;

function anchor(boss: BossId, policy: RaidSquadPolicy) {
  return runRaid(SEED, boss, policy, spec);
}

// ─────────────────────────── golden anchors: The Hallucinator ───────────────────────────

test('GATE: a consensus 5-squad CLEARS The Hallucinator (frozen hash)', () => {
  const r = anchor('the_hallucinator', consensusSquad);
  assert.equal(r.terminal.outcome, 'clear');
  assert.equal(r.terminal.bossDefeated, true);
  assert.ok(r.finalState.units.length >= 1, 'at least one member survives');
  assert.equal(r.replayHash, GOLDEN.hallucinator_consensus_clear);
});

test('GATE: a naive trust-all 5-squad WIPES The Hallucinator (frozen hash)', () => {
  const r = anchor('the_hallucinator', naiveSquad);
  assert.equal(r.terminal.outcome, 'wipe');
  assert.equal(r.replayHash, GOLDEN.hallucinator_naive_wipe);
  // The regression property: the SAME encounter is a clear for consensus and a
  // wipe for naive — coordination is the only difference.
  assert.notEqual(r.replayHash, GOLDEN.hallucinator_consensus_clear);
});

// ─────────────────────────── golden anchors: The Overfit ───────────────────────────

test('a diverse 5-squad CLEARS The Overfit (frozen hash)', () => {
  const r = anchor('the_overfit', diverseSquad);
  assert.equal(r.terminal.outcome, 'clear');
  assert.equal(r.replayHash, GOLDEN.overfit_diverse_clear);
});

test('an identical-greedy 5-squad WIPES The Overfit — its damage is absorbed (frozen hash)', () => {
  const r = anchor('the_overfit', greedySquad);
  assert.equal(r.terminal.outcome, 'wipe');
  assert.equal(r.finalState.boss.hp > 0, true, 'the boss survives — mitigation absorbed the greedy damage');
  assert.equal(r.replayHash, GOLDEN.overfit_greedy_wipe);
});

// ─────────────────────────── determinism re-sim (C1) ───────────────────────────

test('determinism: the whole raid re-sims bit-for-bit from (seed, per-tick squad action sets)', () => {
  for (const [boss, policy] of [
    ['the_hallucinator', consensusSquad],
    ['the_hallucinator', naiveSquad],
    ['the_overfit', diverseSquad],
    ['the_overfit', greedySquad],
  ] as const) {
    const r = runRaid(SEED, boss, policy, spec);
    const resim = resimulateRaid(SEED, boss, r.inputs, spec);
    assert.deepEqual(resim.perTickHashes, r.perTickHashes, `${boss} per-tick chain`);
    assert.equal(resim.replayHash, r.replayHash, `${boss} replay hash`);
    assert.equal(resim.terminal.outcome, r.terminal.outcome);
  }
});

test('determinism: same seed + same policy runs twice → identical chain', () => {
  const a = anchor('the_hallucinator', consensusSquad);
  const b = anchor('the_hallucinator', consensusSquad);
  assert.deepEqual(a.perTickHashes, b.perTickHashes);
  assert.match(a.replayHash, /^sha256:[0-9a-f]{64}$/);
});

// ─────────────────────────── phantom-safety (§3.2) ───────────────────────────

test('phantom-safety: different phantom projections, identical actions → identical state-hash chain', () => {
  // Record the consensus run's actions (built with the default phantom salt).
  const base = runRaid(SEED, 'the_hallucinator', consensusSquad, spec);

  // Re-resolve those EXACT recorded actions — resolution never reads observations,
  // so the state-hash chain must be identical regardless of any phantom projection.
  const resim = resimulateRaid(SEED, 'the_hallucinator', base.inputs, spec);
  assert.equal(resim.replayHash, base.replayHash);

  // And prove the phantom projection genuinely differs under a different salt while
  // the state it is built from is byte-identical — i.e. phantoms live ONLY in the
  // observation layer, never in the hashed state.
  const state = createInitialRaidState(SEED, 'the_hallucinator', spec);
  const s3 = [state, state, state].reduce((s) => resolveRaidTick(s, consensusSquad(s.members.map((m) => buildRaidObservation(s, m)))), state);
  const readingsA = state.members.flatMap((m) => readingsFor(s3, m, 0).map((r) => r.reading_id));
  const readingsB = state.members.flatMap((m) => readingsFor(s3, m, 7).map((r) => r.reading_id));
  assert.notDeepEqual(readingsA, readingsB, 'a different salt changes the phantom projection');
  assert.equal(raidStateHash(s3), raidStateHash(s3), 'the state hash is salt-independent (phantoms are not state)');
});

test('phantom-safety: no phantom reading is ever written into activeHazards', () => {
  let s = createInitialRaidState(SEED, 'the_hallucinator', spec);
  for (let i = 0; i < 40 && !isRaidTerminal(s).over; i++) {
    const actions = consensusSquad(s.members.map((m) => buildRaidObservation(s, m)));
    s = resolveRaidTick(s, actions);
    // Every hazard in state is a REAL, telegraphed hazard (id hz_/cv_), never a
    // phantom (id ph_/bait_ — those exist only in the observation projection).
    for (const hz of s.activeHazards) {
      assert.ok(/^(hz|cv)_/.test(hz.readingId), `state hazard ${hz.readingId} is real, not a phantom`);
    }
  }
});

// ─────────────────────────── the corroboration discriminator (§3.2) ───────────────────────────

test('corroboration discriminator: reals sit ≥ ceil(2/3·alive), phantoms below it', () => {
  let s = createInitialRaidState(SEED, 'the_hallucinator', spec);
  // Advance into P2/P3 so hazards + phantoms (incl. the bait) are live.
  for (let i = 0; i < 40 && !isRaidTerminal(s).over; i++) {
    s = resolveRaidTick(s, consensusSquad(s.members.map((m) => buildRaidObservation(s, m))));
  }
  const alive = s.units.filter((u) => !u.downed).length;
  const rmin = realMin(alive);
  const seen = new Set<string>();
  for (const m of s.members) {
    for (const r of readingsFor(s, m, 0)) {
      if (seen.has(r.reading_id)) continue;
      seen.add(r.reading_id);
      if (r.real) assert.ok(r.corroboration.seen_by_count >= rmin, `real ${r.reading_id} corroborated`);
      else assert.ok(r.corroboration.seen_by_count < rmin, `phantom ${r.reading_id} sub-threshold`);
    }
  }
});

// ═══════════════════════ Phase 6 — the failure-mode bosses ═══════════════════════
//
// Six frozen golden anchors (one coordinated CLEAR + one naive WIPE per new boss),
// per failure-modes-pillar.md §11. Each asserts the exact outcome, ticks_played,
// and replay_hash, and that the two hashes per boss DIFFER — the "the lesson is
// real, learnable, and fair" regression. Regenerate ONLY on an intended rule change.

interface Anchor {
  policy: RaidSquadPolicy;
  outcome: 'clear' | 'wipe';
  ticks: number;
  hash: string;
}
const P6_GOLDEN: { boss: BossId; coordinated: Anchor; naive: Anchor }[] = [
  {
    boss: 'the_byzantine',
    coordinated: { policy: bftQuorumSquad, outcome: 'clear', ticks: 38, hash: 'sha256:e533088162409df5afbca9b03f069b1d904ecf4943d1dbaa21b2ff23bd436147' },
    naive: { policy: credulousSquad, outcome: 'wipe', ticks: 91, hash: 'sha256:cb237d18baf40625877ee4e61d0b2c7aae4671421296ec474e0f1c0bb134b2e6' },
  },
  {
    boss: 'deadlock',
    coordinated: { policy: orderedLockSquad, outcome: 'clear', ticks: 26, hash: 'sha256:11fbe677d5be18bb9bc8999b6827a0574efb465f1cc1043063dfaad604bd953f' },
    naive: { policy: greedyGrabSquad, outcome: 'wipe', ticks: 33, hash: 'sha256:0a5552f7b9c0f7ce774c77639224f385f06fa56982a4fe944727be68670b0f14' },
  },
  {
    boss: 'split_brain',
    coordinated: { policy: quorumPrimarySquad, outcome: 'clear', ticks: 29, hash: 'sha256:c36d373491052726b5696b76c078aa30d9a1ec000c47b75452dde3cb0f030ad7' },
    naive: { policy: dualPrimarySquad, outcome: 'wipe', ticks: 41, hash: 'sha256:1dc27f78da69d7820c751ab7f316b47d12d8e4e02234d370757673126ee000e7' },
  },
  {
    boss: 'the_latency',
    coordinated: { policy: leadingSquad, outcome: 'clear', ticks: 31, hash: 'sha256:104cc9959eca56aeae6cbc3a29b47b63e46d85419310bf7474b407d90ca75143' },
    naive: { policy: staleReactSquad, outcome: 'wipe', ticks: 100, hash: 'sha256:42989e45c735b1238861e4c8dff3273f148c69f989c12a9337e000cb55c5802a' },
  },
];

for (const g of P6_GOLDEN) {
  test(`GATE: the coordinated squad CLEARS ${g.boss} (frozen hash)`, () => {
    const r = runBossWithSquad(g.boss, g.coordinated.policy, SEED, spec);
    assert.equal(r.terminal.outcome, 'clear', `${g.boss} coordinated clears`);
    assert.equal(r.terminal.bossDefeated, true);
    assert.ok(r.finalState.units.some((u) => !u.downed), 'at least one member survives the clear');
    assert.equal(r.ticks, g.coordinated.ticks, `${g.boss} clear ticks_played`);
    assert.equal(r.replayHash, g.coordinated.hash, `${g.boss} clear replay_hash`);
  });

  test(`GATE: the naive squad WIPES ${g.boss} (frozen hash) + differs from the clear`, () => {
    const r = runBossWithSquad(g.boss, g.naive.policy, SEED, spec);
    assert.equal(r.terminal.outcome, 'wipe', `${g.boss} naive wipes`);
    assert.equal(r.ticks, g.naive.ticks, `${g.boss} wipe ticks_played`);
    assert.equal(r.replayHash, g.naive.hash, `${g.boss} wipe replay_hash`);
    // The "lesson is real" regression: the SAME encounter is a clear for the
    // coordinated squad and a wipe for the naive one — the pattern is the variable.
    assert.notEqual(r.replayHash, g.coordinated.hash, `${g.boss} clear ≠ wipe`);
  });
}

// ─────────────────────────── determinism re-sim (C1) ───────────────────────────

test('determinism: each new boss re-sims bit-for-bit from (seed, per-tick actions)', () => {
  for (const g of P6_GOLDEN) {
    for (const a of [g.coordinated, g.naive]) {
      const r = runBossWithSquad(g.boss, a.policy, SEED, spec);
      const resim = resimulateRaid(SEED, g.boss, r.inputs, spec);
      assert.deepEqual(resim.perTickHashes, r.perTickHashes, `${g.boss} per-tick chain`);
      assert.equal(resim.replayHash, r.replayHash, `${g.boss} replay hash`);
      assert.equal(resim.terminal.outcome, a.outcome);
    }
  }
});

// ───────────── projection-out-of-hash: adversarial belief ⊄ hashed state ─────────────

test('projection-out-of-hash: Byzantine faulty-member salt changes the projection, never the hash', () => {
  // Identical recorded actions re-sim to the identical chain (resolution never
  // reads the projection) — the faulty feed/spoof is out of the hash entirely.
  const base = runBossWithSquad('the_byzantine', bftQuorumSquad, SEED, spec);
  const resim = resimulateRaid(SEED, 'the_byzantine', base.inputs, spec);
  assert.deepEqual(resim.perTickHashes, base.perTickHashes);

  // The projection is GENUINELY salt-dependent (a different faulty member) while
  // the state it is built from is byte-identical — belief lives only in the frame.
  let s = createInitialRaidState(SEED, 'the_byzantine', spec);
  for (let i = 0; i < 8; i++) s = resolveRaidTick(s, bftQuorumSquad(s.members.map((m) => buildRaidObservation(s, m))));
  const alive = s.units.filter((u) => !u.downed).map((u) => u.memberId);
  assert.notDeepEqual(
    [...byzantineFaulty(SEED, s.boss.phase, alive, 0)],
    [...byzantineFaulty(SEED, s.boss.phase, alive, 2)],
    'a different salt marks a different faulty member',
  );
  const spoofedAt = (salt: number): string[] =>
    [...new Set(s.members.flatMap((m) => (buildRaidObservation(s, m, { phantomSalt: salt }).consensus_advisories ?? []).filter((a) => !a.real).map((a) => a.from_member)))].sort();
  assert.notDeepEqual(spoofedAt(0), spoofedAt(2), 'the spoofed broadcast shifts with the salt');
  assert.equal(raidStateHash(s), raidStateHash(s), 'the state hash carries no byte of the corruption');
});

test('projection-out-of-hash: Split-Brain partition salt changes the split, never the hash', () => {
  const base = runBossWithSquad('split_brain', quorumPrimarySquad, SEED, spec);
  const resim = resimulateRaid(SEED, 'split_brain', base.inputs, spec);
  assert.deepEqual(resim.perTickHashes, base.perTickHashes);

  // Advance into a partition window; the partition membership + cross-group hiding
  // differ under a different salt while the whole hashed state is unchanged.
  let s = createInitialRaidState(SEED, 'split_brain', spec);
  for (let i = 0; i < 23 && !isRaidTerminal(s).over; i++) {
    s = resolveRaidTick(s, quorumPrimarySquad(s.members.map((m) => buildRaidObservation(s, m))));
  }
  const alive = s.units.filter((u) => !u.downed).map((u) => u.memberId);
  const groupsAt = (salt: number): string => alive.map((m) => partitionGroup(SEED, 0, alive, m, salt)).join('');
  assert.notEqual(groupsAt(0), groupsAt(4), 'a different salt repartitions the squad');
  const framesAt = (salt: number): string => s.members.map((m) => buildRaidObservation(s, m, { phantomSalt: salt }).partition?.group ?? '-').join('');
  assert.notEqual(framesAt(0), framesAt(4), 'the per-member partition banner shifts with the salt');
  assert.equal(raidStateHash(s), raidStateHash(s), 'the split leaves the hashed state whole');
});

test('projection-out-of-hash: The Latency delay salt changes the stale view, never the hash', () => {
  // Identical recorded actions re-sim to the identical chain — resolution never
  // reads the delay projection; the stale readout is out of the hash entirely.
  const base = runBossWithSquad('the_latency', leadingSquad, SEED, spec);
  const resim = resimulateRaid(SEED, 'the_latency', base.inputs, spec);
  assert.deepEqual(resim.perTickHashes, base.perTickHashes);

  // Advance a few ticks, then show the STALE readout genuinely shifts with the salt
  // (a different delay) while the TELEGRAPH (true current cell) and the hashed state
  // are both salt-independent — belief lives only in the frame.
  let s = createInitialRaidState(SEED, 'the_latency', spec);
  for (let i = 0; i < 10 && !isRaidTerminal(s).over; i++) {
    s = resolveRaidTick(s, leadingSquad(s.members.map((m) => buildRaidObservation(s, m))));
  }
  const phase = s.boss.phase;
  assert.notDeepEqual(
    latencyObservedCell(SEED, s.tick, phase, 0),
    latencyObservedCell(SEED, s.tick, phase, 2),
    'a different salt shifts the stale exposed-cell readout',
  );
  const observedAt = (salt: number): string =>
    s.members.map((m) => (buildRaidObservation(s, m, { phantomSalt: salt }).delay?.observed_cell ?? []).join(',')).join('|');
  const leadAt = (salt: number): string =>
    s.members.map((m) => (buildRaidObservation(s, m, { phantomSalt: salt }).delay?.lead_cell ?? []).join(',')).join('|');
  assert.notEqual(observedAt(0), observedAt(2), 'the per-member stale view shifts with the salt');
  assert.equal(leadAt(0), leadAt(2), 'the telegraphed current cell is the truth — salt-independent');
  // The telegraph is exactly the real live cell the mechanics award damage on.
  assert.deepEqual(
    buildRaidObservation(s, s.members[0]).delay?.lead_cell,
    latencyLiveCell(SEED, s.tick),
    'lead_cell == the real current live cell (the hashed damage target)',
  );
  assert.equal(raidStateHash(s), raidStateHash(s), 'the stale view carries no byte into the hash');
});

// ─────────────────────────── the registry / framework ───────────────────────────

test('registry: all six bosses are registered with the failure-mode metadata + hooks', () => {
  const ids: BossId[] = ['the_hallucinator', 'the_overfit', 'the_byzantine', 'deadlock', 'split_brain', 'the_latency'];
  for (const id of ids) {
    const d = BOSS_CATALOG[id];
    assert.equal(d.boss_id, id);
    assert.ok(d.failure_mode && d.robust_pattern && d.lesson, `${id} has codex metadata`);
    assert.ok(Array.isArray(d.channels) && d.channels.length >= 1, `${id} declares ≥1 channel`);
    assert.ok(typeof BOSS_MODULES[id].policy === 'function', `${id} has a policy`);
  }
  // The projection channels declare a projection hook; the hashed-mechanic ones a
  // mechanics hook (Overfit's counter-table + all three new bosses).
  assert.ok(BOSS_MODULES.the_byzantine.projectObservation, 'Byzantine projects advisories');
  assert.ok(BOSS_MODULES.split_brain.projectObservation, 'Split-Brain projects the partition');
  assert.ok(BOSS_MODULES.the_byzantine.applyChannelMechanics, 'Byzantine has a mechanics hook');
  assert.ok(BOSS_MODULES.deadlock.applyChannelMechanics, 'Deadlock has a mechanics hook');
  assert.ok(BOSS_MODULES.split_brain.applyChannelMechanics, 'Split-Brain has a mechanics hook');
  assert.ok(BOSS_MODULES.the_overfit.applyChannelMechanics, 'Overfit folds in as a mechanics hook');
  assert.ok(BOSS_MODULES.the_latency.projectObservation, 'The Latency projects the delay banner');
  assert.ok(BOSS_MODULES.the_latency.applyChannelMechanics, 'The Latency has a mechanics hook');
  assert.equal(BOSS_CATALOG.the_latency.channels[0], 'delay', 'The Latency delivers through the delay channel');
});
