/**
 * `agent-arena evidence`: the Sixi Arena evidence report (docs/phase-9/EVIDENCE-REPORT-TEMPLATE.md,
 * contracts/schemas/evidence_report.schema.json) rendered from a sealed hosted run, in the seal step's
 * keyless evidence job (contracts 2.13.0: HOSTED-PROFILE §2.7 step 6, signing.md §5.3 step 4, errors.md §1d
 * `input_invalid` / `renderer_refused` / `evidence_not_written`; docs/phase-9/pr/PR7c-evidence.md). It wraps the one
 * renderer, `renderEvidenceReport` (arena-report), so the hosted rendering is this release's own bytes.
 *
 *   agent-arena evidence --hosted-seal <seal>/report.json --sarif <out>/report.sarif
 *       --verify-result <seal>/verify.json --packs <in>/packs --inputs <render>/input.json
 *       --key pinned | --key <report key: PEM, OKP JWK or JWKS> --out <render> [--json]
 *
 * Inputs, each checked before anything is rendered:
 *   --hosted-seal    the sealed report.json (run.mode hosted, a `signing` block). Its embedded signature must
 *                    verify (signing.md §5.2 E1, E2, E4, either signed form) with the report key set: `--key
 *                    pinned` = the report keys this release bundles (each inside its window at
 *                    signing.sealed_at), or `--key <file>`. It must validate against report.schema.json and hold
 *                    the hosted invariants.
 *   --sarif          report.sarif; byte-equal to the SARIF re-rendered from that report (HOSTED-PROFILE §2.7
 *                    step 3), so the SARIF digest the evidence names belongs to the sealed report.
 *   --verify-result  the verifier job's `--result` file (verify_result.schema.json); the seal precondition
 *                    (signing.md §5.1.1 rule 6) must hold: exitCode 0, status verified, sarif_equal, no seal or
 *                    mismatch problem. `status` and `unverified` are passed to the renderer.
 *   --packs          the mounted pack directory, opened as the runner opens it (hosted/packs.ts `loadPacks`: the
 *                    digest the signed report pins, the control-plane signature with the pinned manifest keys at
 *                    the run manifest's issued_at, schema, coverage rule). Read only when the report mounts a pack;
 *                    the run manifest is then read beside the SARIF and must digest to signing.run_manifest_digest.
 *   --inputs         the seal step's own facts (contracts `evidence_input.schema.json`, `wot:evidence_input:1`):
 *                    input_version "1.0", run_id (must be the report's), jwks_url, admission {reports_until,
 *                    audit_until, credential_destroyed_at?, requested_by?, incident_ref?}, crosscheck_record?,
 *                    corpus?. A cross-check record must validate against crosscheck_record.schema.json and verify
 *                    with the same report key set (§5.2 E4, at its finished_at).
 *                    Seal time, region, organisation, origin, image digest, engine build and key id come from the
 *                    signed report, never from this file.
 *
 * Outputs, in --out (an existing directory, not a symbolic link): evidence.md, and evidence.json when the
 * renderer returns one, as `JSON.stringify(json, null, 2) + "\n"` (the gate's form). `signature.files` names
 * report.json and report.sarif by the sha256 of the exact bytes read, never bundle-manifest.json. Both files are
 * created create-only (O_EXCL | O_NOFOLLOW): an existing file or link at either name is exit 3 before anything
 * is read.
 *
 * Exit: 0 evidence.md and evidence.json · 1 evidence.md only (the renderer withheld evidence.json; why on stderr)
 * · 2 an input fails verification or validation, or the renderer refused (nothing written) · 3 misuse (nothing
 * read or written). No network I/O: this module reads files and renders.
 */

