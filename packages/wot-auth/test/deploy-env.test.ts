/**
 * Deployment-environment detection fails CLOSED (threat-model-arena G-4) and
 * the dev-auth bypass refuses to start in production (G-1).
 *
 * `IS_PRODUCTION` and the pepper are resolved at module load, so each case
 * runs in a fresh child process with a controlled environment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'src', 'config.ts');
const SECRETS = join(HERE, '..', 'src', 'secrets.ts');

function run(env: Record<string, string>, body: string): { code: number | null; out: string; err: string } {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `const c = await import(${JSON.stringify(CONFIG)});\n${body}`],
    { env: { ...clean, ...env }, encoding: 'utf8', cwd: join(HERE, '..') },
  );
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('resolveDeployEnv: only development|test are non-production', async () => {
  const { resolveDeployEnv } = await import('../src/config.ts');
  assert.equal(resolveDeployEnv('development'), 'development');
  assert.equal(resolveDeployEnv('test'), 'test');
  for (const v of [undefined, '', 'production', 'prod', 'staging', 'Development', 'dev']) {
    assert.equal(resolveDeployEnv(v), 'production', `WOT_ENV=${String(v)} must fail closed`);
  }
});

test('WOT_ENV unset (NODE_ENV=development ignored): production, the pepper is required', () => {
  const r = run({ NODE_ENV: 'development' }, 'console.log(c.IS_PRODUCTION);');
  assert.notEqual(r.code, 0, 'must refuse to load without WOT_SECRET_PEPPER');
  assert.match(r.err, /WOT_SECRET_PEPPER is required in production/);
});

test('WOT_ENV unset with secrets provided: IS_PRODUCTION is true', () => {
  const r = run({ WOT_SECRET_PEPPER: 'x'.repeat(32) }, 'console.log(JSON.stringify([c.IS_PRODUCTION, c.DEPLOY_ENV]));');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out.trim()), [true, 'production']);
});

test('WOT_ENV=development: dev defaults apply, and the dev pepper is random per process', () => {
  const body = `const s = await import(${JSON.stringify(SECRETS)}); console.log(JSON.stringify([c.IS_PRODUCTION, s.hashSecret('same')]));`;
  const a = run({ WOT_ENV: 'development' }, body);
  const b = run({ WOT_ENV: 'development' }, body);
  assert.equal(a.code, 0, a.err);
  const [prodA, hashA] = JSON.parse(a.out.trim());
  const [, hashB] = JSON.parse(b.out.trim());
  assert.equal(prodA, false);
  assert.notEqual(hashA, hashB, 'no fixed, source-visible dev pepper');
});

test('assertDevAuthAllowed: WOT_DEV_AUTH=1 refuses in production, allowed in development', async () => {
  const { assertDevAuthAllowed, devAuthEnabled } = await import('../src/config.ts');
  assert.throws(() => assertDevAuthAllowed({ WOT_DEV_AUTH: '1' }), /Refusing to start/);
  assert.throws(() => assertDevAuthAllowed({ WOT_DEV_AUTH: '1', WOT_ENV: 'production' }), /Refusing to start/);
  assert.throws(() => assertDevAuthAllowed({ WOT_DEV_AUTH: '1', WOT_ENV: 'staging' }), /Refusing to start/);
  assert.doesNotThrow(() => assertDevAuthAllowed({ WOT_DEV_AUTH: '1', WOT_ENV: 'development' }));
  assert.doesNotThrow(() => assertDevAuthAllowed({ WOT_ENV: 'production' }));
  assert.equal(devAuthEnabled({ WOT_DEV_AUTH: '1', WOT_ENV: 'production' }), false);
  assert.equal(devAuthEnabled({ WOT_DEV_AUTH: '1' }), false);
  assert.equal(devAuthEnabled({ WOT_DEV_AUTH: '1', WOT_ENV: 'test' }), true);
});
