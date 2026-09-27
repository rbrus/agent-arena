/**
 * Structured logging. Every entry is tagged with {match_id, client_id, owner_id}
 * where known. Tokens and secrets are NEVER logged (SR-2 / threat-model §2):
 * the log helper only accepts a fixed set of non-sensitive fields, and the
 * default sink redacts by key and value at any depth (wot-auth, G-6).
 */

import { serializeLogRecord } from 'wot-auth';

export interface LogFields {
  event: string;
  match_id?: string;
  client_id?: string;
  owner_id?: string;
  session_id?: string;
  player?: string;
  reason?: string;
  code?: number;
  turn_id?: number;
  detail?: Record<string, unknown>;
}

export type Logger = (fields: LogFields & { ts: string; level: 'info' | 'warn' | 'error' }) => void;

/**
 * Default logger: single-line JSON to stderr. Every line goes through the shared
 * redactor (G-6): sensitive keys at any depth are blanked and string values are
 * substring-redacted (`wotk_sk_…`, JWTs, `Bearer …`, the registered pepper and
 * signing key), including inside `detail` and error messages.
 */
export const defaultLogger: Logger = (entry) => {
  // eslint-disable-next-line no-console
  console.error(serializeLogRecord(entry as unknown as Record<string, unknown>));
};

export function makeLog(logger: Logger, level: 'info' | 'warn' | 'error' = 'info') {
  return (fields: LogFields): void => {
    logger({ ...fields, ts: new Date().toISOString(), level });
  };
}
