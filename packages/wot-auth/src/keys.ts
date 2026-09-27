/**
 * Signing-key management.
 *
 * - Prod: load the private JWK from `WOT_JWT_PRIVATE_JWK` (agent-passports.md §2.4;
 *   real deployments source this from Secret Manager).
 * - Dev: generate an Ed25519 keypair once, persist both JWKs to a gitignored
 *   `.dev-keys/` dir, and reload it on the next run — so tokens minted by one
 *   locally-started service verify in another with zero setup.
 *
 * EdDSA (Ed25519) via `jose` (ADR-000 Identity; agent-passports.md §2.4).
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  type CryptoKey,
} from 'jose';
import { DEV_KEYS_DIR, PRIVATE_JWK_ENV, IS_PRODUCTION } from './config.ts';
import { registerLogSecret } from './redact.ts';

export interface KeyMaterial {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
  /** Public JWK, ready for /.well-known/jwks.json (kid, use, alg included). */
  publicJwk: JWK;
}

const PRIVATE_FILE = 'private.jwk.json';
const PUBLIC_FILE = 'public.jwk.json';

function makeKid(): string {
  const d = new Date();
  const ymd =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}`;
  return `key_${ymd}_${randomBytes(3).toString('hex')}`;
}

function publicFromPrivateJwk(priv: JWK, kid: string): JWK {
  // Ed25519 (OKP): the public JWK is the private one minus the `d` scalar.
  return {
    kty: 'OKP',
    crv: 'Ed25519',
    x: priv.x,
    kid,
    use: 'sig',
    alg: 'EdDSA',
  };
}

async function fromPrivateJwk(priv: JWK): Promise<KeyMaterial> {
  registerLogSecret(priv.d); // G-6: the private scalar never reaches a log line
  const kid = priv.kid ?? makeKid();
  const publicJwk = publicFromPrivateJwk(priv, kid);
  const privateKey = (await importJWK({ ...priv, kid }, 'EdDSA')) as CryptoKey;
  const publicKey = (await importJWK(publicJwk, 'EdDSA')) as CryptoKey;
  return { privateKey, publicKey, kid, publicJwk };
}

/** Best-effort: tighten a key store written by an older build with default modes (G-9). */
function tightenDevKeyStore(dir: string): void {
  if (process.platform === 'win32') return;
  for (const [path, mode] of [
    [dir, 0o700],
    [join(dir, PRIVATE_FILE), 0o600],
    [join(dir, PUBLIC_FILE), 0o600],
  ] as const) {
    try {
      chmodSync(path, mode);
    } catch {
      /* missing or not ours: the read below decides */
    }
  }
}

function tryReadDevKeys(): { priv: JWK; pub: JWK } | null {
  tightenDevKeyStore(DEV_KEYS_DIR);
  try {
    const priv = JSON.parse(readFileSync(join(DEV_KEYS_DIR, PRIVATE_FILE), 'utf8')) as JWK;
    const pub = JSON.parse(readFileSync(join(DEV_KEYS_DIR, PUBLIC_FILE), 'utf8')) as JWK;
    return { priv, pub };
  } catch {
    return null;
  }
}

/** Owner-only modes for the dev key store (threat-model-arena G-9). */
export const DEV_KEYS_DIR_MODE = 0o700;
export const DEV_KEY_FILE_MODE = 0o600;

/**
 * Write the dev keypair into `dir` with owner-only permissions (G-9): the
 * directory is created (or tightened, if it already existed) to 0700 and each
 * key file is created exclusively (`wx`) with 0600. The explicit chmod covers a
 * pre-existing directory, whose mode `mkdir` would otherwise leave alone.
 * Throws if either file already exists (the caller reloads the winner's pair).
 */
export function persistDevKeyFiles(dir: string, privateJwk: JWK, publicJwk: JWK): void {
  mkdirSync(dir, { recursive: true, mode: DEV_KEYS_DIR_MODE });
  if (process.platform !== 'win32') chmodSync(dir, DEV_KEYS_DIR_MODE);
  const write = (name: string, jwk: JWK): void => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(jwk, null, 2), { flag: 'wx', mode: DEV_KEY_FILE_MODE });
    if (process.platform !== 'win32') chmodSync(path, DEV_KEY_FILE_MODE);
  };
  write(PRIVATE_FILE, privateJwk);
  write(PUBLIC_FILE, publicJwk);
}

async function generateAndPersistDevKeys(): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const kid = makeKid();
  const privateJwk = { ...(await exportJWK(privateKey)), kid };
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'EdDSA' };

  registerLogSecret(privateJwk.d);
  try {
    // `wx` fails if a concurrent starter already wrote the keypair; if so we
    // reload theirs so every process converges on one keypair.
    persistDevKeyFiles(DEV_KEYS_DIR, privateJwk, publicJwk);
  } catch {
    const existing = tryReadDevKeys();
    if (existing) return fromPrivateJwk(existing.priv);
  }
  return { privateKey, publicKey, kid, publicJwk };
}

async function load(): Promise<KeyMaterial> {
  if (PRIVATE_JWK_ENV) {
    // G-28b: never let a JSON SyntaxError (which quotes a slice of the input)
    // surface key material in a startup error.
    let parsed: JWK;
    try {
      parsed = JSON.parse(PRIVATE_JWK_ENV) as JWK;
    } catch {
      throw new Error(
        '[wot-auth] WOT_JWT_PRIVATE_JWK is set but is not valid JSON (value withheld). ' +
        'Provide the private JWK exactly as exported from Secret Manager.',
      );
    }
    return fromPrivateJwk(parsed);
  }
  if (IS_PRODUCTION) {
    // Fail closed (SR-1 H-2): auto-generating a key in prod would violate
    // "private keys live only in Secret Manager" (agent-passports.md §2.4) and
    // produce a per-instance ephemeral key that breaks cross-instance verify.
    throw new Error(
      '[wot-auth] WOT_JWT_PRIVATE_JWK is required in production but was unset. ' +
      'Refusing to auto-generate an ephemeral dev signing key. Provide the private JWK from Secret Manager.',
    );
  }
  console.warn(
    '[wot-auth] DEV MODE: no WOT_JWT_PRIVATE_JWK — using an auto-generated, disk-persisted dev keypair (.dev-keys/). ' +
    'Dev keys apply only because WOT_ENV is development|test; any other value fails closed.',
  );
  const existing = tryReadDevKeys();
  if (existing) return fromPrivateJwk(existing.priv);
  return generateAndPersistDevKeys();
}

let cached: Promise<KeyMaterial> | null = null;

/** Load (and memoize) the active signing key material. */
export function getKeyMaterial(): Promise<KeyMaterial> {
  if (!cached) cached = load();
  return cached;
}

/** Reset the cache (test helper). */
export function _resetKeyCache(): void {
  cached = null;
}
