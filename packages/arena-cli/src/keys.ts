/**
 * `verify --key <pem|jwk>`: the Ed25519 PUBLIC key a sealed report is checked
 * against (contracts/signing.md). Accepts a path to a PEM (SPKI) or JWK file,
 * or the PEM / JWK text itself. A private key is refused: verification never
 * needs one, and a CLI that accepts it invites pasting it into shell history.
 *
 * G-30: the argument (and the file behind it) may BE a private key the user
 * pasted by mistake, so:
 *   - the argument is classified before anything treats it as a path: text
 *     containing `PRIVATE KEY` or a `"d"` member is refused as a private key,
 *     and text with a line break that is not PEM/JWK text is refused as "not a
 *     key and not a readable file" (a PKCS#12 export with `Bag Attributes`
 *     before the PEM, a quoted paste);
 *   - NO error message quotes any part of the argument or of the file, and
 *     crypto errors are reduced to their error code;
 *   - the file is opened once with O_NOFOLLOW (a symlink is refused by the
 *     kernel, no lstat-then-read race), checked with fstat on that descriptor
 *     (regular file, ≤ MAX_KEY_BYTES), and read in one capped read.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { misconfig } from './errors.ts';
import { toPublicKey } from './report.ts';

export const MAX_KEY_BYTES = 64 * 1024;

const WANT = 'pass the Ed25519 public key the document was signed with: a path to a PEM ("BEGIN PUBLIC KEY") or OKP JWK file, or that PEM / JWK text.';
const PRIVATE_PEM = /PRIVATE KEY/;
const PRIVATE_JWK = /"d"\s*:/;

function refusePrivate(kind: 'PEM' | 'JWK' | 'text', F = '--key'): never {
  throw misconfig(
    kind === 'JWK'
      ? `${F}: this JWK holds a PRIVATE key (it has "d"); verification needs only the public key. The key was not printed.`
      : `${F}: this ${kind === 'PEM' ? 'PEM' : 'argument'} holds a PRIVATE key; verification needs only the public key. The key was not printed.`,
    kind === 'JWK'
      ? 'remove "d" (keep kty, crv, x) and rotate the key if it left its store.'
      : 'export the public key (`openssl pkey -in key.pem -pubout`), and rotate the key if it was pasted anywhere shared (shell history, a CI log).',
  );
}

/** Refuse private material anywhere in `text`, whatever it looks like otherwise. */
function refuseIfPrivate(text: string, F = '--key'): void {
  if (PRIVATE_PEM.test(text)) refusePrivate('PEM', F);
  if (PRIVATE_JWK.test(text)) refusePrivate('JWK', F);
}

const looksLikeKeyText = (t: string) => t.startsWith('-----BEGIN') || t.startsWith('{');

