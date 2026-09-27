/**
 * Contracts 2.4.0 (B3a item 4) on the arena table session:
 *
 *  - `renounced.sig_mode` is the renounce message's OWN recorded mode, never the commitment's, also
 *    in observations after the renounce's movement window (a renounced commitment stays visible
 *    while any clause is escrowed);
 *  - `commitments`: every active commitment, plus each one that ENDED (its last clause settled) at
 *    the close of the previous step, in exactly one observation; a renounce ends nothing by itself,
 *    so a commitment renounced before the first adjudication stays visible (active) until its
 *    clauses settle, then appears once as ended;
 *  - `state`: ended = every clause has settled.
 *
 * Two agent seats (France, Germany), five house seats. France makes two offers in S1901M round 1:
 * #1 key-signed, spanning S1901M..F1901M; #2 session-signed, S1901M only. Germany accepts #1 with
 * its key and #2 in session mode, so cmt#1 is `key` and cmt#2 is `session`. In round 3 France
 * renounces cmt#1 in SESSION mode and cmt#2 with its KEY: each renounce carries its own mode.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPressMove } from 'wot-auth';
import { POWERS, type Power } from 'wot-engine';
import type { DipSeatSpec } from '../src/diplomacy/table.ts';
import { commitmentVisible } from '../src/diplomacy/wire.ts';
import { dipHello, dipPassport, DipWireAgent, setupDip } from './diplomacy-helpers.ts';

type Frame = Record<string, unknown>;
type Cmt = { cmt_id: string; state: string; sig_mode: string; renounced?: Frame; clauses: Frame[] };
const seatsWith = (agents: Partial<Record<Power, string>>): Record<Power, DipSeatSpec> =>
  Object.fromEntries(POWERS.map((p) => [p, agents[p] ? { kind: 'agent', agentId: agents[p]! } : { kind: 'house' }])) as Record<Power, DipSeatSpec>;
const echo = (o: Frame, power: Power, extra: Frame = {}): Frame => ({ t: 'diplomacy_action', protocol_version: '1.0', episode_id: o.episode_id, turn_id: o.turn_id, nonce: o.nonce, power, ...extra });
const dmz = (prov: string, to: string) => ({
  give: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: to, provinces: [prov] }],
  want: [{ kind: 'no_enter', from_phase: 'S1901M', to_phase: to, provinces: [prov] }],
});
const T1 = dmz('bur', 'F1901M');
const T2 = dmz('tyr', 'S1901M');
const toG = { kind: 'private', power: 'germany' };
const toF = { kind: 'private', power: 'france' };
const OFFER1 = 'prs:S1901M:r1:france:1';
const OFFER2 = 'prs:S1901M:r1:france:2';
const CMT1 = `cmt:${OFFER1}`;
const CMT2 = `cmt:${OFFER2}`;

test('renounce sig_mode is its own recorded mode (in and after its window); ended commitments appear in exactly one observation', { timeout: 120_000 }, async () => {
  const h = await setupDip();
  try {
    const fr = await dipPassport(h);
    const ge = await dipPassport(h);
    const table = h.arena.diplomacy.createTable({ seed: 5, cls: 'core', horizonYear: 1902, seats: seatsWith({ france: fr.agentId, germany: ge.agentId }) });
    const ep = table.episodeId;
    const A = new DipWireAgent(h.url, 'france', null);
    const B = new DipWireAgent(h.url, 'germany', null);
    await Promise.all([A.open(), B.open()]);
    A.send(dipHello(fr.token, table.tableId));
    B.send(dipHello(ge.token, table.tableId));
    const obs = (a: DipWireAgent, turn: number) => a.waitFor((f) => f.t === 'diplomacy_observation' && f.turn_id === turn, 15_000);
    const sign = (key: typeof fr.signing, msgIdExpected: string, from: Power, to: unknown, move: string, respondTo: string | null, terms: unknown) =>
      signPressMove(key!, { episodeId: ep, msgIdExpected, from, to, move, respondTo, terms });

    const seenA: Frame[] = [];
    const seenB: Frame[] = [];
    let cmt1EndedAt: number | null = null;
    for (let t = 0; t < 40; t++) {
      const [a, b] = await Promise.all([obs(A, t), obs(B, t)]);
      seenA.push(a);
      seenB.push(b);
      const step = a.step as { kind: string; round?: number };
      const pressAt = (r: number) => a.phase === 'S1901M' && step.kind === 'press' && step.round === r;
      let fa: Frame = {};
      let fb: Frame = {};
      if (pressAt(1)) {
        fa = { press: [
          { move: 'offer', to: toG, terms: T1, signature: sign(fr.signing, 'prs:S1901M:r1:france:1', 'france', toG, 'offer', null, T1) },
          { move: 'offer', to: toG, terms: T2, signature: 'session' },
        ] };
      } else if (pressAt(2)) {
        fb = { press: [
          { move: 'accept', to: toF, respond_to: OFFER1, signature: sign(ge.signing, 'prs:S1901M:r2:germany:1', 'germany', toF, 'accept', OFFER1, null) },
          { move: 'accept', to: toF, respond_to: OFFER2, signature: 'session' },
        ] };
      } else if (pressAt(3)) {
        fa = { press: [
          { move: 'renounce', to: toG, respond_to: CMT1, signature: 'session' },
          { move: 'renounce', to: toG, respond_to: CMT2, signature: sign(fr.signing, 'prs:S1901M:r3:france:2', 'france', toG, 'renounce', CMT2, null) },
        ] };
      }
      const c1 = (a.commitments as Cmt[]).find((c) => c.cmt_id === CMT1);
      if (c1?.state === 'ended') cmt1EndedAt = t;
      if (cmt1EndedAt !== null && t >= cmt1EndedAt + 2) break;
      A.send(echo(a, 'france', fa));
      B.send(echo(b, 'germany', fb));
    }
    assert.ok(cmt1EndedAt !== null, 'cmt#1 ended (its F1901M clauses settled at the F1901M adjudication)');
    for (const f of [...seenA, ...seenB]) assert.deepEqual(f.press_rejects, [], `t${String(f.turn_id)}: nothing refused`);
    assert.deepEqual([...A.schemaErrors, ...B.schemaErrors], []);

    const at = (seen: Frame[], id: string) => seen.map((f) => ({ t: f.turn_id as number, phase: f.phase as string, c: (f.commitments as Cmt[]).find((c) => c.cmt_id === id) }));
    for (const seen of [seenA, seenB]) {
      const who = seen === seenA ? 'france' : 'germany';
      const c1 = at(seen, CMT1);
      const c2 = at(seen, CMT2);
      // Bound at the close of r2 (tick 2): both parties see both from tick 3, with the commitment's mode.
      assert.equal(c1[2].c, undefined);
      assert.deepEqual([c1[3].c?.sig_mode, c2[3].c?.sig_mode], ['key', 'session'], `${who}: commitment modes`);
      // Renounced at the close of r3 (tick 3). Tick 4 (S1901M orders): active, renounce in its window.
      for (const [row, own, cm] of [[c1[4], 'session', 'key'], [c2[4], 'key', 'session']] as const) {
        assert.ok(row.c, `${who}: renounced commitment still visible before the first adjudication`);
        assert.equal(row.c.state, 'active', `${who}: a renounce alone does not end a commitment`);
        assert.equal(row.c.sig_mode, cm);
        assert.equal(row.c.renounced?.sig_mode, own, `${who}: renounce carries its OWN mode, not the commitment's`);
        assert.equal(row.c.renounced?.delivered_tick, 3);
      }
      assert.equal(c1[4].c!.renounced!.releases_from_phase, 'F1901M', 'round-R renounce releases from the next phase');
      // cmt#2 (S1901M only) ends at the S1901M adjudication (tick 4): visible as ended at tick 5 ONLY.
      const ended2 = c2.filter((r) => r.c?.state === 'ended').map((r) => r.t);
      assert.deepEqual(ended2, [5], `${who}: cmt#2 ended appears in exactly one observation`);
      assert.ok(c2.slice(6).every((r) => r.c === undefined), `${who}: and never again`);
      assert.equal(c2[5].c!.renounced!.sig_mode, 'key');
      // cmt#1 stays active into F1901M, past the renounce's window: still its own (session) mode.
      const outOfWindow = c1.filter((r) => r.c?.state === 'active' && r.phase !== 'S1901M');
      assert.ok(outOfWindow.length > 0, `${who}: cmt#1 visible after the S1901M window`);
      for (const r of outOfWindow) assert.equal(r.c!.renounced!.sig_mode, 'session', `${who} t${r.t}: out-of-window renounce mode is recorded, not inherited`);
      // Ended exactly once (at its last settlement, the F1901M adjudication), then gone.
      const ended1 = c1.filter((r) => r.c?.state === 'ended');
      assert.deepEqual(ended1.map((r) => r.t), [cmt1EndedAt], `${who}: cmt#1 ended appears in exactly one observation`);
      assert.ok(c1.filter((r) => r.t > cmt1EndedAt!).every((r) => r.c === undefined));
      // (A multi-phase clause aggregates to `kept` once any phase was kept: engine clauseStatus.)
      assert.deepEqual((ended1[0].c!.clauses as { status: string }[]).map((x) => x.status), ['kept', 'kept']);
      assert.ok((ended1[0].c!.clauses as { status: string; settled_tick?: number }[]).every((x) => x.status !== 'escrowed' && typeof x.settled_tick === 'number'));
    }
    A.close();
    B.close();
  } finally {
    await h.close();
  }
});

test('commitmentVisible: active always; ended only in the observation right after its last settlement', () => {
  const settled = (tick: number) => ({ phase: 'S1901M', status: 'kept' as const, tick });
  const cl = (settlements: ReturnType<typeof settled>[], status: 'escrowed' | 'kept') => ({ index: 0, obligor: 'france' as const, clause: {} as never, status, settlements });
  const base = { cmt_id: 'c', parties: ['france', 'germany'] as const, offer_msg_id: 'o', accept_msg_id: 'a', terms_hash: 'h', bound_tick: 2, sig_mode: 'key' as const };
  const active = { ...base, renounced: { by: 'france' as const, msg_id: 'r', tick: 3 }, clauses: [cl([], 'escrowed')] };
  for (const t of [3, 4, 50]) assert.equal(commitmentVisible(active, t), true, 'renounced but escrowed = active = visible');
  const ended = { ...base, renounced: null, clauses: [cl([settled(4)], 'kept'), cl([settled(2), settled(9)], 'kept')] };
  assert.deepEqual([8, 9, 10, 11].map((t) => commitmentVisible(ended, t)), [false, false, true, false]);
  // A renounce delivered after the end does not show it again (a renounce settles nothing).
  const renouncedAfterEnd = { ...ended, renounced: { by: 'germany' as const, msg_id: 'r2', tick: 12 } };
  assert.deepEqual([10, 13].map((t) => commitmentVisible(renouncedAfterEnd, t)), [true, false]);
});
