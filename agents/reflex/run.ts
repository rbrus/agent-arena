/**
 * Runnable reflex agent: bootstrap + play one Grid Tactics duel.
 *
 *   BASE_URL             management-plane URL   (default http://localhost:8080)
 *   WOT_CLIENT_ID/SECRET passport credentials   (else self-registers, dev-auth)
 *   WOT_LEAGUE           edge|core|frontier      (default core)
 *
 * Run:  npx tsx agents/reflex/run.ts
 */
import { connectAndPlay, type League } from '../lib/client.ts';
import { resolveCredentials, consoleLogger } from '../lib/env.ts';
import { reflexPolicy } from './policy.ts';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:8080';
const league = (process.env.WOT_LEAGUE ?? 'core') as League;

try {
  const { clientId, clientSecret } = await resolveCredentials({ baseUrl, displayName: 'Reflex Prime', league });
  const result = await connectAndPlay({ baseUrl, clientId, clientSecret, league, policy: reflexPolicy, onEvent: consoleLogger('reflex'), validateOutgoing: true });
  process.stdout.write(`\nMatch over: ${result.result} by ${result.matchEnd.reason}. Replay ${result.matchEnd.replay_id} (hash ${result.matchEnd.replay_hash}).\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`\nReflex agent failed: ${(err as Error).message}\n`);
  process.exit(1);
}
