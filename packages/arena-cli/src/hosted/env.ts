/**
 * The hosted runner's environment (HOSTED-PROFILE §2.4 steps 2-3,
 * threat-model-hosted §2.1, §2.5, §3).
 *
 * `takeHostedSecrets` runs FIRST in `run --hosted`, before any parsing or
 * validation: it reads every per-run secret variable once, deletes it from the
 * environment (so a diagnostic report, a child process or a later reader sees
 * nothing), registers every credential with the Redactor, and keeps the values
 * only in a closure. The secret variables are:
 *
 *   ARENA_TARGET_CREDENTIAL             primary target credential (credential_mode != none)
 *   ARENA_SEAT_CREDENTIAL_<POWER>       a `seats[]` target of a table (K6)
 *   ARENA_DIP_SECRET_<n>                Diplomacy episode secret of episode n (0-based),
 *                                       64 lower-case hex; must hash to the manifest's commitment
 *   (contracts 2.5.0 signing.md §3.1: exactly `count` variables, n = 0..count-1 in decimal
 *    with no leading zero; the proposed ARENA_EPISODE_SECRETS array form was not taken and is
 *    refused, after being scrubbed like the rest)
 *
 * Diplomacy secrets are NOT registered with the Redactor: they are disclosed in
 * the report after the run (`diplomacy.episode_secret`, K4), which the Redactor
 * would otherwise replace. They never reach a seat, a log or an error message.
 *
 * `assertHostedEnvironment` refuses every variable that could relax the hosted
 * policy or expose the process: local secret files, the debug override, TLS
 * trust or verification changes, TLS key logging, Node option injection, and a
 * contracts-directory override.
 */

import { misconfig } from '../errors.ts';
import { registerSecret } from '../redact.ts';

export const TARGET_CREDENTIAL_VAR = 'ARENA_TARGET_CREDENTIAL';
export const SEAT_CREDENTIAL_PREFIX = 'ARENA_SEAT_CREDENTIAL_';
export const DIP_SECRET_PREFIX = 'ARENA_DIP_SECRET_';
/** Not a contract variable (SIXI-INTEGRATION proposal, not taken in 2.5.0): scrubbed and refused. */
export const EPISODE_SECRETS_VAR = 'ARENA_EPISODE_SECRETS';
/** Deprecated env form of the manifest (2.5.0): refused by this runner, which reads files only. */
export const HOSTED_CONTEXT_VAR = 'ARENA_HOSTED_CONTEXT';
export const IMAGE_DIGEST_VAR = 'ARENA_IMAGE_DIGEST';
/** Not an input: the RunSpec arrives as a file (`--run-spec`), never in the environment (SIXI-INTEGRATION §1.7). */
export const RUN_SPEC_VAR = 'ARENA_RUN_SPEC';
export const PACKS_DIR_VAR = 'ARENA_PACKS_DIR';

const SEAT_VAR = /^ARENA_SEAT_CREDENTIAL_[A-Z]{1,16}$/;
const DIP_VAR = /^ARENA_DIP_SECRET_(0|[1-9][0-9]{0,3})$/;

/** Per-run secret values, held in closures only (no enumerable field, no JSON, no inspect). */
export interface HostedSecrets {
  /** The primary target credential, or undefined when the variable was not set. */
  target(): string | undefined;
  /** A table seat's credential (`ARENA_SEAT_CREDENTIAL_<POWER>`), by upper-case power name. */
  seat(power: string): string | undefined;
  /** The Diplomacy episode secret of episode `index`, or undefined. */
  dipSecret(index: number): string | undefined;
  /** How many well-formed ARENA_DIP_SECRET_<n> variables were delivered. */
  dipSecretCount(): number;
  /** ARENA_DIP_SECRET_* names that are not `ARENA_DIP_SECRET_<n>` with a canonical decimal n (e.g. a leading zero). */
  malformedDipNames(): string[];
  /** ARENA_EPISODE_SECRETS was set (not a contract form; refused). */
  arrayFormDelivered(): boolean;
  /** Names of every secret variable that was taken (for tests and the refusal messages; never values). */
  names(): string[];
}