/** Read a key file: one open (O_NOFOLLOW), fstat on the descriptor, one capped read. Never names the path. */
function readKeyFile(path: string, F = '--key'): string {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  if (!noFollow) {
    // Platforms without O_NOFOLLOW (Windows): best-effort pre-check; the fstat below still applies.
    try {
      if (lstatSync(path).isSymbolicLink()) throw misconfig(`${F}: the key file is a symbolic link.`, 'pass the key file itself, not a symlink.');
    } catch (e) {
      if ((e as { exitCode?: number }).exitCode !== undefined) throw e;
    }
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw misconfig(`${F}: the key file is a symbolic link.`, 'pass the key file itself, not a symlink.');
    if (code === 'EACCES' || code === 'EPERM') throw misconfig(`${F}: the key file cannot be read (permission denied).`, 'check the file permissions, or pass the public key text instead.');
    throw misconfig(`${F}: the argument is not a key and not a readable file. It is not printed, in case it is key material.`, WANT);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw misconfig(`${F}: the path is not a regular file.`, 'pass the key file itself, not a directory, device or pipe.');
    if (st.size > MAX_KEY_BYTES) throw misconfig(`${F}: the key file is ${st.size} bytes; an Ed25519 public key is well under ${MAX_KEY_BYTES}.`, WANT);
    const buf = Buffer.alloc(MAX_KEY_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_KEY_BYTES) throw misconfig(`${F}: the key file grew past ${MAX_KEY_BYTES} bytes while it was read.`, WANT);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The key text behind `arg` (the text itself, or the file it names), private material refused. Never echoes either. */
function keyText(arg: string, F: string): string {
  // Classify BEFORE any path handling (G-30).
  refuseIfPrivate(arg, F);
  let text = arg.trim();
  if (!looksLikeKeyText(text)) {
    if (/[\r\n]/.test(arg)) {
      throw misconfig(`${F}: the argument is not a key and not a readable file (it spans several lines but is not PEM or JWK text). It is not printed.`, WANT);
    }
    text = readKeyFile(arg, F).trim();
    refuseIfPrivate(text, F);
    if (!looksLikeKeyText(text)) throw misconfig(`${F}: the file is not a PEM or JWK key. Its content is not printed.`, WANT);
  }
  return text;
}

const JWK_HINT = 'pass an OKP JWK {"kty":"OKP","crv":"Ed25519","x":"…"}.';

function jwkKey(j: unknown, F: string): { key: KeyObject; kid?: string } {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw misconfig(`${F}: the JWK is not an Ed25519 OKP key.`, JWK_HINT);
  const o = j as Record<string, unknown>;
  if ('d' in o) refusePrivate('JWK', F);
  if (o.kty !== 'OKP' || o.crv !== 'Ed25519' || typeof o.x !== 'string') throw misconfig(`${F}: the JWK is not an Ed25519 OKP key.`, JWK_HINT);
  if (o.kid !== undefined && (typeof o.kid !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(o.kid))) throw misconfig(`${F}: the JWK kid is not a key id (^[a-z0-9][a-z0-9._-]{2,63}$).`, 'fix or remove "kid".');
  return { key: toKey({ kty: 'OKP', crv: 'Ed25519', x: o.x }, F), ...(typeof o.kid === 'string' ? { kid: o.kid } : {}) };
}

function toKey(input: string | { kty: 'OKP'; crv: 'Ed25519'; x: string }, F: string): KeyObject {
  try {
    return toPublicKey(input);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const safe = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? ` (${code})` : '';
    throw misconfig(`${F}: not a usable Ed25519 public key${safe}.`, 'pass the Ed25519 public key the document was signed with (PEM or OKP JWK).');
  }
}

function parseJson(text: string, F: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw misconfig(`${F}: the JWK is not valid JSON.`, JWK_HINT);
  }
}

export function loadPublicKey(arg: string, F = '--key'): KeyObject {
  const text = keyText(arg, F);
  if (text.startsWith('{')) return jwkKey(parseJson(text, F), F).key;
  return toKey(text, F);
}

/** One pinned key, with the key id it is bound to (JWK `kid`), when the key names one. */
export interface PinnedKey {
  key: KeyObject;
  kid?: string;
  /** Epoch ms. The bundled release keys carry a window (hosted/pinned-keys.json); a key from a flag has none. */
  not_before?: number;
  not_after?: number;
  revoked_at?: number;
}

/** Why `k` may not verify a document signed at `at` (epoch ms), or null when it may. A key without a window (a test or --manifest-key key) has no limit. */
export function keyWindowProblem(k: PinnedKey, at: number): string | null {
  if (k.not_before === undefined && k.not_after === undefined && k.revoked_at === undefined) return null;
  const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
  if (Number.isNaN(at)) return 'the signing time is missing or not a time';
  if (k.not_before !== undefined && at < k.not_before) return `signed at ${iso(at)}, before the key's not_before ${iso(k.not_before)}`;
  if (k.not_after !== undefined && at >= k.not_after) return `signed at ${iso(at)}, at or after the key's not_after ${iso(k.not_after)}`;
  if (k.revoked_at !== undefined && at >= k.revoked_at) return `signed at ${iso(at)}, at or after the key's revoked_at ${iso(k.revoked_at)}`;
  return null;
}

/**
 * The keys that may verify a document signed by `kid` at `at`: a pinned key with that kid (or
 * a kid-less key) whose window covers `at`. `problem` says why none is left: `unpinned`, or the window problem.
 */
export function keysForKid(keys: readonly PinnedKey[], kid: string | undefined, at: number): { keys: PinnedKey[]; problem?: string } {
  const named = keys.filter((k) => k.kid === undefined || k.kid === kid);
  if (!named.length) return { keys: [], problem: 'unpinned' };
  const inWindow = named.filter((k) => keyWindowProblem(k, at) === null);
  if (!inWindow.length) return { keys: [], problem: keyWindowProblem(named[0]!, at) ?? 'outside the key window' };
  return { keys: inWindow };
}


/**
 * A pinned key set (`run --hosted --manifest-key`): a PEM (one key, no kid), an
 * OKP JWK (one key, its `kid` when present) or a JWKS `{"keys":[…]}` (every key
 * must carry a distinct `kid`, so a rotation can pin old and new side by side).
 */
export function loadPublicKeySet(arg: string, F: string): PinnedKey[] {
  const text = keyText(arg, F);
  if (!text.startsWith('{')) return [{ key: toKey(text, F) }];
  const j = parseJson(text, F);
  if (j && typeof j === 'object' && !Array.isArray(j) && 'keys' in j) {
    const keys = (j as { keys: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 16) throw misconfig(`${F}: the JWKS must hold 1..16 keys.`, JWK_HINT);
    const out = keys.map((k) => jwkKey(k, F));
    const kids = out.map((k) => k.kid);
    if (kids.some((k) => k === undefined) || new Set(kids).size !== kids.length) throw misconfig(`${F}: every key of a JWKS needs its own distinct "kid".`, 'add a kid to each key.');
    return out;
  }
  return [jwkKey(j, F)];
}
