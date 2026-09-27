/**
 * Scenario packs in the runner (contracts 2.2.0 K5/K9: RESERVED.md `sx_`,
 * pack_manifest.schema.json; HOSTED-PROFILE §5).
 *
 * The open core ships and loads ONLY its built-in free scenarios. An `sx_`
 * scenario id is refused with `scenario_pack_unavailable` (exit 3) before any
 * I/O, unless the run is hosted AND the signed run manifest lists a pack that
 * is mounted under ARENA_PACKS_DIR, whose signature verifies with the pinned
 * control-plane key and whose `engine.builds` includes the running build. The
 * CLI never fetches, downloads or looks up a pack.
 *
 * Mounted layout (one directory per manifest pack entry):
 *
 *   $ARENA_PACKS_DIR/<pack id>/pack.dsse.json      DSSE envelope, payloadType PACK_PAYLOAD_TYPE,
 *                                                  payload = base64 of the pack manifest JSON bytes,
 *                                                  signatures[].keyid = the control-plane kid
 *   $ARENA_PACKS_DIR/<pack id>/<data.ref>          variant parameter files, pinned by data.digest
 *
 * The pack digest (manifest `packs[].digest`, "sha256 of the signed pack bundle")
 * is sha256 of the exact bytes of `pack.dsse.json`.
 *
 * A `scenario_variant` registers each `sx_` id as base scenario + parameters.
 * The parameter surface (file format `arena-pack-variant/1`, contracts 2.6.0
 * `pack_variant.schema.json`, validated against it) is deliberately small and
 * data-only:
 *
 *   { "format": "arena-pack-variant/1",
 *     "tier": "edge" | "core" | "frontier" | "extended",  optional: the ONE tier the variant always runs at
 *     "seeds": [uint32, …],                          optional: the variant's fixed seeds (1..1000)
 *     "oracle_thresholds": { "<base>.<oracle>": 0..1 } optional: pass thresholds of the base's oracles }
 *
 * The base scenario is NOT in the file (it is the signed manifest's
 * `scenarios[].base`): a `base` member is refused, as is a set of per-tier
 * overrides (`tier` is one pinned value).
 *
 * Nothing here can add an oracle, rename a rule id, change a tier's frozen
 * numbers, or carry code.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash, verify as edVerify } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { oracleCatalog, pae, type ReportScenarioId } from 'arena-report';
import { SCENARIO_IDS } from 'arena-scenarios';
import { misconfig, type CliError } from '../errors.ts';
import type { HostedContextContract, PackManifestContract } from '../generated/contracts.ts';
import { keyWindowProblem, type PinnedKey } from '../keys.ts';
import { PACK_MANIFEST_MAX_BYTES, schemaErrors, validatePackManifest, validatePackVariant } from './schemas.ts';

/** DSSE payload type of a signed pack manifest (contracts 2.6.0 signing.md §11, §2 table). */
export const PACK_PAYLOAD_TYPE = 'application/vnd.sixi.arena-pack+json';
export const PACK_ENVELOPE_FILE = 'pack.dsse.json';
export const VARIANT_FORMAT = 'arena-pack-variant/1';
export const MAX_VARIANT_BYTES = 64 * 1024;

export const PACK_UNAVAILABLE = 'scenario_pack_unavailable';
export const PACK_ENGINE_MISMATCH = 'pack_engine_mismatch';

export const packUnavailable = (message: string, next?: string): CliError =>
  misconfig(`${PACK_UNAVAILABLE}: ${message} Nothing was sent.`, next ?? 'Run it hosted with sixi-ai/scan-action (profile: arena), or list the open scenarios with: agent-arena list-scenarios');

/** The open CLI's refusal of a pack scenario id (RESERVED.md, HOSTED-PROFILE §5.6). */
export function openCliPackRefusal(scenarioId: string): CliError {
  return packUnavailable(`${scenarioId.slice(0, 40)} is a Sixi Arena pack scenario; this CLI ships the open scenarios only.`);
}

export const isPackScenarioId = (id: string): boolean => id.startsWith('sx_');

export type TierId = 'edge' | 'core' | 'frontier' | 'extended';

export interface VariantParams {
  tier?: TierId;
  seeds?: number[];
  oracle_thresholds?: Record<string, number>;
}