/**
 * Take (read + delete) every per-run secret variable from `env`. Must be the first
 * thing `run --hosted` does. Idempotent per variable: a second call finds nothing.
 */
export function takeHostedSecrets(env: NodeJS.ProcessEnv = process.env): HostedSecrets {
  let target: string | undefined;
  const seats = new Map<string, string>();
  const dip = new Map<number, string>();
  const names: string[] = [];
  let episodeSecrets: string | undefined;
  for (const name of Object.keys(env)) {
    const isTarget = name === TARGET_CREDENTIAL_VAR;
    const isSeat = name.startsWith(SEAT_CREDENTIAL_PREFIX);
    const isDip = name.startsWith(DIP_SECRET_PREFIX);
    if (name === EPISODE_SECRETS_VAR) {
      episodeSecrets = env[name];
      delete env[name];
      names.push(name);
      continue;
    }
    if (!isTarget && !isSeat && !isDip) continue;
    const value = env[name];
    delete env[name];
    names.push(name);
    if (value === undefined) continue;
    if (isTarget) target = value;
    else if (isSeat) {
      if (SEAT_VAR.test(name)) seats.set(name.slice(SEAT_CREDENTIAL_PREFIX.length), value);
    } else if (DIP_VAR.test(name)) dip.set(Number(name.slice(DIP_SECRET_PREFIX.length)), value);
    // Credentials are redacted from every sink from this instant on, whatever happens next.
    if ((isTarget || isSeat) && value.length > 0) registerSecret(value, 'env');
  }
  // Every ARENA_DIP_SECRET_* name that is not a canonical index is malformed (contract: refused, never ignored).
  const malformed = names.filter((n) => n.startsWith(DIP_SECRET_PREFIX) && !DIP_VAR.test(n));
  const s = {} as HostedSecrets;
  Object.defineProperties(s, {
    target: { value: () => target, enumerable: false },
    seat: { value: (p: string) => seats.get(p), enumerable: false },
    dipSecret: { value: (i: number) => dip.get(i), enumerable: false },
    dipSecretCount: { value: () => dip.size, enumerable: false },
    malformedDipNames: { value: () => [...malformed].sort(), enumerable: false },
    arrayFormDelivered: { value: () => episodeSecrets !== undefined, enumerable: false },
    names: { value: () => [...names].sort(), enumerable: false },
    toJSON: { value: () => ({ secrets: '[redacted]' }), enumerable: false },
    [Symbol.for('nodejs.util.inspect.custom')]: { value: () => 'HostedSecrets { [redacted] }', enumerable: false },
  });
  return s;
}

/**
 * contracts 2.6.0 signing.md §3.1.1 "must be absent" (normative, closed list), in the
 * order and with the `detail.field` of `contracts/fixtures/hosted_env.json`
 * `must_be_absent`. A test loads the fixture and asserts this table equals it (name,
 * field, `unless`, pattern). Presence is what counts (an empty value is still present),
 * except NODE_OPTIONS, which the job template sets explicitly empty.
 */
export interface MustBeAbsent {
  name: string;
  field: 'environment' | 'manifest_source' | 'episode_secret_commitments';
  unless?: 'empty';
  /** For a name family (`ARENA_DIP_SECRET_<x>`): the names it covers. */
  pattern?: RegExp;
  /** The variable is a secret: taken and scrubbed by takeHostedSecrets before it is refused. */
  takenAsSecret?: boolean;
  reason: string;
}