import { closeSync, constants as fsConstants, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { EvidenceRenderError, renderEvidenceReport, signedBodyDigest, validateCrosscheckRecordSchema, validateReportSchema, type EvidenceRenderOptions, type PackManifest } from 'arena-report';
import { engineBuildFor } from '../build-info.ts';
import { CliError, misconfig } from '../errors.ts';
import type { HostedContextContract } from '../generated/contracts.ts';
import { CROSSCHECK_PAYLOAD_TYPE, refusalLine, REPORT_PAYLOAD_TYPE, SignatureRefusal, verifyEmbeddedSignature } from '../hosted/digest-statement.ts';
import { isPackScenarioId, loadPacks } from '../hosted/packs.ts';
import { PINNED_KEY_ARG, pinnedReportKeys, resolveManifestKeys } from '../hosted/pinned-keys.ts';
import { EVIDENCE_INPUT_MAX_BYTES, EVIDENCE_INPUT_VERSION, HOSTED_CONTEXT_MAX_BYTES, schemaErrors, validateEvidenceInput, validateHostedContext, validateVerifyResult, VERIFY_RESULT_MAX_BYTES } from '../hosted/schemas.ts';
import { hostedInvariantProblems, renderSarif } from '../hosted/seal.ts';
import { HostileFileError, parseHostileJson, readHostileBytes } from '../files.ts';
import { inertJson } from '../inert.ts';
import { keysForKid, loadPublicKeySet, type PinnedKey } from '../keys.ts';
import { redact } from '../redact.ts';
import { EXIT_CODES, type ExitCode, type Report } from '../report.ts';
import { errorLine, isJson, out, outJson } from '../ui.ts';
import { HOSTED_MANIFEST_FILE } from './run.ts';
import { MAX_REPORT_BYTES } from './verify.ts';

export const EVIDENCE_JSON = 'evidence.json';
export const EVIDENCE_MD = 'evidence.md';
const MAX_SARIF_BYTES = 64 * 1024 * 1024;
/** Refusal text quoted from the renderer or a validator is cut to this many characters (G-63 class). */
const QUOTE = 300;

export interface EvidenceFlags {
  hostedSeal?: string;
  sarif?: string;
  verifyResult?: string;
  packs?: string;
  inputs?: string;
  key?: string;
  out?: string;
  /** Tests only: the release's pinned report key set `--key pinned` selects (default hosted/pinned-keys.json `report`). */
  pinnedReportKeys?: readonly PinnedKey[];
  /** Tests only: the release's pinned manifest key set the packs are opened with (default hosted/pinned-keys.json `manifest`). */
  pinnedManifestKeys?: readonly PinnedKey[];
}

const USAGE =
  'agent-arena evidence --hosted-seal <report.json> --sarif <report.sarif> --verify-result <verify.json> --packs <dir> --inputs <input.json> --key pinned|<report key> --out <dir> [--json]';

const REQUIRED = [
  ['hostedSeal', '--hosted-seal'],
  ['sarif', '--sarif'],
  ['verifyResult', '--verify-result'],
  ['packs', '--packs'],
  ['inputs', '--inputs'],
  ['key', '--key'],
  ['out', '--out'],
] as const;

/** An input that fails verification or validation: exit 2, nothing written. */
export class Refused extends Error {}
const refuse = (msg: string): never => {
  throw new Refused(msg);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sha256 = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const cut = (s: string, n = QUOTE) => (s.length > n ? `${s.slice(0, n)}…` : s);

function readInput(path: string, max: number, what: string): { bytes: Buffer; value: unknown } {
  try {
    const bytes = readHostileBytes(path, max, what);
    return { bytes, value: parseHostileJson(bytes, what, path) };
  } catch (e) {
    return refuse(e instanceof HostileFileError ? e.message : `${what} cannot be read: ${path}`);
  }
}

/** --out: an existing directory, not a link, holding neither output yet. Returns its physical path. */
function checkOutDir(dir: string): string {
  const NEXT = 'pass --out an existing, empty render directory (the evidence job writes /run/arena/render); outputs are created, never replaced.';
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw misconfig('--out: the directory does not exist.', NEXT);
  }
  if (st.isSymbolicLink()) throw misconfig('--out is a symbolic link; refusing to write through it.', NEXT);
  if (!st.isDirectory()) throw misconfig('--out is not a directory.', NEXT);
  for (const name of [EVIDENCE_MD, EVIDENCE_JSON]) {
    let present = true;
    try {
      lstatSync(join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw misconfig(`--out: ${name} cannot be checked (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, NEXT);
      present = false;
    }
    if (present) throw misconfig(`--out already holds ${name} (a file or a link); the evidence is written create-only, never over another file.`, NEXT);
  }
  return realpathSync.native(dir);
}

/** Create-only write (O_EXCL | O_NOFOLLOW), synced; the directory must still be the one checked. Exported for tests. */
export function createFile(dir: string, physical: string, name: string, text: string): string {
  let now: string | undefined;
  try {
    now = realpathSync.native(dir);
  } catch {
    now = undefined;
  }
  if (now !== physical || lstatSync(dir).isSymbolicLink()) throw new Refused(`evidence_not_written: --out changed after it was checked (it is gone, or is now a link)`);
  const path = join(dir, name);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  } catch (e) {
    throw new Refused(`evidence_not_written: ${name} could not be created in --out (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    let n = 0;
    while (n < buf.length) n += writeSync(fd, buf, n, buf.length - n);
    fsyncSync(fd);
  } catch (e) {
    try {
      unlinkSync(path);
    } catch {
      /* the sealer refuses a partial file anyway */
    }
    throw new Refused(`evidence_not_written: ${name} could not be written in full (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  } finally {
    closeSync(fd);
  }
  return path;
}

/** Why the renderer returned no evidence.json, from the inputs it was given (the Markdown's status section says the same). */
function withheldBecause(opts: EvidenceRenderOptions, mountsPacks: boolean): string {
  const why: string[] = [];
  if (!opts.crosscheckRecord) why.push('--inputs carries no crosscheck_record (the signed cross-check record of the image digest)');
  if (mountsPacks && !opts.corpus) why.push('the run mounts a pack and --inputs carries no corpus snapshot');
  if (!why.length) why.push('a mounted pack was not loaded or a sealed input is missing (see evidence.md)');
  return why.join('; ');
}

/**
 * `agent-arena evidence …` (see the module comment). Misuse throws a CliError (exit 3) before anything is read;
 * an input or renderer refusal is exit 2 with one `refused:` line on stderr; nothing is written unless every
 * check passed.
 */
export function evidenceCommand(f: EvidenceFlags, extra: readonly string[] = []): ExitCode {
  if (extra.length) throw misconfig('evidence takes no positional argument.', `usage: ${USAGE}`);
  const missing = REQUIRED.filter(([k]) => typeof f[k] !== 'string' || !(f[k] as string).trim()).map(([, flag]) => flag);
  if (missing.length) throw misconfig(`evidence needs ${missing.join(', ')}.`, `usage: ${USAGE}`);
  // The report key set: before anything is read (a bad --key is misuse).
  const keys: PinnedKey[] = f.key === PINNED_KEY_ARG ? [...(f.pinnedReportKeys ?? pinnedReportKeys())] : loadPublicKeySet(f.key!, '--key');
  if (!keys.length) throw misconfig('--key pinned: this release pins no report key.', 'pass the Sixi report key with --key <OKP JWK|JWKS|PEM>, or use a release that bundles it.');
  const outDir = resolve(f.out!);
  const physicalOut = checkOutDir(outDir);

  let rendered: { markdown: string; json: unknown } | undefined;
  let opts: EvidenceRenderOptions = {};
  let mountsPacks = false;
  let digests: { report: string; sarif: string } | undefined;
  try {
    /* -------- the sealed report -------- */
    const reportPath = resolve(f.hostedSeal!);
    const { bytes: reportBytes, value: raw } = readInput(reportPath, MAX_REPORT_BYTES, 'sealed report');
    if (!isObj(raw) || !isObj(raw.run) || !Array.isArray(raw.episodes)) refuse('the sealed report is not a report (no run object or episodes array)');
    const r = raw as Record<string, unknown> & { run: Record<string, unknown> };
    if (r.run.mode !== 'hosted' || !isObj(r.run.hosted)) refuse('the sealed report is not a hosted report (run.mode hosted, run.hosted); evidence is rendered for sealed hosted runs only');
    if (!isObj(r.signing)) refuse('the report carries no signing block: evidence is rendered after the seal step signed report.json (signing.md §5.3)');
    try {
      verifyEmbeddedSignature(raw, REPORT_PAYLOAD_TYPE, keys, 'report.json');
    } catch (e) {
      if (e instanceof SignatureRefusal) refuse(refusalLine(e));
      throw e;
    }
    if (!validateReportSchema(raw)) refuse(`the sealed report fails report.schema.json: ${schemaErrors(validateReportSchema.errors)}`);
    const report = raw as unknown as Report;
    const invariants = hostedInvariantProblems(report);
    if (invariants.length) refuse(`hosted_invariant: ${invariants.join('; ')}`);

    /* -------- the SARIF: the one rendered from this report -------- */
    const sarifPath = resolve(f.sarif!);
    let sarifBytes: Buffer;
    try {
      sarifBytes = readHostileBytes(sarifPath, MAX_SARIF_BYTES, 'SARIF log');
    } catch (e) {
      return refuse(e instanceof HostileFileError ? e.message : `the SARIF log cannot be read: ${sarifPath}`);
    }
    if (!sarifBytes.equals(Buffer.from(renderSarif(report), 'utf8'))) refuse('--sarif is not byte-equal to the SARIF re-rendered from the sealed report (HOSTED-PROFILE §2.7 step 3); it is not this run\'s report.sarif');

    /* -------- the verifier's result: the seal precondition -------- */
    const { value: vr } = readInput(resolve(f.verifyResult!), VERIFY_RESULT_MAX_BYTES, 'verify result');
    if (!validateVerifyResult(vr)) refuse(`--verify-result fails verify_result.schema.json: ${schemaErrors(validateVerifyResult.errors)}`);
    const v = vr as { ok: boolean; status: string; exitCode: number; unverified?: unknown; hosted_seal?: { sarif_equal: boolean; seal: string[]; mismatch: string[] } };
    if (!(v.ok && v.status === 'verified' && v.exitCode === 0 && v.hosted_seal?.sarif_equal === true && v.hosted_seal.seal.length === 0 && v.hosted_seal.mismatch.length === 0)) {
      refuse('--verify-result does not state the seal precondition (signing.md §5.1.1 rule 6: exitCode 0, status verified, hosted_seal.sarif_equal, no seal or mismatch problem); no evidence is issued over an unverified report');
    }
    const unverified = Array.isArray(v.unverified) ? v.unverified.filter((x): x is string => typeof x === 'string') : [];

    /* -------- the seal step's facts -------- */
    const { value: inp } = readInput(resolve(f.inputs!), EVIDENCE_INPUT_MAX_BYTES, 'evidence inputs');
    if (!validateEvidenceInput(inp)) refuse(`--inputs is not an evidence input document (evidence_input.schema.json, input_version ${EVIDENCE_INPUT_VERSION}): ${schemaErrors(validateEvidenceInput.errors)}`);
    const input = inp as { run_id: string; jwks_url: string; crosscheck_record?: Record<string, unknown>; admission: NonNullable<EvidenceRenderOptions['admission']>; corpus?: EvidenceRenderOptions['corpus'] };
    if (input.run_id !== r.run.run_id) refuse('--inputs names another run_id than the sealed report');
    // evidence_input.schema.json leaves the record's content to its own schema (no cross-file reference).
    if (input.crosscheck_record && !validateCrosscheckRecordSchema(input.crosscheck_record)) {
      refuse(`--inputs crosscheck_record fails crosscheck_record.schema.json: ${schemaErrors(validateCrosscheckRecordSchema.errors)}`);
    }

    /* -------- the packs the signed report mounted -------- */
    const hosted = r.run.hosted as { packs?: HostedContextContract['packs'] };
    const entries = hosted.packs ?? [];
    mountsPacks = entries.length > 0;
    let packManifests: PackManifest[] = [];
    if (mountsPacks) {
      const manifestKeys = f.pinnedManifestKeys ? [...f.pinnedManifestKeys] : resolveManifestKeys(undefined, { required: false });
      if (!manifestKeys.length) refuse('the run mounts a pack, and this release pins no control-plane manifest key to open it with');
      const mPath = join(dirname(sarifPath), HOSTED_MANIFEST_FILE);
      const { value: m } = readInput(mPath, HOSTED_CONTEXT_MAX_BYTES, 'run manifest');
      if (!validateHostedContext(m)) refuse(`${HOSTED_MANIFEST_FILE} beside --sarif is not a run manifest: ${schemaErrors(validateHostedContext.errors)}`);
      let digest = '';
      try {
        digest = signedBodyDigest(m as HostedContextContract);
      } catch {
        /* refused below */
      }
      if (digest !== (r.signing as { run_manifest_digest?: unknown }).run_manifest_digest) refuse(`${HOSTED_MANIFEST_FILE} beside --sarif is not the run manifest the sealed report commits to (signing.run_manifest_digest)`);
      const scenario = String((r.scenario as { scenario_id?: unknown } | undefined)?.scenario_id ?? '');
      try {
        packManifests = loadPacks(entries, resolve(f.packs!), manifestKeys, (s) => engineBuildFor(s).digest, isPackScenarioId(scenario) ? null : scenario, Date.parse((m as HostedContextContract).issued_at)).map(
          (p) => p.manifest as unknown as PackManifest,
        );
      } catch (e) {
        if (e instanceof CliError) refuse(`--packs: ${cut(e.message)}`);
        throw e;
      }
    }

    /* -------- the cross-check record: signed by a report key -------- */
    let crosscheckKey: EvidenceRenderOptions['crosscheckKey'];
    if (input.crosscheck_record) {
      let kid: string;
      try {
        kid = verifyEmbeddedSignature(input.crosscheck_record, CROSSCHECK_PAYLOAD_TYPE, keys, 'cross-check record').kid;
      } catch (e) {
        if (e instanceof SignatureRefusal) return refuse(refusalLine(e));
        throw e;
      }
      crosscheckKey = keysForKid(keys, kid, Date.parse(String(input.crosscheck_record.finished_at))).keys[0]!.key;
    }

    digests = { report: sha256(reportBytes), sarif: sha256(sarifBytes) };
    const runId = String(r.run.run_id);
    opts = {
      verifyResult: { status: 'verified', unverified },
      bundle: {
        jwks_url: input.jwks_url,
        files: [
          { path: 'report.json', run_id: runId, sha256: digests.report },
          { path: 'report.sarif', run_id: runId, sha256: digests.sarif },
        ],
      },
      admission: input.admission,
      ...(input.corpus ? { corpus: input.corpus } : {}),
      ...(packManifests.length ? { packManifests } : {}),
      ...(input.crosscheck_record ? { crosscheckRecord: input.crosscheck_record as unknown as EvidenceRenderOptions['crosscheckRecord'], crosscheckKey } : {}),
    };

    /* -------- render -------- */
    try {
      rendered = renderEvidenceReport(report, opts);
    } catch (e) {
      if (e instanceof EvidenceRenderError) refuse(`renderer_refused: ${e.code}: ${cut(String(e.message))}`);
      throw e;
    }
    // The files are this CLI's output: no active code point (G-36) and nothing the redactor would change. The JSON
    // form escapes active code points losslessly; Markdown cannot, so it is refused instead of rewritten.
    if (inertJson(rendered.markdown) !== rendered.markdown || redact(rendered.markdown) !== rendered.markdown) refuse('renderer_refused: output: evidence.md holds an active code point or credential-shaped text');
  } catch (e) {
    if (e instanceof Refused) return refused(e.message);
    throw e;
  }

  /* -------- write (create-only): evidence.md, then evidence.json -------- */
  const written: string[] = [];
  try {
    written.push(createFile(outDir, physicalOut, EVIDENCE_MD, rendered!.markdown));
    if (rendered!.json) written.push(createFile(outDir, physicalOut, EVIDENCE_JSON, inertJson(redact(`${JSON.stringify(rendered!.json, null, 2)}\n`))));
  } catch (e) {
    for (const p of written) {
      try {
        unlinkSync(p);
      } catch {
        /* best effort: the sealer checks what it reads */
      }
    }
    if (e instanceof Refused) return refused(e.message);
    throw e;
  }
  const exitCode: ExitCode = rendered!.json ? EXIT_CODES.ok : EXIT_CODES.findings;
  const withheld = rendered!.json ? undefined : withheldBecause(opts, mountsPacks);
  if (withheld) errorLine(`evidence.json withheld: ${withheld}`);
  if (isJson()) {
    outJson({ ok: exitCode === EXIT_CODES.ok, status: rendered!.json ? 'rendered' : 'markdown_only', exitCode, files: written.map((p) => p.slice(outDir.length + 1)), signature_files: { 'report.json': digests!.report, 'report.sarif': digests!.sarif }, ...(withheld ? { withheld } : {}) });
  } else {
    out(`evidence: wrote ${written.join(' and ')}`);
    out(`names report.json ${digests!.report} and report.sarif ${digests!.sarif}`);
    out(`${rendered!.json ? 'rendered' : 'markdown_only'}: evidence report (exit ${exitCode})`);
  }
  return exitCode;
}

function refused(msg: string): ExitCode {
  const line = msg.startsWith('evidence_not_written:') || msg.startsWith('renderer_refused:') || msg.startsWith('signature_invalid:') ? msg : `input_invalid: ${msg}`;
  errorLine(`refused: ${cut(line, 2000)}`);
  if (isJson()) outJson({ ok: false, status: 'refused', exitCode: EXIT_CODES.error, errors: [cut(line, 2000)] });
  else out(`refused: nothing written (exit ${EXIT_CODES.error})`);
  return EXIT_CODES.error;
}