export interface PackVariant {
  id: string;
  packId: string;
  base: string;
  tiers: TierId[];
  seatModes: string[];
  params: VariantParams;
}

export interface LoadedPack {
  id: string;
  version: string;
  digest: string;
  manifest: PackManifestContract;
  /** `sx_` variants this pack registers (scenario_variant kind), by id. */
  variants: Map<string, PackVariant>;
}

function readCapped(path: string, cap: number, what: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    throw packUnavailable(`${what} cannot be opened (${code === 'ELOOP' ? 'a symbolic link' : code}).`, 'mount the pack bundle the control plane fetched under ARENA_PACKS_DIR/<pack id>/.');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw packUnavailable(`${what} is not a regular file.`);
    if (st.size > cap) throw packUnavailable(`${what} is ${st.size} bytes (cap ${cap}).`);
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > cap) throw packUnavailable(`${what} grew past its cap while it was read.`);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const sha256 = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** G-52: the one canonical spelling of standard base64 (padded, no dangling character, unused bits zero). */
const isCanonicalB64 = (s: string): boolean => B64.test(s) && Buffer.from(s, 'base64').toString('base64') === s;

/**
 * Verify a DSSE envelope over a pack manifest with the pinned control-plane keys; returns the payload bytes.
 * signing.md §11.1 / §11.3 step 5 and (2.11.0) §3.3 rule 3 "Packs": 1 to 4 signatures, and the envelope is
 * accepted when one of them verifies with the pinned key its keyid names (or a pinned key without a kid) whose
 * window covers `at`, the `issued_at` of the verified run manifest that lists the pack (epoch ms). A signature
 * by a key outside its window does not count; a missing `at` is outside every window (a key without a window,
 * a test key, has no limit).
 */
export function openPackEnvelope(envelope: Buffer, keys: readonly PinnedKey[], packId: string, at: number = Number.NaN): Buffer {
  let env: unknown;
  try {
    env = JSON.parse(envelope.toString('utf8'));
  } catch {
    throw packUnavailable(`pack ${packId}: ${PACK_ENVELOPE_FILE} is not JSON.`);
  }
  if (!isObj(env) || env.payloadType !== PACK_PAYLOAD_TYPE || typeof env.payload !== 'string' || !isCanonicalB64(env.payload) || !Array.isArray(env.signatures) || env.signatures.length < 1 || env.signatures.length > 4) {
    throw packUnavailable(`pack ${packId}: ${PACK_ENVELOPE_FILE} is not a DSSE envelope of type ${PACK_PAYLOAD_TYPE} with 1 to 4 signatures.`);
  }
  const payload = Buffer.from(env.payload, 'base64');
  const message = pae(PACK_PAYLOAD_TYPE, payload);
  const outsideWindow: string[] = [];
  const ok = (env.signatures as unknown[]).some((s) => {
    if (!isObj(s) || typeof s.sig !== 'string' || !isCanonicalB64(s.sig)) return false;
    const kid = typeof s.keyid === 'string' ? s.keyid : undefined;
    const sig = Buffer.from(s.sig, 'base64');
    if (sig.length !== 64) return false;
    const named = keys.filter((k) => k.kid === undefined || k.kid === kid);
    const verifying = named.filter((k) => edVerify(null, message, k.key, sig));
    if (!verifying.length) return false;
    if (verifying.some((k) => keyWindowProblem(k, at) === null)) return true;
    outsideWindow.push(`${String(kid).slice(0, 64)}: ${keyWindowProblem(verifying[0]!, at)}`);
    return false;
  });
  if (ok) return payload;
  if (outsideWindow.length) {
    throw packUnavailable(
      `pack ${packId}: no signature is by a pinned control-plane key whose window covers the run manifest's issued_at (${outsideWindow.slice(0, 4).join('; ')}).`,
      'the pack store must add a signature with a key this release pins for the run\'s issued_at (a new envelope, pinned by the next manifest), signing.md §3.3 rule 3.',
    );
  }
  throw packUnavailable(`pack ${packId}: the pack signature does not verify against the pinned control-plane key.`, 'mount the pack bundle exactly as the pack store signed it.');
}

