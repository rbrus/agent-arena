/**
 * agent-arena — evaluate an AI agent against deterministic failure-mode
 * scenarios. The engine runs in this process; no server, no model.
 *
 *   agent-arena run --scenario byzantine --seat squad --target http://localhost:8080
 *   agent-arena list-scenarios
 *   agent-arena replay arena-report/report.json --episode 0
 *   agent-arena verify arena-report/report.json
 *   agent-arena serve-reference --scenario byzantine --seat squad --port 8080
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { engineBuildHash, VERSION } from './build-info.ts';
import { ENGINE_BUILD_SCOPES } from 'arena-report';
import { listScenariosCommand } from './commands/list-scenarios.ts';
import { replayCommand } from './commands/replay.ts';
import { runCommand, type RunFlags } from './commands/run.ts';
import { runHostedCommand } from './commands/run-hosted.ts';
import { readRunSpecDocument, runSpecFlags, specFileLocation, SPEC_COMPATIBLE_FLAGS } from './commands/run-spec-file.ts';
import { serveReferenceCommand } from './commands/serve-reference.ts';
import { verifyCommand, verifyHostedSeal } from './commands/verify.ts';
import { CliError, formatError } from './errors.ts';
import type { PinnedKey } from './keys.ts';
import { assertNoDiagnostics } from './hardening.ts';
import { EXIT_CODES } from './report.ts';
import { errorLine, markStdoutClosed, setOutputMode, writeStdout } from './ui.ts';

const HELP = `agent-arena ${VERSION} — deterministic agent evaluation (no model runs here)

Usage:
  agent-arena run --scenario <id> --target <url|ref:coordinated> [options]
  agent-arena run --spec <run.json> [--out <dir>] [--json|--quiet] [--i-own-this-target] [--auth env:NAME|secret:name]
                           (the whole RunSpec from a file, schema-checked; no other run flag combines with it)
  agent-arena run --hosted --manifest <path> --run-spec <path> [--out <dir>] [--json]
                           (Sixi hosted runner only: every other run flag is refused; see README "Hosted mode".
                            The manifest is checked against the control-plane keys this release pins;
                            --manifest-key is refused while a key set is pinned)
  agent-arena list-scenarios [--json]
  agent-arena replay <report.json> --episode <n> | --hash <sha256:…> [--json]
  agent-arena verify <report.json> [--key <public key pem|jwk> | --key pinned] [--hosted] [--json]
                              (--key pinned: the Sixi report keys bundled in this release, see README
                               "Pinned control-plane keys")
                              (--hosted also checks run-manifest.json beside the report and the Diplomacy commitments)
  agent-arena verify --hosted-seal <bundle-dir|report.json> [--key <report key|jwks> | --key pinned]
                              [--expect-manifest-digest <sha256:…>] [--result <path>] [--json]
                              (a hosted bundle: pre-seal, or sealed with its DSSE envelopes and bundle-manifest.json,
                               each signed raw or through a digest statement; SARIF re-render byte equality, run
                               manifest, commitments, then re-simulation. Pre-seal checks the run manifest's signature
                               against the release's pinned keys. --result also writes the --json document to <path>,
                               create-only, outside the bundle, for every exit 0-2 (and 3 after the path is accepted))
  agent-arena version [--json]      (--json adds this build's engine build hashes per scope)
  agent-arena serve-reference [--scenario <id>] [--seat squad] [--policy coordinated|naive] [--port 8080]
                              [--host 127.0.0.1] [--allow-non-loopback]   (any other --host needs the flag)
                              [--allow-origin <scheme://host[:port]>]...  (browser origins; default none: 403)
                              diplomacy_standard: --policy robust|credulous|injector|house [--agent-seed <uint32>]
                              [--hosted --verified-origin <https://host[:port]> --run-token-key <pem|jwk|jwks>
                               [--run-token-issuer <iss>] [--require-run-token]]   (cross-check reference origin:
                               Host allowlist + sixi_run_token verification, bound to X-Agent-Arena-Run)

run options:
  --scenario <id>          grid_tactics | hallucinator | overfit | byzantine | deadlock | split_brain | latency
                           | diplomacy_standard
  --seat <mode>            duel | squad | member (or m0..m4, A, B); default duel / member
                           diplomacy_standard: a power (austria … turkey) or auto (default; seeded per episode)
  --position <seat>        A|B (duel) or m0..m4 (member)      --fill coordinated|naive (member)
  --fill <fill>            diplomacy_standard: injector-table (default; profile security, the RunSpec default)
                           | house (profile clean) | robust | credulous
                           | table:<manipulation_followed|commitment_broken|injection_followed|intent_leak|
                             budget_violation|combined>  (short forms table:commitment, … accepted)
  --horizon <year>         diplomacy_standard: last game year, 1901..1908 (default 1906)
  --secret <64 hex>        diplomacy_standard, hosted only (the control plane draws the episode secret); refused locally
  --tier <tier>            edge | core | frontier | extended (default core; extended: Dh 30 s)
  --seeds <a,b,...>        uint32 seeds (default the five gate seeds 20260720,1,2,3,5); --seed is an alias
  --episodes <n>           default = number of seeds
  --target <url>           http(s)://… (rest|mcp|a2a) or ws(s)://… ; ref:coordinated|ref:naive runs in-process
                           (diplomacy_standard: ref:robust | ref:credulous | ref:house)
  --transport <t>          rest | ws | mcp | a2a (inferred from the URL when omitted)
  --auth env:NAME|secret:name   credential REFERENCE (value from the env, or $AGENT_ARENA_SECRETS_DIR/name)
  --auth-header <Name>     send the credential as <Name>: <value> instead of Authorization: Bearer
  --out <dir>              default ./arena-report (report.json, report.sarif, per-episode replay files)
                           a flag-driven run also writes .agent-arena/<scenario>.run.json (the RunSpec as run;
                           the SARIF location points at it; with --spec the SARIF points at the spec file)
  --i-own-this-target      required for any non-loopback target ("I own this endpoint or am authorised to test it")
  --allow-private          allow private / loopback addresses reached via a hostname (logged)
  --allow-link-local       allow link-local and cloud-metadata addresses (separate on purpose)
  --follow-redirects       follow same-origin redirects (max 3, each re-checked); default: refused
  --max-rps <n>            per-target request rate (default 5/s for non-loopback, max 50)
  --max-retry-after <s>    longest Retry-After (429/503) the run waits out; longer aborts (default 30, max 3600)
  --ci github              in GitHub Actions: ::add-mask:: every form of the credential before any output
  --fail-on <severity>     error | warning | note (default error)
  --json                   machine-readable output on stdout

Exit codes: 0 ok · 1 findings (run) / mismatch (verify) · 2 error · 3 misconfiguration

Node diagnostics that can dump memory or the environment (--inspect*, --heapsnapshot-signal,
--report-on-*, --cpu-prof, --heap-prof, --prof, in the command line or NODE_OPTIONS) are refused;
set ARENA_DEBUG=1 to override.

With ARENA_HOSTED set (the hosted runner image) only \`run --hosted\`, \`verify --hosted-seal\` and
\`version\` are accepted; everything else exits 3 (hosted_mode_only).
`;

const RUN_OPTIONS: ParseArgsConfig['options'] = {
  spec: { type: 'string' },
  scenario: { type: 'string' },
  seat: { type: 'string' },
  position: { type: 'string' },
  fill: { type: 'string' },
  tier: { type: 'string' },
  horizon: { type: 'string' },
  seeds: { type: 'string' },
  seed: { type: 'string' },
  episodes: { type: 'string' },
  target: { type: 'string' },
  transport: { type: 'string' },
  auth: { type: 'string' },
  'auth-header': { type: 'string' },
  out: { type: 'string' },
  'allow-private': { type: 'boolean' },
  'allow-link-local': { type: 'boolean' },
  'i-own-this-target': { type: 'boolean' },
  'attest-ownership': { type: 'boolean' },
  'follow-redirects': { type: 'boolean' },
  'allow-query-secret': { type: 'boolean' },
  'allow-insecure-transport': { type: 'boolean' },
  'max-rps': { type: 'string' },
  'max-retry-after': { type: 'string' },
  'fail-on': { type: 'string' },
  label: { type: 'string' },
  hosted: { type: 'boolean' },
  ci: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  // Literal secrets are parsed only so they can be refused with a clear message.
  token: { type: 'string' },
  header: { type: 'string' },
  bearer: { type: 'string' },
  'api-key': { type: 'string' },
  password: { type: 'string' },
  secret: { type: 'string' },
};

const COMMON = { json: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' } } as const;

/**
 * `run --hosted` accepts exactly these (HOSTED-PROFILE §2.4, threat-model-hosted §2.1):
 * the manifest, the pinned key, where to write, and the output format. Every
 * other run flag (scenario, seat, seed, target, auth, network opt-ins, …) is
 * refused by name before anything is read.
 */
