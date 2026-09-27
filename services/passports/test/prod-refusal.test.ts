/**
 * G-1: the passports and gateway services refuse to START with the dev-auth
 * bypass when the deployment is production (anything but WOT_ENV=development|test).
 * Each case runs in a child process so the env is controlled at module load.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

function start(env: Record<string, string>): { code: number | null; err: string } {
  const body = `
    const { createStores } = await import('wot-store');
    const { createPassportsApp } = await import(${JSON.stringify(join(ROOT, 'services/passports/src/index.ts'))});
    const { createGatewayApp } = await import(${JSON.stringify(join(ROOT, 'services/gateway/src/index.ts'))});
    const which = process.env.WHICH;
    const stores = createStores();
    if (which === 'passports') createPassportsApp({ stores });
    else createGatewayApp({ stores, arenaBaseUrl: 'ws://127.0.0.1:1' });
    console.log('started');
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      WOT_DEV_KEYS_DIR: mkdtempSync(join(tmpdir(), 'wot-prod-refusal-')),
      ...env,
    },
    encoding: 'utf8',
    cwd: ROOT,
  });
  return { code: r.status, err: r.stderr };
}

const PROD_SECRETS = { WOT_SECRET_PEPPER: 'p'.repeat(40) };

for (const which of ['passports', 'gateway']) {
  test(`${which}: WOT_DEV_AUTH=1 with WOT_ENV unset refuses to start`, () => {
    const r = start({ ...PROD_SECRETS, WOT_DEV_AUTH: '1', WHICH: which });
    assert.notEqual(r.code, 0, `${which} started with dev-auth in production`);
    assert.match(r.err, /Refusing to start with the human-auth bypass on/);
  });

  test(`${which}: WOT_DEV_AUTH=1 with WOT_ENV=production refuses to start`, () => {
    const r = start({ ...PROD_SECRETS, WOT_ENV: 'production', WOT_DEV_AUTH: '1', WHICH: which });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /Refusing to start/);
  });

  test(`${which}: production without dev-auth starts (fail-closed auth)`, () => {
    const r = start({ ...PROD_SECRETS, WOT_ENV: 'production', WHICH: which });
    assert.equal(r.code, 0, r.err);
  });

  test(`${which}: WOT_ENV=development with WOT_DEV_AUTH=1 starts`, () => {
    const r = start({ WOT_ENV: 'development', WOT_DEV_AUTH: '1', WHICH: which });
    assert.equal(r.code, 0, r.err);
  });
}