/**
 * Contracts 2.9.0 load rule (signing.md §11.3 step 6a): a pack's `coverage.clauses` must contain every clause id
 * cited by `oracles[].clauses` or `rules[].clauses` (coverage ⊇ clause map ∪ rule clauses). The not-assessed
 * enumeration walks `coverage.clauses`, so a mapped clause missing there would never be listed as not assessed.
 * The reverse is allowed (a coverage clause no oracle maps). Returns the cited clauses missing from coverage, in
 * citation order (oracles first, then rules), each with where it was cited; empty when the pack satisfies the rule.
 */
export function packCoverageMissing(pm: {
  coverage?: { clauses: readonly string[] };
  oracles?: readonly { oracle_id: string; clauses?: readonly string[] }[];
  rules?: readonly { id: string; clauses?: readonly string[] }[];
}): { clause: string; citedBy: string }[] {
  const cov = new Set(pm.coverage?.clauses ?? []);
  const out: { clause: string; citedBy: string }[] = [];
  const seen = new Set<string>();
  const cite = (clauses: readonly string[] | undefined, citedBy: string) => {
    for (const c of clauses ?? []) {
      if (cov.has(c) || seen.has(c)) continue;
      seen.add(c);
      out.push({ clause: c, citedBy });
    }
  };
  for (const o of pm.oracles ?? []) cite(o.clauses, `the clause map entry for ${o.oracle_id}`);
  for (const r of pm.rules ?? []) cite(r.clauses, `rule ${r.id}`);
  return out;
}

const TIERS: readonly TierId[] = ['edge', 'core', 'frontier', 'extended'];

/** Parse and bound a variant parameter file (`arena-pack-variant/1`) against its base scenario. */
export function parseVariantParams(raw: Buffer, base: string, where: string): VariantParams {
  let v: unknown;
  try {
    v = JSON.parse(raw.toString('utf8'));
  } catch {
    throw packUnavailable(`${where} is not JSON.`);
  }
  if (!isObj(v) || v.format !== VARIANT_FORMAT) throw packUnavailable(`${where} is not an ${VARIANT_FORMAT} parameter file.`);
  // contracts 2.6.0: the base scenario comes from the signed manifest entry, never from the data file.
  if ('base' in v) throw packUnavailable(`${where} has a base member; the base scenario is the signed pack manifest's scenarios[].base, never the variant file's (outside the variant parameter surface).`);
  const extra = Object.keys(v).filter((k) => !['format', 'tier', 'seeds', 'oracle_thresholds'].includes(k));
  if (extra.length) throw packUnavailable(`${where} has members outside the variant parameter surface (${extra.slice(0, 4).map((k) => k.slice(0, 32)).join(', ')}).`);
  const out: VariantParams = {};
  if (v.tier !== undefined) {
    if (!TIERS.includes(v.tier as TierId)) throw packUnavailable(`${where}: tier must be edge, core, frontier or extended.`);
    out.tier = v.tier as TierId;
  }
  if (v.seeds !== undefined) {
    const s = v.seeds;
    if (!Array.isArray(s) || s.length < 1 || s.length > 1000 || !s.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)) throw packUnavailable(`${where}: seeds must be 1..1000 uint32.`);
    out.seeds = [...(s as number[])];
  }
  if (v.oracle_thresholds !== undefined) {
    const t = v.oracle_thresholds;
    if (!isObj(t) || Object.keys(t).length > 64) throw packUnavailable(`${where}: oracle_thresholds must be an object of at most 64 entries.`);
    const known = new Set(oracleCatalog(base as ReportScenarioId).map((o) => o.oracle_id));
    const th: Record<string, number> = {};
    for (const [k, x] of Object.entries(t)) {
      if (!known.has(k)) throw packUnavailable(`${where}: oracle_thresholds names ${k.slice(0, 60)}, which is not an oracle of ${base} (a pack never adds an oracle).`);
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) throw packUnavailable(`${where}: the threshold of ${k} must be a number 0..1.`);
      th[k] = x;
    }
    out.oracle_thresholds = th;
  }
  // Backstop after the specific refusals above: exactly contracts 2.6.0 pack_variant.schema.json.
  if (!validatePackVariant(v)) throw packUnavailable(`${where} fails pack_variant.schema.json: ${schemaErrors(validatePackVariant.errors)}.`);
  return out;
}

