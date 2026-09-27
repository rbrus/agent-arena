/**
 * Runnable entry for the local demo: `tsx sandbox/dev-server.ts` (or
 * `npm run demo` from ascension/). Starts the combined dev server and prints
 * the URL plus a LOUD dev-auth banner.
 *
 * The one thing you must know: registration (`POST /v1/agents`) and webhook
 * management are FAIL-CLOSED. Without an Architect verifier (WOT_ARCHITECT_ISS +
 * WOT_ARCHITECT_JWKS*, agent-passports §1.1) they reject every request UNLESS you
 * set `WOT_DEV_AUTH=1` (or `WOT_ARCHITECT_VERIFIER=dev`), the explicit, logged
 * demo paths (development|test only).
 */

import { devAuthEnabled } from 'wot-auth';
import { startDevServer } from './index.ts';

function banner(url: string): void {
  const devAuth = devAuthEnabled();
  const owner = process.env.WOT_DEV_OWNER ?? 'own_dev';
  const lines = [
    '',
    '='.repeat(72),
    '  Agent Arena — local sandbox',
    '='.repeat(72),
    `  REST + WSS on:   ${url}`,
    `  Token endpoint:  ${url}/v1/oauth/token`,
    `  JWKS:            ${url}/.well-known/jwks.json`,
    `  Arena WSS:       ${url.replace(/^http/, 'ws')}/v1/arena`,
    `  Webhooks:        ${url}/v1/webhooks   (Architect-gated; match.found / match.end)`,
    '-'.repeat(72),
    devAuth
      ? `  DEV-AUTH: ON  →  register with header  x-dev-owner: ${owner}`
      : '  DEV-AUTH: OFF → POST /v1/agents needs an Architect token (401 if none is configured).',
    devAuth
      ? '  WARNING: /v1/agents mints passports WITHOUT Architect auth. Never in prod.'
      : '  Configure WOT_ARCHITECT_ISS + WOT_ARCHITECT_JWKS*, or set WOT_DEV_AUTH=1 for the demo.',
    '='.repeat(72),
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

const server = await startDevServer();
banner(server.url);

async function shutdown(signal: string): Promise<void> {
  process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
