/**
 * G-12 remainder: the anonymous WSS dial-in (connect-storm caps keyed by
 * socket.remoteAddress) is served only under WOT_ENV=development|test and
 * refused otherwise, before any per-address state is created.
 * G-6: the arena's default log sink is redacted by key and value at depth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createStores } from 'wot-store';
import { generateClientSecret } from 'wot-auth';
import { anonymousDialInAllowed, attachArena } from '../src/index.ts';
import { defaultLogger } from '../src/log.ts';

test('anonymousDialInAllowed: only explicit development|test', () => {
  assert.equal(anonymousDialInAllowed({ WOT_ENV: 'development' }), true);
  assert.equal(anonymousDialInAllowed({ WOT_ENV: 'test' }), true);
  for (const v of [undefined, '', 'production', 'staging', 'dev', 'TEST', 'development ']) {
    assert.equal(anonymousDialInAllowed(v === undefined ? {} : { WOT_ENV: v }), false, String(v));
  }
});

async function tryUpgrade(env: NodeJS.ProcessEnv): Promise<{ status: number | 'open'; events: Array<Record<string, unknown>> }> {
  const events: Array<Record<string, unknown>> = [];
  const server = http.createServer();
  const arena = attachArena({ server, stores: createStores(), env, logger: (e) => events.push(e as never) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const status = await new Promise<number | 'open'>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/arena`);
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', (e) => (String(e).includes('Unexpected server response') ? undefined : reject(e)));
    });
    return { status, events };
  } finally {
    await arena.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('production (WOT_ENV unset): the dial-in upgrade is refused with 403 and logged', async () => {
  const { status, events } = await tryUpgrade({});
  assert.equal(status, 403);
  assert.ok(events.some((e) => e.event === 'dial_in_disabled'), 'startup warning');
  assert.ok(events.some((e) => e.event === 'connect_refused' && e.reason === 'dial_in_disabled'));
  assert.ok(!events.some((e) => (e.detail as { ip?: string } | undefined)?.ip), 'no per-address state or logging');
});

test('production (WOT_ENV=staging): refused too (fail closed)', async () => {
  assert.equal((await tryUpgrade({ WOT_ENV: 'staging' })).status, 403);
});

test('test env: the dial-in handshake is served', async () => {
  assert.equal((await tryUpgrade({ WOT_ENV: 'test' })).status, 'open');
});

test('arena defaultLogger: secrets nested in detail and in messages are redacted', () => {
  const sk = generateClientSecret();
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.c2lnbmF0dXJlc2lnbmF0dXJl'; // EXAMPLE: synthetic value for this test, not a credential
  const orig = console.error;
  const lines: string[] = [];
  console.error = (line: string) => lines.push(line);
  try {
    defaultLogger({
      event: 'handler_error',
      ts: 't',
      level: 'error',
      detail: { message: `hello rejected: ${jwt}`, inner: { deeper: { client_secret: sk, echo: `Bearer ${jwt}` } } },
    });
  } finally {
    console.error = orig;
  }
  const out = lines.join('\n');
  assert.ok(!out.includes(sk) && !out.includes(jwt), out);
  assert.match(out, /handler_error/);
});