export const HOSTED_RUN_OPTIONS = {
  hosted: { type: 'boolean' },
  manifest: { type: 'string' },
  'run-spec': { type: 'string' },
  'manifest-key': { type: 'string' },
  out: { type: 'string' },
  json: { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

const isHostedArg = (a: string) => a === '--hosted' || a.startsWith('--hosted=');

/** Refuse, by name, every argument of a hosted run that is not in HOSTED_RUN_OPTIONS (values are never echoed). */
export function refuseCustomerRunFlags(argv: readonly string[]): void {
  const allowed = new Set(Object.keys(HOSTED_RUN_OPTIONS).map((k) => `--${k}`));
  const bad: string[] = [];
  const takesValue = new Set(['--manifest', '--run-spec', '--manifest-key', '--out']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takesValue.has(a)) {
      i++; // its value (a path, or key text that may itself start with '-----BEGIN')
      continue;
    }
    if (!a.startsWith('-')) {
      bad.push('(positional argument)');
      continue;
    }
    const name = a.split('=')[0];
    if (!allowed.has(name) || (name === '--hosted' && a.includes('='))) bad.push(name.slice(0, 40));
  }
  if (bad.length) {
    throw new CliError(
      `hosted_context_invalid: run --hosted takes its whole configuration from the signed run manifest; refused ${[...new Set(bad)].join(', ')}. Nothing was read or sent.`,
      EXIT_CODES.misconfig,
      'run --hosted accepts only --manifest, --run-spec, --manifest-key, --out and --json; scenario, seat, seeds, target, credential and network policy come from the signed manifest and the RunSpec it binds.',
    );
  }
}

type Values = Record<string, string | boolean | undefined>;

/**
 * `run --spec <run.json>`: the RunSpec file is the whole run. The flags it combines with are
 * --out, --json, --quiet (output only), --i-own-this-target and --auth; any other run flag is refused by name before
 * the file is read (a flag and a file field would disagree silently otherwise).
 */
function specRunFlags(v: Values): RunFlags {
  const extra = Object.keys(v).filter((k) => v[k] !== undefined && !(SPEC_COMPATIBLE_FLAGS as readonly string[]).includes(k));
  if (extra.length) {
    throw new CliError(
      `--spec carries the whole RunSpec; ${extra.map((k) => `--${k}`).join(', ')} cannot be combined with it.`,
      EXIT_CODES.misconfig,
      'put the setting in the RunSpec file, or run with flags and no --spec. Only --out, --json, --quiet, --i-own-this-target and --auth combine with --spec.',
    );
  }
  const path = v.spec as string;
  const { flags, labels } = runSpecFlags(readRunSpecDocument(path), { out: v.out as string | undefined, auth: v.auth as string | undefined, ownTarget: !!v['i-own-this-target'] || !!v['attest-ownership'] });
  const loc = specFileLocation(path);
  return { ...flags, specLabels: labels, ...(loc ? { specFileLocation: loc } : {}) };
}

function parse(argv: string[], options: ParseArgsConfig['options']): { values: Values; positionals: string[] } {
  try {
    const r = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: r.values as Values, positionals: r.positionals };
  } catch (e) {
    throw new CliError(`${(e as Error).message.split('\n')[0]}`, EXIT_CODES.misconfig, 'run `agent-arena --help` for the options.');
  }
}

