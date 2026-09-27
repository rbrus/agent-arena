/**
 * Observation leakage through the harness: each peer receives only its own power's frame (a
 * private copy), never another power's codeword, never the seed; a peer that scribbles over its
 * frame cannot reach another seat or the table state.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dipCodewordFor, type Power } from 'wot-engine';
import { definePeer, fakePeer, runTable, type DiplomacyObservationFrame, type Peer, type PeerContext } from '../src/index.ts';
import { detOpts, table } from './helpers.ts';

test('each peer sees only its own frame; the context carries no seed; mutation stays private', async () => {
  const seed = 424242;
  const seen = new Map<Power, { frames: DiplomacyObservationFrame[]; ctx: PeerContext[] }>();
  const spy = (p: Power, scribble: boolean): Peer => {
    const inner = fakePeer('robust', { provider_id: `spy-${p}`, model_id: 'm' });
    seen.set(p, { frames: [], ctx: [] });
    return definePeer(inner.meta, async (o, c) => {
      seen.get(p)!.frames.push(JSON.parse(JSON.stringify(o)) as DiplomacyObservationFrame);
      seen.get(p)!.ctx.push(c);
      const r = await inner(o, c);
      if (scribble) {
        const w = o as Record<string, unknown>;
        for (const k of Object.keys(w)) w[k] = null;
      }
      return r;
    });
  };
  const t = table('t-leak', seed, [
    { power: 'germany', peer: spy('germany', true) },
    { power: 'france', peer: spy('france', false) },
    { power: 'turkey', peer: spy('turkey', false) },
  ], { horizon_year: 1901 });
  const clean = table('t-leak', seed, [
    { power: 'germany', peer: fakePeer('robust', { provider_id: 'spy-germany', model_id: 'm' }) },
    { power: 'france', peer: fakePeer('robust', { provider_id: 'spy-france', model_id: 'm' }) },
    { power: 'turkey', peer: fakePeer('robust', { provider_id: 'spy-turkey', model_id: 'm' }) },
  ], { horizon_year: 1901 });
  const run = await runTable(t.spec, t.peers, detOpts());
  const ref = await runTable(clean.spec, clean.peers, detOpts());
  assert.deepEqual(run.record.actions, ref.record.actions, 'a peer mutating its frame changes nothing for anyone');
  const codeword = (p: Power): string => dipCodewordFor(seed, p, '');
  for (const [p, s] of seen) {
    assert.ok(s.frames.length > 0);
    for (const f of s.frames) {
      assert.equal(f.power, p);
      const text = JSON.stringify(f);
      for (const other of ['germany', 'france', 'turkey', 'austria', 'england', 'italy', 'russia'] as Power[]) {
        if (other !== p) assert.ok(!text.includes(codeword(other)), `${p} saw ${other}'s codeword`);
      }
      assert.ok(text.includes(codeword(p)), `${p} sees its own codeword`);
      assert.ok(!text.includes(String(seed)), 'the seed never reaches a peer');
    }
    for (const c of s.ctx) {
      assert.deepEqual(Object.keys(c).sort(), ['deadline_ms', 'hard_deadline_ms', 'power', 'signal', 'table_id', 'turn_id']);
      assert.equal(c.power, p);
    }
  }
});
