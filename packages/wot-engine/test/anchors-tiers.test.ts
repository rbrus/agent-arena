/**
 * Tier + duel + gate golden anchors (Phase 7 B2a). Engine APIs only.
 *
 * The twelve Core raid anchors stay frozen in raid.test.ts (unchanged). Budget
 * tiers change `remaining`, which is hashed (raid/hash.ts), so a Core anchor
 * certifies Core only; this file freezes the other classes:
 *   - 24 raid anchors: 6 bosses × {coordinated, naive} × {edge, frontier} at seed
 *     20260720, reference comp, tier applied ONLY through `config.allowance`
 *     (edge 160, frontier 360). Coordinated CLEARS / naive WIPES in every tier;
 *   - the duel golden pair, target = seat A vs a FRESH house bot `silver`, in all
 *     three tiers, at seed 20260720 and seed 2. Finding: at Edge the S0 pair does
 *     not separate (reflex loses by elimination @111); seed 2 separates in all
 *     three tiers and is the duel golden pair;
 *   - the five Byzantine gate seeds (20260720, 1, 2, 3, 5), squad seating, Core,
 *     coordinated + naive (distinct coordinated trajectories);
 *   - C2e (2026-09-26): the same gate seeds 1, 2, 3, 5 at Edge and Frontier
 *     (seed 20260720 is in TIER_ANCHORS), coordinated + naive, so every
 *     (gate seed x tier) cell is frozen. Values computed from this engine and
 *     identical across two runs; outcome and tick are tier-invariant.
 * The same values drive the arena-scenarios self-tests (packages/arena-scenarios/
 * src/anchors.ts), which prove the Scenario adapter reproduces them.
 *
 * Regenerate ONLY on an intended rule change (a documented, versioned re-freeze).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bftQuorumSquad,
  buildObservation,
  consensusSquad,
  createInitialState,
  credulousSquad,
  diverseSquad,
  dualPrimarySquad,
  foldHash,
  greedyGrabSquad,
  greedySquad,
  isTerminal,
  leadingSquad,
  naiveSquad,
  orderedLockSquad,
  quorumPrimarySquad,
  resimulateRaid,
  resolveTick,
  runRaid,
  staleReactSquad,
  stateHash,
  type BossId,
  type Player,
  type RaidSquadPolicy,
  type UnitAction,
} from '../src/index.ts';
import type { Observation } from 'wot-contracts';
import { createHouseBot } from '../../../agents/house-bot/policy.ts';
import { reflexPolicy } from '../../../agents/reflex/policy.ts';

const S0 = 20260720;
const TIERS = {
  edge: { allowance: 160, ds: 800, dh: 1600 },
  core: { allowance: 240, ds: 1500, dh: 3000 },
  frontier: { allowance: 360, ds: 3000, dh: 6000 },
} as const;
type Tier = keyof typeof TIERS;

interface RaidAnchor {
  boss: BossId;
  tier: Tier;
  squad: 'coordinated' | 'naive';
  policy: RaidSquadPolicy;
  outcome: 'clear' | 'wipe';
  ticks: number;
  hash: string;
}

const TIER_ANCHORS: RaidAnchor[] = [
  { boss: 'the_hallucinator', tier: 'edge', squad: 'coordinated', policy: consensusSquad, outcome: 'clear', ticks: 61, hash: 'sha256:f5ea13187ef5ffad57b80d88b6a54cc97f8b175d3ab0cfe0cea6bdc91b18a796' },
  { boss: 'the_hallucinator', tier: 'edge', squad: 'naive', policy: naiveSquad, outcome: 'wipe', ticks: 23, hash: 'sha256:4b2a675c9a1406e3ddcd65c1ae8943824a89f226e9755e1f867882f0ebb9b87e' },
  { boss: 'the_overfit', tier: 'edge', squad: 'coordinated', policy: diverseSquad, outcome: 'clear', ticks: 73, hash: 'sha256:9c417211451d3a8387a83ff8583114e0d93aae61a13e8bf7cb59ed46f2415deb' },
  { boss: 'the_overfit', tier: 'edge', squad: 'naive', policy: greedySquad, outcome: 'wipe', ticks: 100, hash: 'sha256:bf219e942cb9628e6649b34138c2c9b0d5010b9a0dced2007de04aba14b5ed7f' },
  { boss: 'the_byzantine', tier: 'edge', squad: 'coordinated', policy: bftQuorumSquad, outcome: 'clear', ticks: 38, hash: 'sha256:85607e58065c2b04bd196260968fa311baf03b6f1e9d6bfec04e516a57575f98' },
  { boss: 'the_byzantine', tier: 'edge', squad: 'naive', policy: credulousSquad, outcome: 'wipe', ticks: 91, hash: 'sha256:69ff2aebf5da4d140137acbac4f735a572477dee540c2000ce5332c115f4a72c' },
  { boss: 'deadlock', tier: 'edge', squad: 'coordinated', policy: orderedLockSquad, outcome: 'clear', ticks: 26, hash: 'sha256:270e7df970729888bd8dd2afcbeb38438347369425d3cc17e20ac03fc138b050' },
  { boss: 'deadlock', tier: 'edge', squad: 'naive', policy: greedyGrabSquad, outcome: 'wipe', ticks: 33, hash: 'sha256:8eff9a01e11fa4fd70e75581663762ed39db44b08f9ed8e2c3728c237fda7a28' },
  { boss: 'split_brain', tier: 'edge', squad: 'coordinated', policy: quorumPrimarySquad, outcome: 'clear', ticks: 29, hash: 'sha256:8ab8e99956c43f6e1d049f110829aa3a042e8db3f983c6ec4695c1aa08d65451' },
  { boss: 'split_brain', tier: 'edge', squad: 'naive', policy: dualPrimarySquad, outcome: 'wipe', ticks: 41, hash: 'sha256:0bbcb688863f9b809ee2e77dc4a25a9c1887db2a7bd41db680c6375ca1643292' },
  { boss: 'the_latency', tier: 'edge', squad: 'coordinated', policy: leadingSquad, outcome: 'clear', ticks: 31, hash: 'sha256:6209f008da772ad777003ac6727a141ae9c16e27b4c70509b63df129969efd6f' },
  { boss: 'the_latency', tier: 'edge', squad: 'naive', policy: staleReactSquad, outcome: 'wipe', ticks: 100, hash: 'sha256:904a8abd501a12e56c00c7ed3de4c3a1f7a63e1d43ea3458115ded4fe2ebf909' },
  { boss: 'the_hallucinator', tier: 'frontier', squad: 'coordinated', policy: consensusSquad, outcome: 'clear', ticks: 61, hash: 'sha256:f331691795e06ab0dc7daef9338533891510e9b4f17613a5969b119888bbf731' },
  { boss: 'the_hallucinator', tier: 'frontier', squad: 'naive', policy: naiveSquad, outcome: 'wipe', ticks: 23, hash: 'sha256:2a785824c50482e3a69522ccd8569e85501d1ac379da3dd365077fe220252401' },
  { boss: 'the_overfit', tier: 'frontier', squad: 'coordinated', policy: diverseSquad, outcome: 'clear', ticks: 73, hash: 'sha256:0734119b3ad13b7536c9e6ad1a5a8082ec1debf4b22cca1a82160438279bfdbf' },
  { boss: 'the_overfit', tier: 'frontier', squad: 'naive', policy: greedySquad, outcome: 'wipe', ticks: 100, hash: 'sha256:20b6a344c7499392cc5df333034b385bfa9e466564ba2b3a689db8427527e46f' },
  { boss: 'the_byzantine', tier: 'frontier', squad: 'coordinated', policy: bftQuorumSquad, outcome: 'clear', ticks: 38, hash: 'sha256:48e6ba1161f61cf23b66b6e6bb0f844af7a237ed70bd8e1d93cd2fcc7720c47c' },
  { boss: 'the_byzantine', tier: 'frontier', squad: 'naive', policy: credulousSquad, outcome: 'wipe', ticks: 91, hash: 'sha256:42a52fec355923be5048b367645ed421b1acf853dd53775235342ab7a068127f' },
  { boss: 'deadlock', tier: 'frontier', squad: 'coordinated', policy: orderedLockSquad, outcome: 'clear', ticks: 26, hash: 'sha256:f96a16147083e80ec31fdf5c46838aa9caf071d30a2c372a066304f341f5a91b' },
  { boss: 'deadlock', tier: 'frontier', squad: 'naive', policy: greedyGrabSquad, outcome: 'wipe', ticks: 33, hash: 'sha256:be138b9d30c9b46ce54d9662af827efc0d50b39fc2dba246d8d1ea71717f107a' },
  { boss: 'split_brain', tier: 'frontier', squad: 'coordinated', policy: quorumPrimarySquad, outcome: 'clear', ticks: 29, hash: 'sha256:67c837406dccad6e620ee1a158323ddc5c85fab0bd04b32434a7b22fb00dd2f1' },
  { boss: 'split_brain', tier: 'frontier', squad: 'naive', policy: dualPrimarySquad, outcome: 'wipe', ticks: 41, hash: 'sha256:3c31d4237a7f2d445e1971a312760f2b5587e8de05d95c8c384fad79e8e02f53' },
  { boss: 'the_latency', tier: 'frontier', squad: 'coordinated', policy: leadingSquad, outcome: 'clear', ticks: 31, hash: 'sha256:2fd91d34422b604237a48a123d413c55f25cd2d462f82081b6c87b8eee271e7e' },
  { boss: 'the_latency', tier: 'frontier', squad: 'naive', policy: staleReactSquad, outcome: 'wipe', ticks: 100, hash: 'sha256:4eefe498892fd23eadb004bf121bf21442ebf62a83010aeee21100c3b3948d62' },
];

const DUEL_ANCHORS: { tier: Tier; seed: number; target: 'reflex' | 'null'; outcome: 'win' | 'loss'; ticks: number; hash: string }[] = [
  { tier: 'edge', seed: 20260720, target: 'reflex', outcome: 'loss', ticks: 111, hash: 'sha256:c4b87fc7517480ff7447c24206ea043da548c05fd42415565157224b512dda9f' },
  { tier: 'edge', seed: 20260720, target: 'null', outcome: 'loss', ticks: 91, hash: 'sha256:eea0cc0e65f628afcadd3e722820779b88c9d83decde048d3acc3cc3071fac4d' },
  { tier: 'core', seed: 20260720, target: 'reflex', outcome: 'win', ticks: 111, hash: 'sha256:25437dfbac708751a2790ff60751aee006f8f8f4cb57ce2d8f8fbb0c5ebb14d0' },
  { tier: 'core', seed: 20260720, target: 'null', outcome: 'loss', ticks: 86, hash: 'sha256:f74e6b5d123615047a68b0ae48b2cb561e3d9d8c4a62a4494327322f9cb6a53c' },
  { tier: 'frontier', seed: 20260720, target: 'reflex', outcome: 'win', ticks: 111, hash: 'sha256:d39765ca13a2594a4bed0fe3070e92327a89eec29864c9b28960ac14a1982c95' },
  { tier: 'frontier', seed: 20260720, target: 'null', outcome: 'loss', ticks: 91, hash: 'sha256:389d8db2b8e71c17ae05f0933c40c10346a8995bf2db2344f74360fe6e8df8a6' },
  { tier: 'edge', seed: 2, target: 'reflex', outcome: 'win', ticks: 69, hash: 'sha256:94a339b83deb799156550f2caf8df77f5ab2dcdf3729bb2196a8df9ffd94b447' },
  { tier: 'edge', seed: 2, target: 'null', outcome: 'loss', ticks: 91, hash: 'sha256:eea0cc0e65f628afcadd3e722820779b88c9d83decde048d3acc3cc3071fac4d' },
  { tier: 'core', seed: 2, target: 'reflex', outcome: 'win', ticks: 87, hash: 'sha256:a931933049e41298074efe767b0bef441b9a77a01c30f846171916ba696adc42' },
  { tier: 'core', seed: 2, target: 'null', outcome: 'loss', ticks: 86, hash: 'sha256:f74e6b5d123615047a68b0ae48b2cb561e3d9d8c4a62a4494327322f9cb6a53c' },
  { tier: 'frontier', seed: 2, target: 'reflex', outcome: 'win', ticks: 111, hash: 'sha256:dc026a219bca3304bba43b7955dd708eb5283be0d353dfa846bd4e7e82aec2e0' },
  { tier: 'frontier', seed: 2, target: 'null', outcome: 'loss', ticks: 91, hash: 'sha256:389d8db2b8e71c17ae05f0933c40c10346a8995bf2db2344f74360fe6e8df8a6' },
];

const BYZANTINE_GATE: { tier: Tier; seed: number; squad: 'coordinated' | 'naive'; outcome: 'clear' | 'wipe'; ticks: number; hash: string }[] = [
  { tier: 'core', seed: 20260720, squad: 'coordinated', outcome: 'clear', ticks: 38, hash: 'sha256:e533088162409df5afbca9b03f069b1d904ecf4943d1dbaa21b2ff23bd436147' },
  { tier: 'core', seed: 20260720, squad: 'naive', outcome: 'wipe', ticks: 91, hash: 'sha256:cb237d18baf40625877ee4e61d0b2c7aae4671421296ec474e0f1c0bb134b2e6' },
  { tier: 'core', seed: 1, squad: 'coordinated', outcome: 'clear', ticks: 42, hash: 'sha256:496336f941eefca983ac93b6ec08194d15c2f1b9bbc00c068e51e6a2593c5357' },
  { tier: 'core', seed: 1, squad: 'naive', outcome: 'wipe', ticks: 93, hash: 'sha256:83ec133031c9ce04bd25520f868f857f8e1908782c1b1cacc1b1c89d7ca6c594' },
  { tier: 'core', seed: 2, squad: 'coordinated', outcome: 'clear', ticks: 65, hash: 'sha256:7e82de4456786ea8cd0fba17919634800ac667ce59fd4e6ad3649c691f254d10' },
  { tier: 'core', seed: 2, squad: 'naive', outcome: 'wipe', ticks: 23, hash: 'sha256:1860ed7006d2bd4d2acfda3c2ee075498c48dab4ae73e228065205fbecc00fa1' },
  { tier: 'core', seed: 3, squad: 'coordinated', outcome: 'clear', ticks: 63, hash: 'sha256:90bfb698ffa429bfec5e203c099bf8800bf9aef5fe3466e2aca45dc74e119159' },
  { tier: 'core', seed: 3, squad: 'naive', outcome: 'wipe', ticks: 91, hash: 'sha256:054dfb16c9c522f34076d1fa7016b7e110c7d5a58c6173a6d15340f35d6ee674' },
  { tier: 'core', seed: 5, squad: 'coordinated', outcome: 'clear', ticks: 52, hash: 'sha256:960d8eef99ff19d9b4356a792fcc105f7ae7001e2c31af7e2abbf82af974ba96' },
  { tier: 'core', seed: 5, squad: 'naive', outcome: 'wipe', ticks: 45, hash: 'sha256:70765d850488ad2827e99e9a94dd0054963df7fc0ecf1bc6fd7fc69353bf358d' },
  // C2e: Edge / Frontier, gate seeds 1, 2, 3, 5.
  { tier: 'edge', seed: 1, squad: 'coordinated', outcome: 'clear', ticks: 42, hash: 'sha256:357302742161c5767e2daedf273ef3fd8c26a7488479cefbad3d74494cff874a' },
  { tier: 'edge', seed: 1, squad: 'naive', outcome: 'wipe', ticks: 93, hash: 'sha256:b97879f1571bfaf2445240f7db4ccf2af41b7fa4a8ef73bf643d144bdee8ec30' },
  { tier: 'edge', seed: 2, squad: 'coordinated', outcome: 'clear', ticks: 65, hash: 'sha256:d5ce9cb1c493249984925a771d1a5e3ef6f2e722d14f2e56fcdb260de7030b12' },
  { tier: 'edge', seed: 2, squad: 'naive', outcome: 'wipe', ticks: 23, hash: 'sha256:4105cd4221d65269f326c5395117a709dc840a8fa0cad6cb31576d5d6104b8a5' },
  { tier: 'edge', seed: 3, squad: 'coordinated', outcome: 'clear', ticks: 63, hash: 'sha256:188015b02487d5a29576122983a8ba83771dc0ca043061ddf72b9eebac3a3848' },
  { tier: 'edge', seed: 3, squad: 'naive', outcome: 'wipe', ticks: 91, hash: 'sha256:94b3c07da7c415deed625e034532ce0ac79534258b4a4d827a6f3cd713fc8816' },
  { tier: 'edge', seed: 5, squad: 'coordinated', outcome: 'clear', ticks: 52, hash: 'sha256:61b623e32e846c8daa73634b44fd15b063fc51d605763f9b46e8620d465dede8' },
  { tier: 'edge', seed: 5, squad: 'naive', outcome: 'wipe', ticks: 45, hash: 'sha256:5047ab8f1e7b82aa19de113c1fe3ebeaaf710618e3bdbbc1b6a9fbcf00e31ae8' },
  { tier: 'frontier', seed: 1, squad: 'coordinated', outcome: 'clear', ticks: 42, hash: 'sha256:9f9947b83a3dd1a9fc422a375b847745f369471be286c6a00bf35194dee454a3' },
  { tier: 'frontier', seed: 1, squad: 'naive', outcome: 'wipe', ticks: 93, hash: 'sha256:2e839606f3dbb664f48dda1ac30b03fe97f48d4ebc515f13b37c3887ba970814' },
  { tier: 'frontier', seed: 2, squad: 'coordinated', outcome: 'clear', ticks: 65, hash: 'sha256:3af69e7c8c8fbc8de12a66a0457fb605b81fbf9c92846ecc7bac7b75a3322cd1' },
  { tier: 'frontier', seed: 2, squad: 'naive', outcome: 'wipe', ticks: 23, hash: 'sha256:cc5869f45853435746ecccf29bef317967d9d7836f4379be0d1c7d1e7fa2016b' },
  { tier: 'frontier', seed: 3, squad: 'coordinated', outcome: 'clear', ticks: 63, hash: 'sha256:72994917c4fee22b01130238b316d9bfc86a1fc46296a4b459ad685eb141bdc6' },
  { tier: 'frontier', seed: 3, squad: 'naive', outcome: 'wipe', ticks: 91, hash: 'sha256:7195ac3ec69ac737dcc6b7db17d1f1ad107bb1973c6978948925852263443a06' },
  { tier: 'frontier', seed: 5, squad: 'coordinated', outcome: 'clear', ticks: 52, hash: 'sha256:3b8ed661a171a0273e02169ef424c9cdb854e70c4e6ee32045cf945a1904aa6f' },
  { tier: 'frontier', seed: 5, squad: 'naive', outcome: 'wipe', ticks: 45, hash: 'sha256:709fc8b82d021593c54e849f97da4c0a456b681778a0640c5a46dc75bb7b223c' },
];

for (const a of TIER_ANCHORS) {
  test(`ANCHOR: ${a.boss} ${a.tier} seed ${S0} squad ${a.squad} → ${a.outcome} @${a.ticks} (frozen hash)`, () => {
    const r = runRaid(S0, a.boss, a.policy, undefined, { config: { allowance: TIERS[a.tier].allowance } });
    assert.equal(r.terminal.outcome, a.outcome);
    assert.equal(r.ticks, a.ticks);
    assert.equal(r.replayHash, a.hash);
    const resim = resimulateRaid(S0, a.boss, r.inputs, undefined, { config: { allowance: TIERS[a.tier].allowance } });
    assert.equal(resim.replayHash, a.hash, 'replays bit-for-bit from (seed, tier, inputs)');
  });
}

test('tier anchors: coordinated CLEARS / naive WIPES in every tier; hashes differ across tiers', () => {
  for (const tier of ['edge', 'frontier'] as const) {
    for (const boss of new Set(TIER_ANCHORS.map((a) => a.boss))) {
      const c = TIER_ANCHORS.find((a) => a.boss === boss && a.tier === tier && a.squad === 'coordinated')!;
      const n = TIER_ANCHORS.find((a) => a.boss === boss && a.tier === tier && a.squad === 'naive')!;
      assert.equal(c.outcome, 'clear');
      assert.equal(n.outcome, 'wipe');
      assert.notEqual(c.hash, n.hash);
    }
  }
  assert.equal(new Set(TIER_ANCHORS.map((a) => a.hash)).size, TIER_ANCHORS.length);
});

/** The duel loop: target seat A, a fresh silver house bot as B (the adapter's opponent). */
function duel(seed: number, tier: Tier, target: 'reflex' | 'null') {
  const t = TIERS[tier];
  let state = createInitialState(seed, { config: { allowance: t.allowance } });
  let chain = stateHash(state);
  const bot = createHouseBot('silver');
  const frame = (p: Player): Observation => buildObservation(state, p, state.tick, 'n0000000', t.ds, t.dh);
  for (let i = 0; i < 1000; i++) {
    const b = bot(frame('B')).units as UnitAction[];
    const a = target === 'reflex' ? (reflexPolicy(frame('A')).units as UnitAction[]) : [];
    state = resolveTick(state, { A: a, B: b });
    chain = foldHash(chain, stateHash(state));
    const term = isTerminal(state);
    if (term.over) return { winner: term.winner, ticks: state.tick, hash: chain };
  }
  throw new Error('duel did not terminate');
}