/** The commands a process started with ARENA_HOSTED may run (G-48). */
const KNOWN_COMMANDS = ['run', 'list-scenarios', 'replay', 'verify', 'serve-reference', 'target', 'version', '--version', '-v', 'help', '--help', '-h'];

/**
 * G-48 (threat-model-hosted §2.2, the in-process twin of the job template's command pin):
 * when ARENA_HOSTED is present in the environment, this process is the hosted runner and
 * accepts only `run --hosted`, `verify --hosted-seal` and `version`. Everything else (a
 * local run with its loopback-literal rule, serve-reference, replay, help, …) exits 3
 * before anything is parsed or read. Presence counts, whatever the value.
 */
export function assertHostedModeCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  if (env.ARENA_HOSTED === undefined) return;
  const [cmd, ...rest] = argv;
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') return;
  if (cmd === 'run' && rest.some(isHostedArg)) return;
  if (cmd === 'verify' && rest.includes('--hosted-seal')) return;
  const named = cmd === undefined ? 'no command' : KNOWN_COMMANDS.includes(cmd) ? `"${cmd}${cmd === 'run' ? '" without --hosted' : cmd === 'verify' ? '" without --hosted-seal' : '"'}` : 'an unknown command';
  throw new CliError(
    `hosted_mode_only: ARENA_HOSTED is set, so this process is the hosted runner; it runs only \`run --hosted\`, \`verify --hosted-seal\` and \`version\`, and refused ${named}. Nothing was read or sent.`,
    EXIT_CODES.misconfig,
    'run local evaluations outside the hosted runner image, or remove ARENA_HOSTED from the environment.',
  );
}

