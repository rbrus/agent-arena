/**
 * Phase-1 gate demo: from a clean clone, two agents authenticate with Agent
 * Passports, queue, fight a full Grid Tactics duel, and each retrieves the
 * hash-committed replay — the whole thing end-to-end against the real services.
 *
 * Run:  WOT_ENV=development WOT_DEV_AUTH=1 npx tsx sandbox/demo-match.ts   (or `npm run demo:match`)
 */
import { startDevServer } from './index.ts';
import { registerAgent, connectAndPlay } from '../agents/lib/client.ts';
import { reflexPolicy } from '../agents/reflex/policy.ts';
import { createHunterPolicy } from '../agents/hunter/policy.ts';

async function main(): Promise<void> {
  const server = await startDevServer({});
  const baseUrl = server.url;
  console.log(`[demo] combined dev server (passports + gateway + arena) at ${baseUrl}`);
  try {
    const a = await registerAgent({ baseUrl, displayName: 'Reflex Prime' });
    const b = await registerAgent({ baseUrl, displayName: 'Hunter Prime' });
    console.log(`[demo] registered A=${a.agentId} (reflex)  B=${b.agentId} (hunter)`);

    const hunter = createHunterPolicy();
    const t0 = performance.now();
    const [ra, rb] = await Promise.all([
      connectAndPlay({ baseUrl, clientId: a.clientId, clientSecret: a.clientSecret, policy: reflexPolicy, league: 'core' }),
      connectAndPlay({ baseUrl, clientId: b.clientId, clientSecret: b.clientSecret, policy: hunter, league: 'core' }),
    ]);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    console.log(`[demo] match ${ra.matchEnd.match_id} finished in ${secs}s, ${ra.matchEnd.ticks_played} ticks, reason=${ra.matchEnd.reason}`);
    console.log(`[demo]   A (reflex): ${ra.result}  scores=${JSON.stringify(ra.matchEnd.final_scores)}`);
    console.log(`[demo]   B (hunter): ${rb.result}  scores=${JSON.stringify(rb.matchEnd.final_scores)}`);
    console.log(`[demo]   replay_id=${ra.matchEnd.replay_id}  hash=${ra.matchEnd.replay_hash}`);
    console.log(`[demo]   seed=${ra.matchEnd.seed}  replay fetched=${ra.replay ? 'yes' : 'no'}`);

    const sameMatch = ra.matchEnd.match_id === rb.matchEnd.match_id && ra.matchEnd.replay_id === rb.matchEnd.replay_id;
    const decisive = ['win', 'loss', 'draw'].includes(ra.result) && ['win', 'loss', 'draw'].includes(rb.result);
    const consistent = ra.matchEnd.winner === rb.matchEnd.winner;
    const gotReplay = !!ra.replay && !!rb.replay;
    const hashShape = /^sha256:[0-9a-f]{64}$/.test(ra.matchEnd.replay_hash);
    const ok = sameMatch && decisive && consistent && gotReplay && hashShape;

    console.log(ok
      ? '[demo] GATE OK — two passported agents authenticated, queued, fought a full duel, and retrieved the committed replay.'
      : `[demo] GATE FAIL — sameMatch=${sameMatch} decisive=${decisive} consistent=${consistent} gotReplay=${gotReplay} hashShape=${hashShape}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await server.close();
  }
}

main().catch((e) => {
  console.error('[demo] ERROR', e);
  process.exitCode = 1;
});
