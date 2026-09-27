/**
 * Gate criteria 1-2 on loopback: the included coordinated reference squad,
 * served by `serve-reference`, driven by `run` over REST, WS, MCP and A2A in
 * byzantine squad seating. Every episode must reproduce its frozen golden
 * anchor, the four transports must produce identical hashes, and every report
 * must re-verify.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { GATE_SEEDS_BYZANTINE, SELF_TESTS } from 'arena-scenarios';
import { runCommand } from '../src/commands/run.ts';
import { verifyCommand } from '../src/commands/verify.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { scratch } from './helpers.ts';

let srv: ReferenceServer;

before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'coordinated', scenario: 'byzantine' });
});
after(async () => {
  await srv.close();
});

const anchor = (tier: string, seed: number) =>
  SELF_TESTS.find((c) => c.scenario === 'byzantine' && c.tier === tier && c.seed === seed && c.opts.mode === 'squad' && c.opts.targetDriver === 'ref:coordinated')!.expect;

function targetFor(t: 'rest' | 'ws' | 'mcp' | 'a2a', host: 'localhost' | '127.0.0.1'): string {
  const u = new URL(srv.urls[t]);
  u.hostname = host;
  return u.toString();
}

const hashesBy: Record<string, string[]> = {};

for (const transport of ['rest', 'ws', 'mcp', 'a2a'] as const) {
  test(`${transport}: byzantine squad, five gate seeds, core: every episode reproduces its frozen anchor and re-verifies`, async () => {
    const out = scratch();
    const r = await runCommand(
      { scenario: 'byzantine', seat: 'squad', tier: 'core', target: targetFor(transport, transport === 'a2a' || transport === 'rest' ? 'localhost' : '127.0.0.1'), transport, out },
      [],
    );
    assert.equal(r.exitCode, 0, 'coordinated reference: no findings');
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.episodes.length, GATE_SEEDS_BYZANTINE.length);
    const hashes: string[] = [];
    for (const [i, ep] of report.episodes.entries()) {
      const a = anchor('core', GATE_SEEDS_BYZANTINE[i]);
      assert.equal(ep.seed, GATE_SEEDS_BYZANTINE[i]);
      assert.equal(ep.outcome, a.outcome);
      assert.equal(ep.terminal_tick, a.ticks);
      assert.equal(ep.replay_hash, a.replayHash, `${transport} episode ${i}`);
      hashes.push(ep.replay_hash);
    }
    assert.equal(report.run.spec.target.transport, transport);
    assert.deepEqual(report.run.target_ownership, { loopback: true, attested: false });
    assert.equal(report.run.spec.target.ownership_attested, undefined);
    assert.equal(report.run.spec.labels['arena.network_policy'], 'loopback-literal');
    hashesBy[transport] = hashes;
    assert.equal(verifyCommand(join(out, 'report.json')), 0, `${transport}: verify`);
  });
}

test('transport does not affect outcome: identical replay hashes over rest, ws, mcp and a2a (gate criterion 2)', () => {
  const [first, ...rest] = Object.values(hashesBy);
  assert.equal(Object.keys(hashesBy).length, 4, 'all four transports ran');
  for (const h of rest) assert.deepEqual(h, first);
});

test('rest: seed 20260720 reproduces the byzantine coordinated anchor at edge and frontier too', async () => {
  for (const tier of ['edge', 'frontier'] as const) {
    const out = scratch();
    const r = await runCommand({ scenario: 'byzantine', seat: 'squad', tier, seeds: '20260720', target: targetFor('rest', '127.0.0.1'), out }, []);
    assert.equal(r.exitCode, 0);
    const ep = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).episodes[0];
    assert.equal(ep.replay_hash, anchor(tier, 20260720).replayHash, tier);
  }
});

test('serve-reference answers /healthz through the guarded client', async () => {
  // Through the CLI's own guarded client: a health probe is just another loopback request.
  const { NetContext, httpRequest, policyFor } = await import('../src/net/index.ts');
  const u = new URL(srv.urls.healthz);
  const ctx = new NetContext({ policy: policyFor(u, {}), target: u, userAgent: 'test', runId: 'run_TEST', rps: 0 });
  const res = await httpRequest(ctx, { method: 'GET', url: u, deadline: performance.now() + 2000 });
  ctx.close();
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body.toString()).ok, true);
});