export const HOSTED_MUST_BE_ABSENT: readonly MustBeAbsent[] = [
  { name: 'AGENT_ARENA_SECRETS_DIR', field: 'environment', reason: 'local secret files are not a hosted credential source (the only one is env:ARENA_TARGET_CREDENTIAL)' },
  { name: 'ARENA_DEBUG', field: 'environment', reason: 'the diagnostics override is not available to the hosted runner' },
  { name: 'NODE_OPTIONS', field: 'environment', unless: 'empty', reason: 'Node options (preloads, inspector, reports) are not accepted by the hosted runner (an explicitly empty NODE_OPTIONS is fine)' },
  { name: 'NODE_DEBUG', field: 'environment', reason: 'Node core debug logging is not accepted by the hosted runner' },
  { name: 'NODE_TLS_REJECT_UNAUTHORIZED', field: 'environment', reason: 'certificate validation cannot be relaxed in hosted mode' },
  { name: 'NODE_EXTRA_CA_CERTS', field: 'environment', reason: 'the TLS trust store cannot be extended in hosted mode' },
  { name: 'SSLKEYLOGFILE', field: 'environment', reason: 'TLS key logging would expose the session keys of the target connection' },
  { name: 'NODE_V8_COVERAGE', field: 'environment', reason: 'coverage output writes outside /out' },
  { name: 'WOT_CONTRACTS_DIR', field: 'environment', reason: 'the contract schemas are the ones this build was released with' },
  { name: HOSTED_CONTEXT_VAR, field: 'manifest_source', reason: 'the run manifest is read from the --manifest file only' },
  { name: RUN_SPEC_VAR, field: 'manifest_source', reason: 'the RunSpec is read from the --run-spec file only' },
  { name: EPISODE_SECRETS_VAR, field: 'episode_secret_commitments', takenAsSecret: true, reason: 'not a contract variable; deliver ARENA_DIP_SECRET_<n>' },
  { name: 'ARENA_DIP_SECRET_<x>', pattern: /^ARENA_DIP_SECRET_(?!(0|[1-9][0-9]{0,3})$)/, field: 'episode_secret_commitments', takenAsSecret: true, reason: 'a malformed episode-secret variable name' },
];

/** Variables that would relax the hosted-v1 policy or expose the process; refused outright in hosted mode (`detail.field` environment). */
export const HOSTED_FORBIDDEN_ENV: Readonly<Record<string, string>> = Object.fromEntries(HOSTED_MUST_BE_ABSENT.filter((r) => r.field === 'environment').map((r) => [r.name, r.reason]));

/**
 * G-50: on top of the closed must-be-absent list, an ALLOW-LIST over the name families
 * that can change what the runtime trusts, loads or writes: every `ARENA_*`, `NODE_*`,
 * `SSL*` and `OPENSSL*` name, and every proxy variable, that is not one of these is
 * refused (`environment`). Covers `NODE_USE_SYSTEM_CA`, `NODE_USE_ENV_PROXY`,
 * `NODE_COMPILE_CACHE`, `NODE_REPL_EXTERNAL_MODULE`, `SSL_CERT_FILE`/`SSL_CERT_DIR`,
 * `OPENSSL_CONF`/`OPENSSL_MODULES`, `HTTPS_PROXY` and the like.
 */
export const HOSTED_ALLOWED_ENV: Readonly<Record<string, string>> = {
  // hosted_env.json job_template
  [IMAGE_DIGEST_VAR]: 'job template',
  [PACKS_DIR_VAR]: 'job template',
  NODE_OPTIONS: 'job template (empty only)',
  ARENA_HOSTED: 'job template (hosted-mode assertion, G-48)',
  // Set by the agent-arena image (sandbox/Dockerfile) or its Node base image; no effect on the runner.
  NODE_ENV: 'image (production only)',
  NODE_VERSION: 'base image (informational)',
  YARN_VERSION: 'base image (informational)',
};
/**
 * Per-run secret names (hosted_env.json `secrets`); taken and scrubbed before this check runs.
 * (contracts 2.10.0, signing.md §3.2 M10) an episode-secret index is 0..49: a hosted Diplomacy-family run has
 * at most 50 episodes. A canonical index of 50 or more is not malformed (DIP_VAR): it is taken as a secret
 * and refused as n >= count (`episode_secret_commitments`).
 */