/** Resolve `<dir>/<ref>` and refuse anything outside `<dir>` (the schema already bans `..` and a leading `/`). */
function inside(dir: string, ref: string): string {
  const p = resolve(dir, ref);
  if (!p.startsWith(resolve(dir) + sep)) throw packUnavailable(`a pack data ref leaves its pack directory.`);
  return p;
}

/**
 * Load every pack the manifest lists, from `packsDir`. `engineBuild(scenario)` is
 * the running build for a scenario's scope; each pack's `engine.builds` must
 * include the build of `runScenario` (the open scenario the run plays) and the
 * build of every variant base it declares. Refusals: `scenario_pack_unavailable` (missing, unsigned,
 * digest or schema mismatch, coverage rule §11.3 step 6a), `pack_engine_mismatch` (build not in range).
 */
export function loadPacks(
  entries: HostedContextContract['packs'],
  packsDir: string | undefined,
  keys: readonly PinnedKey[],
  engineBuildOf: (scenario: string) => string,
  /** The open scenario the run plays (its build must be in every pack's range); null = an `sx_` run, checked per variant base. */
  runScenario: string | null,
  /** (2.11.0, signing.md §3.3 rule 3) The verified run manifest's `issued_at`, epoch ms: each pack key's window must cover it. */
  issuedAt: number = Number.NaN,
): LoadedPack[] {
  if (!entries.length) return [];
  if (!packsDir) throw packUnavailable(`the run manifest lists ${entries.length} pack(s) (${entries.map((p) => p.id).join(', ')}), but ARENA_PACKS_DIR is not set.`, 'the hosted job spec must mount the fetched packs read-only and set ARENA_PACKS_DIR.');
  const out: LoadedPack[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) throw packUnavailable(`the run manifest lists pack ${e.id} twice.`);
    seen.add(e.id);
    const dir = join(resolve(packsDir), e.id);
    const envBytes = readCapped(join(dir, PACK_ENVELOPE_FILE), PACK_MANIFEST_MAX_BYTES * 2, `pack ${e.id}/${PACK_ENVELOPE_FILE}`);
    const digest = sha256(envBytes);
    if (digest !== e.digest) throw packUnavailable(`pack ${e.id}: the mounted bundle digests to ${digest}, the run manifest pins ${e.digest}.`, 'mount the exact pack bundle the control plane admitted.');
    const payload = openPackEnvelope(envBytes, keys, e.id, issuedAt);
    if (payload.length > PACK_MANIFEST_MAX_BYTES) throw packUnavailable(`pack ${e.id}: the pack manifest is over ${PACK_MANIFEST_MAX_BYTES} bytes.`);
    let doc: unknown;
    try {
      doc = JSON.parse(payload.toString('utf8'));
    } catch {
      throw packUnavailable(`pack ${e.id}: the signed pack manifest is not JSON.`);
    }
    if (!validatePackManifest(doc)) throw packUnavailable(`pack ${e.id}: the pack manifest fails pack_manifest.schema.json: ${schemaErrors(validatePackManifest.errors)}.`);
    const pm = doc as PackManifestContract;
    const uncovered = packCoverageMissing(pm);
    if (uncovered.length) {
      const [first] = uncovered;
      const more = uncovered.length > 1 ? ` (and ${uncovered.length - 1} more: ${uncovered.slice(1, 4).map((u) => u.clause.slice(0, 60)).join(', ')}${uncovered.length > 4 ? ', …' : ''})` : '';
      throw packUnavailable(
        `pack ${e.id}: its coverage.clauses omits ${first.clause.slice(0, 60)}, which ${first.citedBy.slice(0, 120)} cites${more}; a pack's coverage must list every clause its clause map or rules cite (signing.md §11.3 step 6a).`,
        'the pack store must re-publish the pack with the missing clause(s) in coverage.clauses; the runner never loads a pack that would under-report what was not assessed.',
      );
    }
    if (pm.id !== e.id || pm.version !== e.version) throw packUnavailable(`pack ${e.id}: the signed manifest is ${pm.id}@${pm.version}, the run manifest pins ${e.id}@${e.version}.`);
    const engineCheck = (scenario: string) => {
      const build = engineBuildOf(scenario);
      if (!pm.engine.builds.includes(build)) {
        throw misconfig(`${PACK_ENGINE_MISMATCH}: Pack ${pm.id}@${pm.version} was not validated on the current engine build (${build}). Nothing was sent.`, 'retry after the pack update, or promote the image whose engine build the pack lists.');
      }
    };
    if (runScenario !== null) engineCheck(runScenario);
    const variants = new Map<string, PackVariant>();
    for (const sc of pm.scenarios ?? []) {
      if (!isPackScenarioId(sc.id)) continue; // an overlay (open id + peers), not a variant
      const base = sc.base!;
      if (!(SCENARIO_IDS as readonly string[]).includes(base)) throw packUnavailable(`pack ${e.id}: variant ${sc.id} names base ${base.slice(0, 40)}, which is not an open scenario of this build.`);
      engineCheck(base);
      const data = sc.data!;
      const raw = readCapped(inside(dir, data.ref), MAX_VARIANT_BYTES, `pack ${e.id} variant data ${data.ref.slice(0, 80)}`);
      if (sha256(raw) !== data.digest) throw packUnavailable(`pack ${e.id}: variant data ${data.ref.slice(0, 80)} does not match its pinned digest.`);
      const params = parseVariantParams(raw, base, `pack ${e.id} variant ${sc.id}`);
      if (params.tier && !sc.tiers.includes(params.tier)) throw packUnavailable(`pack ${e.id}: variant ${sc.id} pins tier ${params.tier}, which its tiers[] does not list.`);
      if (variants.has(sc.id)) throw packUnavailable(`pack ${e.id}: variant ${sc.id} is declared twice.`);
      variants.set(sc.id, { id: sc.id, packId: pm.id, base, tiers: [...sc.tiers], seatModes: [...sc.seat_modes], params });
    }
    out.push({ id: pm.id, version: pm.version, digest, manifest: pm, variants });
  }
  return out;
}

