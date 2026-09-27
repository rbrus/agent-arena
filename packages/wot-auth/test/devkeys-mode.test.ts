/**
 * G-9: the dev signing key store is owner-only: directory 0700, key files 0600,
 * including when the directory already existed with a lax mode, and end to end
 * through getKeyMaterial() in a fresh process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEV_KEY_FILE_MODE, DEV_KEYS_DIR_MODE, persistDevKeyFiles } from '../src/keys.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== 'win32';
const mode = (p: string): number => statSync(p).mode & 0o777;

test('persistDevKeyFiles: new dir 0700, files 0600', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wot-g9-'));
  try {
    const dir = join(root, 'nested', '.dev-keys');
    persistDevKeyFiles(dir, { kty: 'OKP', d: 'x' }, { kty: 'OKP' });
    assert.equal(mode(dir), DEV_KEYS_DIR_MODE);
    assert.equal(mode(join(dir, 'private.jwk.json')), DEV_KEY_FILE_MODE);
    assert.equal(mode(join(dir, 'public.jwk.json')), DEV_KEY_FILE_MODE);
    assert.equal(DEV_KEYS_DIR_MODE, 0o700);
    assert.equal(DEV_KEY_FILE_MODE, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistDevKeyFiles: a pre-existing world-readable dir is tightened to 0700', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wot-g9-'));
  try {
    const dir = join(root, '.dev-keys');
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    persistDevKeyFiles(dir, { kty: 'OKP', d: 'x' }, { kty: 'OKP' });
    assert.equal(mode(dir), 0o700);
    assert.throws(() => persistDevKeyFiles(dir, { kty: 'OKP' }, { kty: 'OKP' }), /EEXIST/, 'exclusive create');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function loadKeysInFreshProcess(dir: string): void {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', `import('${join(HERE, '..', 'src', 'keys.ts')}').then((m) => m.getKeyMaterial()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`],
    { env: { ...process.env, WOT_ENV: 'test', WOT_DEV_KEYS_DIR: dir, WOT_JWT_PRIVATE_JWK: '' }, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
}

test('getKeyMaterial (dev): generated key store is owner-only end to end', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wot-g9-'));
  try {
    const dir = join(root, '.dev-keys');
    loadKeysInFreshProcess(dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'private.jwk.json')), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getKeyMaterial (dev): a key store left lax by an older build is tightened on reload', { skip: !posix }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wot-g9-'));
  try {
    const dir = join(root, '.dev-keys');
    loadKeysInFreshProcess(dir);
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'private.jwk.json'), 0o644);
    loadKeysInFreshProcess(dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, 'private.jwk.json')), 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
