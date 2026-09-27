/**
 * Env-driven bootstrap shared by the runnable agents.
 *
 * Uses WOT_CLIENT_ID / WOT_CLIENT_SECRET when present; otherwise self-registers
 * against a dev-auth sandbox (WOT_DEV_AUTH=1 on the server side). Kept out of the
 * SDK core (client.ts) so the client stays framework- and environment-agnostic.
 */
import { registerAgent, type League } from './client.ts';

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export async function resolveCredentials(opts: { baseUrl: string; displayName: string; league?: League }): Promise<Credentials> {
  const clientId = process.env.WOT_CLIENT_ID;
  const clientSecret = process.env.WOT_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const reg = await registerAgent({ baseUrl: opts.baseUrl, displayName: opts.displayName, league: opts.league });
  return { clientId: reg.clientId, clientSecret: reg.clientSecret };
}

/** A concise console logger you can pass as `onEvent`. Writes to stderr. */
export function consoleLogger(tag: string): (e: import('./client.ts').ClientEvent) => void {
  return (e) => {
    const parts: string[] = [`[${tag}]`, e.type];
    for (const [k, v] of Object.entries(e)) {
      if (k === 'type') continue;
      parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    }
    process.stderr.write(parts.join(' ') + '\n');
  };
}
