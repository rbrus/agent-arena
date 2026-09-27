/**
 * Regression (flaky chaos case 3, 2026-09-27): a step must resolve exactly once.
 *
 * `DiplomacyTable.maybeResolve` deferred `resolve()` with `setImmediate` on EVERY accepted
 * frame once all prompted seats had answered. A second frame for the same step inside the
 * same I/O turn (a duplicate, or any seat's "latest replaces" re-send) queued a second
 * `resolve()`. The first closed step N and prompted step N+1; the second then found
 * `resolved === false` and closed step N+1 at once with no agent answers: every prompted
 * seat took a hard miss and step N+1's batch (the chaos press flood) never reached the
 * engine. One seat could thereby make the other six miss a step. The chaos suite hit it
 * only when the attacker's duplicate pair landed in the same poll phase as the completing
 * frame (load-dependent); this test drives the table directly, so it is deterministic.
 *
 * Run: cd ascension && WOT_ENV=test node --test --import tsx services/arena/test/diplomacy-resolve-once.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POWERS, type Power } from 'wot-engine';
import { DiplomacyTable, type DipSeatSide } from '../src/diplomacy/table.ts';

type Frame = Record<string, unknown>;
const turn = () => new Promise<void>((r) => setImmediate(r));

function table() {
  const inbox = new Map<Power, Frame[]>(POWERS.map((p) => [p, []]));
  const t = new DiplomacyTable({
    tableId: 'tbl_resolve_once',
    seed: 20261115,
    cls: 'core',
    episodeId: 'epi_01J9RES0LVE0NCE00000000001',
    secret: 'resolve-once',
    horizonYear: 1902,
    seats: Object.fromEntries(POWERS.map((p) => [p, { kind: 'agent', agentId: `agt_${p}` }])) as Record<Power, { kind: 'agent'; agentId: string }>,
    softMs: 60_000,
    hardMs: 60_000,
    policy: { allowSession: true },
    log: () => {},
    onEnd: () => {},
  });
  for (const p of POWERS) {
    const side: DipSeatSide = { send: (f) => inbox.get(p)!.push(f as Frame), close: () => {} };
    t.attach(p, side);
  }
  return { t, inbox };
}

/** A minimal valid answer (no press, no orders) echoing the seat's latest prompt. */
const answer = (inbox: Map<Power, Frame[]>, p: Power): Frame => {
  const o = inbox.get(p)!.filter((f) => f.t === 'diplomacy_observation').at(-1)!;
  return { t: 'diplomacy_action', protocol_version: '1.0', episode_id: o.episode_id, turn_id: o.turn_id, nonce: o.nonce, power: p };
};

for (const [label, dupes] of [
  ['a duplicate of the completing frame in the same I/O turn', 1],
  ['several re-sends by several seats in the same I/O turn', 5],
] as const) {
  test(`D-3 (fixed): ${label} resolves the step once; the next step stays open for its answers`, async () => {
    const { t, inbox } = table();
    t.start();
    assert.equal(t.episode.tick, 0);
    for (const p of POWERS) assert.deepEqual(t.submit(p, answer(inbox, p)), { ok: true });
    // Same I/O turn, after the set is complete: re-sends of accepted frames (latest replaces).
    for (let i = 0; i < dupes; i++) {
      const p = POWERS[(POWERS.length - 1 - i) % POWERS.length];
      assert.deepEqual(t.submit(p, answer(inbox, p)), { ok: true });
    }
    for (let i = 0; i < 4; i++) await turn();
    assert.equal(t.episode.tick, 1, 'exactly one step closed');
    assert.deepEqual(t.episode.misses, [], 'nobody missed step 1: it was never resolved without answers');
    for (const p of POWERS) {
      const obs = inbox.get(p)!.filter((f) => f.t === 'diplomacy_observation');
      assert.equal(obs.at(-1)!.turn_id, 1, `${p}: prompted for step 1`);
    }
    // Step 1 is still open: every seat's answer is accepted and it then closes normally.
    for (const p of POWERS) assert.deepEqual(t.submit(p, answer(inbox, p)), { ok: true });
    for (let i = 0; i < 4; i++) await turn();
    assert.equal(t.episode.tick, 2);
    assert.deepEqual(t.episode.misses, []);
    t.forceClose(1012);
  });
}