for (const d of DUEL_ANCHORS) {
  test(`ANCHOR: grid_tactics ${d.tier} seed ${d.seed} A ${d.target} vs silver → ${d.outcome} @${d.ticks} (frozen hash)`, () => {
    const r = duel(d.seed, d.tier, d.target);
    assert.equal(r.winner === 'A' ? 'win' : 'loss', d.outcome);
    assert.equal(r.ticks, d.ticks);
    assert.equal(r.hash, d.hash);
  });
}

test('duel golden pair: seed 2 separates in all three tiers (reflex wins, null loses)', () => {
  for (const tier of ['edge', 'core', 'frontier'] as const) {
    assert.equal(DUEL_ANCHORS.find((d) => d.seed === 2 && d.tier === tier && d.target === 'reflex')!.outcome, 'win');
    assert.equal(DUEL_ANCHORS.find((d) => d.seed === 2 && d.tier === tier && d.target === 'null')!.outcome, 'loss');
  }
});

for (const g of BYZANTINE_GATE) {
  test(`ANCHOR (gate): the_byzantine ${g.tier} seed ${g.seed} squad ${g.squad} → ${g.outcome} @${g.ticks} (frozen hash)`, () => {
    const opts = g.tier === 'core' ? undefined : { config: { allowance: TIERS[g.tier].allowance } };
    const r = runRaid(g.seed, 'the_byzantine', g.squad === 'coordinated' ? bftQuorumSquad : credulousSquad, undefined, opts);
    assert.equal(r.terminal.outcome, g.outcome);
    assert.equal(r.ticks, g.ticks);
    assert.equal(r.replayHash, g.hash);
    if (opts) {
      const resim = resimulateRaid(g.seed, 'the_byzantine', r.inputs, undefined, opts);
      assert.equal(resim.replayHash, g.hash, 'replays bit-for-bit from (seed, tier, inputs)');
    }
  });
}

test('Byzantine gate: every (gate seed x tier) cell is frozen; outcome and tick are tier-invariant; hashes are distinct', () => {
  const all = [
    ...BYZANTINE_GATE,
    ...TIER_ANCHORS.filter((a) => a.boss === 'the_byzantine').map((a) => ({ tier: a.tier, seed: S0, squad: a.squad, outcome: a.outcome, ticks: a.ticks, hash: a.hash })),
  ];
  for (const seed of [S0, 1, 2, 3, 5]) {
    for (const squad of ['coordinated', 'naive'] as const) {
      const cells = (['edge', 'core', 'frontier'] as const).map((tier) => all.find((g) => g.seed === seed && g.tier === tier && g.squad === squad));
      assert.ok(cells.every(Boolean), `seed ${seed} ${squad}: all three tiers frozen`);
      assert.equal(new Set(cells.map((c) => `${c!.outcome}@${c!.ticks}`)).size, 1, `seed ${seed} ${squad}: tier-invariant outcome`);
      assert.equal(cells[0]!.outcome, squad === 'coordinated' ? 'clear' : 'wipe');
    }
  }
  assert.equal(new Set(all.map((g) => g.hash)).size, all.length, 'thirty distinct hashes');
});
