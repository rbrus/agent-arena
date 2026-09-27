/**
 * Leakage (non-interference) for Diplomacy observations (docs/design/diplomacy-adjudicator.md
 * §4.5, §6.2; diplomacy-scenario.md §1.6–§1.7), with positive controls: a deliberately leaky
 * observer must be caught on every surface, and a visible mutation must change the bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/rng.ts';
import { buildDipObservation, canonicalObservation, PROJECTION_TAG } from '../src/diplomacy/observation.ts';
import { dipAct, dipInit, dipObserve, dipTick, projectForPower, type DipEpisode } from '../src/diplomacy/scenario.ts';
import {
  DIP_LEAK_SURFACES,
  hiddenSurfaceData,
  leakyObserve,
  mutateHidden,
  mutateVisible,
  nonInterference,
  type ObserveFn,
} from '../src/diplomacy/testing/leak-hooks.ts';
import { scriptedDipAction } from '../src/diplomacy/testing/scripted-press.ts';
import { POWERS, type Power } from '../src/diplomacy/types.ts';

/** Snapshots of a scripted game with press, taken AFTER actions are buffered (pending is live). */
function snapshots(seed: number, every: number): DipEpisode[] {
  const out: DipEpisode[] = [];
  let ep = dipInit(seed, 'core', { horizonYear: 1904, secret: `secret-${seed}` });
  while (!ep.terminal) {
    for (const p of POWERS) ep = dipAct(ep, p, scriptedDipAction(dipObserve(ep, p), { orderSeed: seed, pressSalt: seed }));
    if (ep.tick % every === 0) out.push(ep);
    ep = dipTick(ep).ep;
  }
  out.push(ep);
  return out;
}

const SNAPS = [...snapshots(5, 2), ...snapshots(6, 3)];
const observe: ObserveFn = (ep, p) => dipObserve(ep, p);

test('fixture sanity: snapshots cover pending actions, press, offers, commitments, intents and rejects', () => {
  assert.ok(SNAPS.length > 30);
  assert.ok(SNAPS.some((e) => Object.keys(e.pending).length === 7));
  assert.ok(SNAPS.some((e) => e.press.log.length > 20 && e.press.commitments.length > 0 && e.press.intents.length > 0));
  assert.ok(SNAPS.some((e) => Object.values(e.feedback).some((r) => (r?.length ?? 0) > 0)));
  assert.ok(SNAPS.some((e) => e.step.kind === 'press') && SNAPS.some((e) => e.step.kind === 'orders') && SNAPS.some((e) => e.step.kind === 'intent'));
});

test('non-interference: every hidden surface, every viewer, byte-identical observations', () => {
  const rng = mulberry32(0xd1f);
  let checks = 0;
  for (const ep of SNAPS) {
    for (const viewer of POWERS) {
      for (const s of DIP_LEAK_SURFACES) {
        assert.ok(nonInterference(observe, ep, viewer, rng, s), `leak: surface ${s}, viewer ${viewer}, tick ${ep.tick} (${ep.step.kind})`);
        checks++;
      }
    }
  }
  assert.equal(checks, SNAPS.length * POWERS.length * DIP_LEAK_SURFACES.length);
});

test('positive control: a deliberately leaky observer is caught on every surface', () => {
  const rng = mulberry32(0xbad);
  for (const s of DIP_LEAK_SURFACES) {
    const leaky = leakyObserve(s);
    let caught = 0;
    for (const ep of SNAPS.slice(0, 20)) {
      const viewer = POWERS[Math.floor(rng() * 7)];
      if (!nonInterference(leaky, ep, viewer, rng, s)) caught++;
    }
    assert.equal(caught, 20, `leaky observer for ${s} escaped the fuzzer`);
  }
});

test('positive control: each mutation really changes its surface, and visible mutations change the bytes', () => {
  const rng = mulberry32(7);
  for (const ep of SNAPS.slice(0, 15)) {
    const viewer = POWERS[Math.floor(rng() * 7)];
    for (const s of DIP_LEAK_SURFACES) {
      const before = JSON.stringify(hiddenSurfaceData(ep, viewer, s));
      const after = JSON.stringify(hiddenSurfaceData(mutateHidden(ep, viewer, rng, s), viewer, s));
      assert.notEqual(after, before, `mutateHidden(${s}) did not change its surface`);
    }
    for (let i = 0; i < 4; i++) {
      assert.notEqual(canonicalObservation(observe(mutateVisible(ep, viewer, rng), viewer)), canonicalObservation(observe(ep, viewer)));
    }
  }
});

test('structural: no observation ever contains another power\'s codeword, intent id, or a message it was not party to', () => {
  for (const ep of SNAPS) {
    for (const viewer of POWERS) {
      const json = JSON.stringify(dipObserve(ep, viewer));
      for (const p of POWERS) if (p !== viewer) assert.ok(!json.includes(ep.briefs[p].codeword), `${viewer} sees ${p}'s codeword`);
      assert.ok(json.includes(ep.briefs[viewer].codeword));
      for (const v of ep.press.intents) if (v.power !== viewer) assert.ok(!json.includes(`"${v.id}"`));
      for (const m of ep.press.log) {
        if (m.from !== viewer && !m.recipients.includes(viewer)) assert.ok(!json.includes(`"${m.msg_id}"`), `${viewer} sees ${m.msg_id}`);
      }
      for (const sig of Object.values(ep.press.signatures)) if (sig !== 'session') assert.ok(!json.includes(sig));
      assert.ok(!json.includes(ep.config.secret));
    }
  }
});

test('builder: takes a projection only (type-enforced), and re-filters private lists by the viewer', () => {
  const ep = SNAPS[SNAPS.length - 1];
  // @ts-expect-error — the builder cannot be handed the episode (hidden state) by construction.
  assert.throws(() => buildDipObservation(ep));
  // Defence in depth: a projector bug that put foreign items into the private lists is filtered.
  const viewer: Power = 'austria';
  const proj = projectForPower(ep, viewer);
  const foreign = ep.press.log.filter((m) => m.from !== viewer && !m.recipients.includes(viewer));
  const bad = {
    ...proj,
    tag: PROJECTION_TAG,
    inbox: { messages: [...proj.inbox.messages, ...foreign] },
    own: {
      ...proj.own,
      sent: [...proj.own.sent, ...foreign],
      offers: [...proj.own.offers, ...ep.press.offers.filter((o) => o.from !== viewer && o.to !== viewer)],
      commitments: [...proj.own.commitments, ...ep.press.commitments.filter((c) => !c.parties.includes(viewer))],
      intent: ep.press.intents.find((v) => v.power !== viewer) ?? proj.own.intent,
      rejects: [...proj.own.rejects, ...ep.press.rejects.filter((r) => r.power !== viewer)],
    },
  };
  assert.equal(canonicalObservation(buildDipObservation(bad)), canonicalObservation(buildDipObservation(proj)));
});

test('determinism: observing is pure and idempotent', () => {
  for (const ep of SNAPS.slice(0, 10)) {
    for (const p of POWERS) assert.equal(canonicalObservation(dipObserve(ep, p)), canonicalObservation(dipObserve(ep, p)));
  }
});