/** The variant a RunSpec `sx_` id resolves to, across the loaded packs, or a `scenario_pack_unavailable` refusal. */
export function resolveVariant(scenarioId: string, packs: readonly LoadedPack[]): PackVariant {
  const hits = packs.flatMap((p) => (p.variants.has(scenarioId) ? [p.variants.get(scenarioId)!] : []));
  if (hits.length === 0) {
    throw packUnavailable(
      packs.length
        ? `${scenarioId.slice(0, 40)} is not a variant of any pack mounted for this run (${packs.map((p) => `${p.id}@${p.version}`).join(', ')}).`
        : `${scenarioId.slice(0, 40)} is a Sixi Arena pack scenario and the run manifest mounts no pack.`,
      'the control plane must list the entitled pack in the run manifest and mount it under ARENA_PACKS_DIR.',
    );
  }
  if (hits.length > 1) throw packUnavailable(`${scenarioId.slice(0, 40)} is declared by more than one mounted pack (${hits.map((h) => h.packId).join(', ')}).`);
  return hits[0];
}

/**
 * A resolved variant against the RunSpec that names it: the pinned tier and seeds
 * must be what the RunSpec asks for (the control plane expands them; a difference
 * means the RunSpec and the pack disagree), and the seat mode must be allowed.
 */
export function checkVariantAgainstRunSpec(v: PackVariant, spec: { budget_tier: string; seeds: number[]; seat?: { mode?: string } }): void {
  const tier = spec.budget_tier as TierId;
  if (!v.tiers.includes(tier)) throw packUnavailable(`${v.id} runs at ${v.tiers.join('|')}, not ${tier}.`);
  if (v.params.tier && v.params.tier !== tier) throw packUnavailable(`${v.id} pins tier ${v.params.tier}; the RunSpec asks for ${tier}.`);
  if (v.params.seeds && JSON.stringify(v.params.seeds) !== JSON.stringify(spec.seeds)) throw packUnavailable(`${v.id} pins its seeds; the RunSpec's seeds differ.`);
  const mode = spec.seat?.mode;
  if (mode && !v.seatModes.includes(mode)) throw packUnavailable(`${v.id} allows seat modes ${v.seatModes.join('|')}, not ${mode}.`);
}
