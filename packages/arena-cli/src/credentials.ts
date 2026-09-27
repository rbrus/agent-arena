/**
 * Target credentials (threat model §1.1). The CLI accepts a REFERENCE, never a
 * value: `--auth env:NAME` (read from this process's environment) or
 * `--auth secret:name` (read from `$AGENT_ARENA_SECRETS_DIR/name`). The value is
 * registered with the Redactor before anything else can print it, lives only in
 * this process's memory, and is attached only to the origin the user typed.
 * The RunSpec written to disk carries `{scheme, ref, header_name}` — the
 * reference — and nothing else.
 *
 * Refused outright (before any network I/O): literal secrets on argv
 * (`--token`, `--header`, `--bearer`, `--api-key`, `--password`), userinfo in
 * the target URL, credential-shaped query parameters (unless
 * `--allow-query-secret`), and values shorter than 8 characters.
 *
 * G-26: a secret file is opened ONCE with O_NOFOLLOW (a symlink fails the open
 * itself) and every check (regular file, owner-only mode, size) runs on the
 * open descriptor with fstat, so nothing can be swapped between check and
 * read. An `env:` credential is deleted from `process.env` as soon as it is
 * read, so a diagnostic report or a child process cannot see it; the value
 * then lives only in a closure behind the non-enumerable `credential.value`
 * getter (JSON.stringify / util.inspect of the object show no value).
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { misconfig } from './errors.ts';
import type { Credential } from './net/index.ts';
import { MIN_SECRET_LENGTH, registerSecret } from './redact.ts';

export const REF_RE = /^(env:[A-Z_][A-Z0-9_]{0,63}|secret:[a-z0-9][a-z0-9_-]{0,63})$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'cookie', 'user-agent', 'x-agent-arena-run']);

export { HEADER_RE, FORBIDDEN_HEADERS };
export const LITERAL_SECRET_FLAGS = ['--token', '--header', '--bearer', '--api-key', '--apikey', '--password', '--secret'];
const QUERY_SECRET_NAMES = /^(token|access_token|id_token|key|api_key|apikey|api-key|sig|signature|code|secret|password|auth)$/i;

export interface AuthSpec {
  scheme: 'bearer' | 'header';
  ref: string;
  header_name?: string;
}

export interface LoadedAuth {
  spec: AuthSpec;
  credential: Credential;
  refKind: 'env' | 'secret';
}

/** Parse `--auth` + `--auth-header` into the RunSpec auth block (reference only). */
export function parseAuthFlags(ref: string | undefined, headerName: string | undefined): AuthSpec | undefined {
  if (ref === undefined) {
    if (headerName !== undefined) throw misconfig('--auth-header needs --auth env:NAME or --auth secret:name.');
    return undefined;
  }
  if (!REF_RE.test(ref)) {
    throw misconfig(
      '--auth takes a reference, not a value: env:NAME (upper-case environment variable) or secret:name (a file in $AGENT_ARENA_SECRETS_DIR).',
      'export TARGET_TOKEN=... then pass --auth env:TARGET_TOKEN',
    );
  }
  if (headerName === undefined) return { scheme: 'bearer', ref };
  if (!HEADER_RE.test(headerName) || FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
    throw misconfig(`--auth-header must be a plain header name (letters, digits, '-') and not a hop-by-hop or arena header.`);
  }
  return headerName.toLowerCase() === 'authorization' ? { scheme: 'bearer', ref } : { scheme: 'header', ref, header_name: headerName };
}

export const MAX_SECRET_FILE_BYTES = 16 * 1024;

function readSecretFile(name: string): string {
  const dir = process.env.AGENT_ARENA_SECRETS_DIR;
  if (!dir) throw misconfig(`--auth secret:${name} needs AGENT_ARENA_SECRETS_DIR (a directory holding one file per secret).`, 'export AGENT_ARENA_SECRETS_DIR=/path/to/secrets');
  const path = join(resolve(dir), name);
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO planted under the name cannot hang the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ELOOP') throw misconfig(`secret "${name}" is a symlink; the arena reads regular files only.`, `replace it with the file itself (mode 600).`);
    throw misconfig(`secret "${name}" not found in AGENT_ARENA_SECRETS_DIR (${code ?? 'error'}).`, `create the file ${name} there (mode 600).`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw misconfig(`secret "${name}" is not a regular file.`, `store the credential in a plain file (mode 600).`);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw misconfig(`secret "${name}" is readable by group/others (mode ${(st.mode & 0o777).toString(8)}).`, `chmod 600 the file.`);
    }
    if (st.size > MAX_SECRET_FILE_BYTES) throw misconfig(`secret "${name}" is larger than 16 KiB; that is not a credential.`);
    const buf = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_SECRET_FILE_BYTES) throw misconfig(`secret "${name}" is larger than 16 KiB; that is not a credential.`);
    const value = buf.toString('utf8', 0, n).replace(/\r?\n$/, '');
    buf.fill(0);
    return value;
  } finally {
    closeSync(fd);
  }
}

