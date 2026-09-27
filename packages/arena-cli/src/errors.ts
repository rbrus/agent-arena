/**
 * Errors that tell the user what to do next (house rule), with a stable exit
 * code, and `formatError()` — the only way an error reaches a sink: an
 * allowlist of fields (code, message), redacted and terminal-safe (C-3). Error
 * objects from http/ws are never stringified whole (they can hold request
 * options, i.e. headers).
 */

import { hostedLogFilterActive } from './hosted/log-filter.ts';
import { EXIT_CODES } from './report.ts';
import { redact } from './redact.ts';
import { toTerminalSafe } from './ui.ts';

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    /** One line, imperative: what to do next. */
    readonly next?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const misconfig = (message: string, next?: string) => new CliError(message, EXIT_CODES.misconfig, next);
export const runError = (message: string, next?: string) => new CliError(message, EXIT_CODES.error, next);

const KNOWN_NET_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset by the target',
  ENOTFOUND: 'name not found',
  EAI_AGAIN: 'DNS lookup failed (temporary)',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'connection timed out',
  EPROTO: 'TLS/protocol error',
  CERT_HAS_EXPIRED: 'the target certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the target certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the target certificate chain cannot be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the target certificate does not match the host name',
};

/**
 * Allowlisted, redacted, one-line description of any thrown value.
 *
 * G-45: while a hosted run is active, a coded error that is not one of the arena's own
 * (`EARENA_*`, whose texts never name the verified origin under hosted-v1) is described
 * by its code only: Node's DNS and TLS messages embed the host name and addresses
 * (`getaddrinfo ENOTFOUND <host>`, `Host: <host>. is not in the cert's altnames`).
 */
export function describeError(e: unknown): { code: string; message: string } {
  if (e instanceof CliError) return { code: 'cli', message: e.next ? `${e.message} Next: ${e.next}` : e.message };
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    const code = typeof o.code === 'string' ? o.code : 'error';
    const known = KNOWN_NET_CODES[code];
    if (code !== 'error' && !code.startsWith('EARENA_') && hostedLogFilterActive()) {
      const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'unknown';
      return { code, message: `${known ?? 'network or TLS error'} (${safeCode})` };
    }
    const message = typeof o.message === 'string' ? o.message : String(code);
    return { code, message: known ? `${known} (${code})` : message };
  }
  return { code: 'error', message: String(e) };
}

/** Redacted whole, made terminal-safe and cut, then redacted again at the cut (G-19). */
export function formatError(e: unknown): string {
  const d = describeError(e);
  return redact(toTerminalSafe(redact(d.message), 1000));
}