export const HOSTED_SECRET_PATTERNS: readonly RegExp[] = [/^ARENA_TARGET_CREDENTIAL$/, /^ARENA_SEAT_CREDENTIAL_[A-Z]{1,16}$/, /^ARENA_DIP_SECRET_([0-9]|[1-4][0-9])$/];
const SECRET_NAME = HOSTED_SECRET_PATTERNS;
const GUARDED_FAMILY = /^(?:ARENA_|NODE_|SSL|OPENSSL)/i;
const PROXY_VAR = /^(?:https?|all|no|ftp|grpc|ws|wss)_proxy$/i;

/**
 * The deprecated env form of the two documents (contracts 2.5.0 signing.md §3.1). This runner reads
 * files only; either variable is refused, and with a file as well it is the contract's two-sources case.
 */
export function assertNoEnvDocuments(env: NodeJS.ProcessEnv): void {
  const given = HOSTED_MUST_BE_ABSENT.filter((r) => r.field === 'manifest_source' && env[r.name] !== undefined).map((r) => r.name);
  if (given.length) {
    throw misconfig(
      `hosted_context_invalid (manifest_source): ${given.join(' and ')} set; the hosted runner reads the run manifest and the RunSpec only from the --manifest and --run-spec files (the env form is withdrawn, contracts 2.6.0). Nothing was sent.`,
      `remove ${given.join(', ')} from the job; pass --manifest <file> --run-spec <file> from the run's read-only input folder.`,
    );
  }
}

/** The environment-field refusals for `env`: must-be-absent names, then the G-50 allow-list. Names only, never values. */
export function hostedEnvironmentProblems(env: NodeJS.ProcessEnv): { name: string; reason: string }[] {
  const out: { name: string; reason: string }[] = [];
  for (const r of HOSTED_MUST_BE_ABSENT) {
    if (r.field !== 'environment') continue;
    const v = env[r.name];
    if (v === undefined || (r.unless === 'empty' && v.trim() === '')) continue;
    out.push({ name: r.name, reason: r.reason });
  }
  const listed = new Set(HOSTED_MUST_BE_ABSENT.map((r) => r.name));
  for (const name of Object.keys(env).sort()) {
    if (listed.has(name) || env[name] === undefined) continue;
    if (name === 'NODE_ENV') {
      if (env[name] !== 'production') out.push({ name, reason: 'NODE_ENV is accepted only as the image sets it (production)' });
      continue;
    }
    if (Object.hasOwn(HOSTED_ALLOWED_ENV, name) || SECRET_NAME.some((re) => re.test(name))) continue;
    if (name.startsWith(DIP_SECRET_PREFIX) || name === EPISODE_SECRETS_VAR) continue; // taken as secrets, refused as episode_secret_commitments
    if (PROXY_VAR.test(name)) out.push({ name, reason: 'proxy variables are not accepted (the hosted runner never uses a proxy)' });
    else if (GUARDED_FAMILY.test(name)) out.push({ name, reason: 'not a variable of the hosted job template (it could change what the runtime trusts, loads or writes)' });
  }
  return out;
}

export function assertHostedEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const bad = hostedEnvironmentProblems(env);
  if (bad.length) {
    const names = bad.map((b) => b.name.slice(0, 64));
    throw misconfig(
      `hosted_context_invalid (environment): refusing to start a hosted run with ${names.join(', ')} set: ${[...new Set(bad.map((b) => b.reason))].join('; ')}. Nothing was sent.`,
      `remove ${names.join(', ')} from the job's environment (the hosted job spec sets only ${IMAGE_DIGEST_VAR}, ${PACKS_DIR_VAR}, ARENA_HOSTED, an empty NODE_OPTIONS and the per-run secret variables).`,
    );
  }
}