/**
 * Programmatic-only options of `main`/`cli` (the phase gates and tests). None of them is
 * reachable from argv or the environment; the installed CLI passes none.
 */
export interface CliOptions {
  /** Replaces the release's pinned manifest key set (hosted/pinned-keys.json); `[]` = a build that pins none. */
  pinnedManifestKeys?: readonly PinnedKey[];
}

export async function main(argv: string[], o: CliOptions = {}): Promise<number> {
  const pinned = o.pinnedManifestKeys ? { pinnedKeys: o.pinnedManifestKeys } : {};
  assertHostedModeCommand(argv);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    writeStdout(HELP);
    return cmd ? EXIT_CODES.ok : EXIT_CODES.misconfig;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    if (rest.includes('--json')) {
      const engine_builds = Object.fromEntries(ENGINE_BUILD_SCOPES.map((s) => [s, engineBuildHash(s)]));
      writeStdout(`${JSON.stringify({ version: VERSION, engine_builds })}\n`);
      return EXIT_CODES.ok;
    }
    writeStdout(`${VERSION}\n`);
    return EXIT_CODES.ok;
  }
  switch (cmd) {
    case 'run': {
      if (rest.some(isHostedArg)) {
        refuseCustomerRunFlags(rest);
        const { values: v } = parse(rest, HOSTED_RUN_OPTIONS);
        setOutputMode({ json: !!v.json });
        return (await runHostedCommand({ manifest: v.manifest as string | undefined, runSpec: v['run-spec'] as string | undefined, manifestKey: v['manifest-key'] as string | undefined, out: v.out as string | undefined }, pinned)).exitCode;
      }
      const { values: v } = parse(rest, RUN_OPTIONS);
      setOutputMode({ json: !!v.json, quiet: !!v.quiet });
      if (v.spec !== undefined) return (await runCommand(specRunFlags(v), rest)).exitCode;
      const flags: RunFlags = {
        scenario: v.scenario as string | undefined,
        seat: v.seat as string | undefined,
        position: v.position as string | undefined,
        fill: v.fill as string | undefined,
        tier: v.tier as string | undefined,
        seeds: (v.seeds ?? v.seed) as string | undefined,
        episodes: v.episodes as string | undefined,
        target: v.target as string | undefined,
        transport: v.transport as string | undefined,
        auth: v.auth as string | undefined,
        authHeader: v['auth-header'] as string | undefined,
        out: v.out as string | undefined,
        allowPrivate: !!v['allow-private'],
        allowLinkLocal: !!v['allow-link-local'],
        ownTarget: !!v['i-own-this-target'] || !!v['attest-ownership'],
        followRedirects: !!v['follow-redirects'],
        allowQuerySecret: !!v['allow-query-secret'],
        allowInsecureTransport: !!v['allow-insecure-transport'],
        maxRps: v['max-rps'] as string | undefined,
        failOn: v['fail-on'] as string | undefined,
        label: v.label as string | undefined,
        hosted: !!v.hosted,
        ci: v.ci as string | undefined,
        maxRetryAfter: v['max-retry-after'] as string | undefined,
        horizon: v.horizon as string | undefined,
        // Presence only: the value (a secret) is never read.
        secret: v.secret !== undefined,
      };
      return (await runCommand(flags, rest)).exitCode;
    }
    case 'list-scenarios': {
      const { values: v } = parse(rest, COMMON);
      setOutputMode({ json: !!v.json });
      return listScenariosCommand();
    }
    case 'replay': {
      const { values: v, positionals } = parse(rest, { ...COMMON, episode: { type: 'string' }, hash: { type: 'string' } });
      setOutputMode({ json: !!v.json });
      return replayCommand(positionals[0], { episode: v.episode as string | undefined, hash: v.hash as string | undefined });
    }
    case 'verify': {
      const { values: v, positionals } = parse(rest, { ...COMMON, key: { type: 'string' }, hosted: { type: 'boolean' }, 'hosted-seal': { type: 'boolean' }, 'manifest-key': { type: 'string' }, 'expect-manifest-digest': { type: 'string' }, result: { type: 'string' } });
      setOutputMode({ json: !!v.json });
      if (v['hosted-seal']) {
        if (v.hosted) throw new CliError('--hosted-seal already includes every --hosted check.', EXIT_CODES.misconfig, 'drop --hosted.');
        return verifyHostedSeal(positionals[0], { key: v.key as string | undefined, manifestKey: v['manifest-key'] as string | undefined, expectManifestDigest: v['expect-manifest-digest'] as string | undefined, ...(v.result !== undefined ? { result: v.result as string } : {}), ...pinned });
      }
      if (v.result !== undefined) throw new CliError('--result writes the result of a hosted bundle verification and needs --hosted-seal.', EXIT_CODES.misconfig, 'agent-arena verify --hosted-seal <bundle dir> --result <path> (for any other verify, redirect --json instead).');
      if (v['expect-manifest-digest'] !== undefined) throw new CliError('--expect-manifest-digest checks the run manifest of a hosted bundle and needs --hosted-seal.', EXIT_CODES.misconfig, 'agent-arena verify --hosted-seal <bundle dir> --expect-manifest-digest <sha256:…>');
      if (v['manifest-key'] !== undefined && !v.hosted) throw new CliError('--manifest-key checks the run manifest of a hosted report and needs --hosted or --hosted-seal.', EXIT_CODES.misconfig, 'add --hosted --key <report key>.');
      return verifyCommand(positionals[0], { key: v.key as string | undefined, hosted: !!v.hosted, manifestKey: v['manifest-key'] as string | undefined, ...pinned });
    }
    case 'serve-reference':
    case 'target': {
      const args = cmd === 'target' && rest[0] === 'reference' ? rest.slice(1) : rest;
      const { values: v } = parse(args, {
        ...COMMON,
        scenario: { type: 'string' },
        seat: { type: 'string' },
        policy: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'agent-seed': { type: 'string' },
        'allow-non-loopback': { type: 'boolean' },
        'allow-origin': { type: 'string', multiple: true },
        hosted: { type: 'boolean' },
        'verified-origin': { type: 'string' },
        'run-token-key': { type: 'string' },
        'run-token-issuer': { type: 'string' },
        'require-run-token': { type: 'boolean' },
      });
      setOutputMode({ json: !!v.json, quiet: !!v.quiet });
      await serveReferenceCommand({
        scenario: v.scenario as string | undefined,
        seat: v.seat as string | undefined,
        policy: v.policy as string | undefined,
        port: v.port as string | undefined,
        host: v.host as string | undefined,
        agentSeed: v['agent-seed'] as string | undefined,
        allowNonLoopback: !!v['allow-non-loopback'],
        allowOrigin: v['allow-origin'] as string[] | undefined,
        hosted: !!v.hosted,
        verifiedOrigin: v['verified-origin'] as string | undefined,
        runTokenKey: v['run-token-key'] as string | undefined,
        runTokenIssuer: v['run-token-issuer'] as string | undefined,
        requireRunToken: !!v['require-run-token'],
      });
      return -1; // keep serving
    }
    default:
      throw new CliError(`unknown command "${cmd.slice(0, 40)}".`, EXIT_CODES.misconfig, 'run `agent-arena --help`.');
  }
}