/** A credential whose value lives in a closure: not enumerable, not serialisable, not inspectable. */
function sealedCredential(header: string, value: string): Credential {
  const c = { header } as Credential;
  Object.defineProperty(c, 'value', { get: () => value, enumerable: false, configurable: false });
  Object.defineProperty(c, 'toJSON', { value: () => ({ header, value: '[redacted]' }), enumerable: false });
  Object.defineProperty(c, Symbol.for('nodejs.util.inspect.custom'), { value: () => `Credential { header: '${header}', value: [redacted] }`, enumerable: false });
  return c;
}

/** Resolve the reference to a value, register it with the Redactor, and build the header. */
export function loadCredential(spec: AuthSpec): LoadedAuth {
  const [kind, name] = [spec.ref.slice(0, spec.ref.indexOf(':')), spec.ref.slice(spec.ref.indexOf(':') + 1)] as ['env' | 'secret', string];
  let value: string | undefined;
  if (kind === 'env') {
    value = process.env[name];
    if (value === undefined || value === '') throw misconfig(`--auth env:${name}: the environment variable ${name} is not set.`, `export ${name}=<your target's token> (or set it as a CI secret).`);
    // Scrub: from here on the value exists only in this closure (and the redactor's registry).
    delete process.env[name];
  } else {
    value = readSecretFile(name);
  }
  return credentialFromValue(spec, value, kind);
}

/**
 * Check a credential VALUE that was already taken (and scrubbed) from its source,
 * register it with the Redactor and seal it into a header. Shared by `--auth`
 * (above) and the hosted runner, which reads `ARENA_TARGET_CREDENTIAL` itself.
 */
export function credentialFromValue(spec: AuthSpec, value: string, kind: 'env' | 'secret'): LoadedAuth {
  if (/[\r\n\0]/.test(value)) throw misconfig(`the credential from ${spec.ref} contains a line break or NUL; refusing to send it as a header.`);
  if (value.length < MIN_SECRET_LENGTH) throw misconfig(`the credential from ${spec.ref} is shorter than ${MIN_SECRET_LENGTH} characters; that cannot be a real key and cannot be redacted safely.`);
  registerSecret(value, kind);
  const credential = spec.scheme === 'bearer' ? sealedCredential('authorization', `Bearer ${value}`) : sealedCredential(spec.header_name!.toLowerCase(), value);
  // `Bearer <tok>` has a public prefix: exact matches only (the bare token above covers partial ones).
  registerSecret(credential.value, kind, { partial: false });
  return { spec, credential, refKind: kind };
}

/** Refuse literal secrets on argv, userinfo, and credential-looking query parameters (C-1). */
export function assertNoLiteralSecrets(argv: readonly string[], target: URL | null, allowQuerySecret: boolean): void {
  for (const a of argv) {
    const flag = a.split('=')[0];
    if (LITERAL_SECRET_FLAGS.includes(flag)) {
      throw misconfig(`${flag} is not accepted: a secret on the command line leaks through ps, shell history and CI logs.`, 'put it in an environment variable and pass --auth env:NAME');
    }
  }
  if (!target) return;
  if (target.username || target.password) throw misconfig('the target URL contains user:password@; it would be copied into reports and logs.', 'remove it and pass --auth env:NAME');
  if (!allowQuerySecret) {
    for (const k of target.searchParams.keys()) {
      if (QUERY_SECRET_NAMES.test(k)) {
        throw misconfig(`the target URL has a credential-looking query parameter "${k}"; URLs are copied into reports.`, 'use --auth env:NAME, or pass --allow-query-secret if the parameter is not secret');
      }
    }
  }
}

/** The target URL as it may appear in a report / log: no userinfo, sensitive query values redacted. */
export function redactUrl(u: URL): string {
  const c = new URL(u.toString());
  c.username = '';
  c.password = '';
  for (const k of [...c.searchParams.keys()]) if (QUERY_SECRET_NAMES.test(k)) c.searchParams.set(k, 'redacted');
  c.hash = '';
  return c.toString();
}
