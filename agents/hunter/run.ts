/**
 * Runnable hunter agent: bootstrap + play one Grid Tactics duel with the stronger
 * scripted heuristic. Same env contract as the reflex runner.
 *
 * Run:  npx tsx agents/hunter/run.ts
 */
import { connectAndPlay, type League } from '../lib/client.ts';
import { resolveCredentials, consoleLogger } from '../lib/env.ts';
import { createHunterPolicy } from './policy.ts';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:8080';
const league = (process.env.WOT_LEAGUE ?? 'core') as League;

try {
  const { clientId, clientSecret } = await resolveCredentials({ baseUrl, displayName: 'Hunter Prime', league });
  const result = await connectAndPlay({ baseUrl, clientId, clientSecret, league, policy: createHunterPolicy(), onEvent: consoleLogger('hunter'), validateOutgoing: true });
  process.stdout.write(`\nMatch over: ${result.result} by ${result.matchEnd.reason}. Replay ${result.matchEnd.replay_id} (hash ${result.matchEnd.replay_hash}).\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`\nHunter agent failed: ${(err as Error).message}\n`);
  process.exit(1);
}