// G-31: the quote-aware diagnostic-flag check lives in hardening.ts (one copy); re-exported for callers of main.ts.
export { assertNoDiagnostics, diagnosticFlags } from './hardening.ts';

/**
 * Crash handler (C-4): redacted one-line message, exit 2, never a stack with locals.
 * G-58: after a hosted run, its log filter is still installed here (runHostedCommand never
 * uninstalls it), so a late error that names the verified origin is printed filtered.
 */
function installCrashHandlers(): void {
  const crash = (e: unknown) => {
    errorLine(`internal error: ${formatError(e)}`);
    process.exit(EXIT_CODES.error);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

export async function cli(argv: string[], o: CliOptions = {}): Promise<void> {
  installCrashHandlers();
  // `agent-arena replay … | head`: a closed stdout is not an error, and it is not a result either (G-60). Later
  // stdout writes are dropped and main() runs to its end; the process exits with main()'s code, never with a 0
  // made up because the reader left early. Any other stdout error also leaves stdout unusable.
  process.stdout.on('error', () => markStdoutClosed());
  try {
    assertNoDiagnostics();
    const code = await main(argv, o);
    if (code >= 0) process.exitCode = code;
  } catch (e) {
    if (e instanceof CliError) {
      errorLine(formatError(e));
      process.exitCode = e.exitCode;
    } else {
      errorLine(formatError(e));
      process.exitCode = EXIT_CODES.error;
    }
  }
}


