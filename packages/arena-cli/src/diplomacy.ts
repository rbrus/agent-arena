/**
 * `diplomacy_standard` in the CLI (Phase 8 C2g): flag parsing for power
 * seating, the local signature attestation, the edge redaction of press text
 * (G-40), the recorded-inputs commitment of the target power and the
 * episode-validity rule. Pure (no I/O).
 *
 *   --seat <power>|auto     the power the target plays (default auto = the
 *                           scenario's seeded seat shuffle, a function of the seed)
 *   --fill <fill>           house | robust | credulous | injector-table | table:<pair>
 *   --horizon <year>        1901..1908, default 1906 (the RunSpec default; always
 *                           passed to the adapter explicitly, never the engine's 1908)
 *   --secret <64 hex>       hosted only (the control plane draws, commits and
 *                           discloses it); refused in local runs
 *
 * RunSpec (contracts 2.4.0): `seat: {mode: power, position}`, `diplomacy:
 * {profile, horizon_year, fill}` (profile = the fill's derived profile,
 * security or clean; `table` is the multi-target profile and needs `seats[]`,
 * which a single-target CLI run never writes). DEPRECATED: the fill is also
 * written as the label `arena.diplomacy_fill` for one more version (the only
 * place a pre-2.4.0 verifier looks); it goes in the next release. `verify`
 * reads `diplomacy.fill` first, the label only when the field is absent, and
 * the profile mapping when neither is present (verify-diplomacy.ts
 * `dipSpecFill`).
 */

import {
  computeDipVerdicts,
  DIP_DEFAULT_HORIZON,
  DIP_FILLS,
  DIP_GOLDEN_TABLES,
  DIP_MAX_HORIZON,
  DIP_POWERS,
  dipProfileOf,
  isDiplomacyRecord,
  resolveDipSeat,
  type DipFill,
  type EpisodeRecord,
  type PowerSeat,
  type TargetDriver,
} from 'arena-scenarios';
import { sanitizePressText } from 'wot-engine';
import { misconfig } from './errors.ts';
import { redact } from './redact.ts';

export const DIPLOMACY = 'diplomacy_standard';
/** @deprecated contracts 2.4.0 `diplomacy.fill` replaces it; still written for one version, read only when the field is absent. */
export const DIP_FILL_LABEL = 'arena.diplomacy_fill';
/**
 * G-40: how many credential-shaped spans of target press the run replaced at the
 * edge. No contract field holds it (`budget.press` is closed), so it is a RunSpec
 * label (free caller metadata, copied into the report), written only when > 0.
 */
export const DIP_PRESS_REDACTIONS_LABEL = 'arena.press_redactions';
const DIP_MIN_HORIZON = 1901;

export interface DipRunOptions {
  /** The requested seat: a power, or `auto` (resolved per seed by the scenario). */
  seat: PowerSeat | 'auto';
  fill: DipFill;
  horizonYear: number;
  /** '' in local mode (always, in this build). */
  secret: string;
}

export interface DipFlags {
  seat?: string;
  position?: string;
  fill?: string;
  horizon?: string;
  secret?: boolean;
}

/** `table:commitment` → `table:commitment_broken` (the first word of each pair is accepted as a shorthand). */
export function canonicalFill(v: string): DipFill | null {
  if ((DIP_FILLS as readonly string[]).includes(v)) return v as DipFill;
  if (!v.startsWith('table:')) return null;
  const short = v.slice('table:'.length);
  const hits = DIP_GOLDEN_TABLES.filter((t) => t.split('_')[0] === short);
  return hits.length === 1 ? (`table:${hits[0]}` as DipFill) : null;
}

/**
 * The fill when none is given: the contract default. A RunSpec with neither `diplomacy.fill` nor
 * `diplomacy.profile` is profile `security`, whose fill is `injector-table` (contracts 2.4.0;
 * verify-diplomacy.ts `fillOfSpec`). `--fill house` stays available (profile clean).
 */
export const DIP_DEFAULT_FILL: DipFill = 'injector-table';

const FILL_HELP = `house | robust | credulous | injector-table | table:<${DIP_GOLDEN_TABLES.join('|')}>`;

/** Validate the Diplomacy flags before any I/O. `seeds` lets `auto` seating be checked against a fill that pins powers. */
export function parseDipFlags(f: DipFlags, seeds: readonly number[]): DipRunOptions {
  if (f.secret) {
    throw misconfig(
      '--secret is the hosted episode secret: the Sixi control plane draws it, commits to it before the run and discloses it after the terminal; a local run plays with an empty secret (codewords are a function of seed and power).',
      'drop --secret (hosted runs arrive with --hosted in Phase 9).',
    );
  }
  if (f.position !== undefined) throw misconfig('--position does not apply to diplomacy_standard.', 'pick the power with --seat <power>|auto (e.g. --seat germany).');
  const rawSeat = f.seat ?? 'auto';
  if (rawSeat === 'power') throw misconfig('--seat takes the power itself for diplomacy_standard.', `use --seat auto or one of: ${DIP_POWERS.join(', ')}.`);
  if (rawSeat !== 'auto' && !(DIP_POWERS as readonly string[]).includes(rawSeat)) {
    throw misconfig(`--seat ${rawSeat.slice(0, 20)} is not a power: diplomacy_standard seats the target at one of the seven powers.`, `use --seat auto or one of: ${DIP_POWERS.join(', ')}.`);
  }
  const seat = rawSeat as PowerSeat | 'auto';
  const fill = f.fill === undefined ? DIP_DEFAULT_FILL : canonicalFill(f.fill);
  if (!fill) throw misconfig(`--fill ${String(f.fill).slice(0, 40)} is not a diplomacy_standard fill.`, `use one of: ${FILL_HELP}.`);
  const horizonYear = f.horizon === undefined ? DIP_DEFAULT_HORIZON : Number(f.horizon);
  if (!/^\d{4}$/.test(f.horizon ?? String(DIP_DEFAULT_HORIZON)) || !Number.isInteger(horizonYear) || horizonYear < DIP_MIN_HORIZON || horizonYear > DIP_MAX_HORIZON) {
    throw misconfig(`--horizon must be a year ${DIP_MIN_HORIZON}..${DIP_MAX_HORIZON} (the last game year played).`, `e.g. --horizon ${DIP_DEFAULT_HORIZON} (the default).`);
  }
  if (fill.startsWith('table:')) {
    // The engine golden tables pin england and france.
    const clash = seat === 'auto' ? seeds.filter((s) => ['england', 'france'].includes(resolveDipSeat(s, 'auto'))) : ['england', 'france'].includes(seat) ? seeds : [];
    if (clash.length) {
      throw misconfig(
        seat === 'auto'
          ? `--fill ${fill} pins england and france, but --seat auto seats the target at one of them for seed(s) ${clash.slice(0, 5).join(', ')}.`
          : `--fill ${fill} pins england and france; the target cannot sit at ${seat}.`,
        'seat the target elsewhere with --seat <power> (the engine goldens use --seat germany), or choose other seeds.',
      );
    }
  }
  return { seat, fill, horizonYear, secret: '' };
}

/** In-process Diplomacy references (`--target ref:*`); the Phase 7 names map onto the pair. */
export const DIP_IN_PROCESS: Readonly<Record<string, TargetDriver>> = {
  'ref:robust': 'ref:robust',
  'ref:credulous': 'ref:credulous',
  'ref:house': 'ref:house',
  'ref:coordinated': 'ref:robust',
  'ref:naive': 'ref:credulous',
};

/** The report profile the RunSpec records for a fill (contracts 2.1.0 `diplomacy.profile`). */
export const profileOfFill = (fill: DipFill): 'security' | 'clean' => dipProfileOf(fill);

// ------------------------------------------------------------------ signatures (local attestation)

/**
 * The CLI holds no passport key directory, so it cannot verify a detached JWS.
 * Like the arena's own transport (services/arena signatures.ts), it never hands
 * wire signature bytes to the engine: the literal `session` (the contract's
 * local-CLI mode) passes, and every other signature is replaced by this fixed,
 * schema-valid sentinel, which the engine refuses in place as
 * `signature_invalid` (the batch keeps its positions). The JWS bytes are not
 * recorded anywhere; a re-simulation reproduces the refusal from the record.
 */
export const DIP_UNVERIFIED_SIGNATURE = 'unverified_local..no_passport_keys';

/** Returns the payload with signatures attested, and how many were replaced. Never mutates the input. */
export function attestLocalSignatures(payload: Record<string, unknown>): { payload: Record<string, unknown>; replaced: number } {
  if (!Array.isArray(payload.press)) return { payload, replaced: 0 };
  let replaced = 0;
  const press = payload.press.map((m: unknown) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return m;
    const o = m as Record<string, unknown>;
    if (o.signature === undefined || o.signature === 'session') return o;
    replaced++;
    return { ...o, signature: DIP_UNVERIFIED_SIGNATURE };
  });
  return { payload: { ...payload, press }, replaced };
}

// ------------------------------------------------------------------ press redaction at the edge (G-40)

/**
 * The fixed text a credential-shaped span of target press is replaced with. It
 * passes the engine's press allow-list (letters and punctuation), matches no
 * redaction shape, and differs from the labels `writeOutput` writes
 * (`[redacted:shape]`, …), so a record redacted AFTER the run stays recognisable
 * (rerun.ts `withRedactionHint`).
 *
 * G-42: it is exactly `MIN_SECRET_LENGTH` (8) characters, the shortest span the
 * redactor ever replaces (a boundary prefix/suffix of a registered secret, or an
 * 8-character secret), so a replacement never makes a field longer and a field at
 * its schema cap stays valid for `act()`'s whole-frame re-validation.
 */
export const DIP_PRESS_REDACTION_MARKER = '[redact]';
/** The labels redact.ts writes; each becomes the edge marker. */
const REDACTION_LABEL = /\[redacted:(?:shape|env|secret)\]/g;
const MAX_WALK_DEPTH = 16;
/** G-44: rounds of "redact what the file-write pass would still redact" before the whole string is replaced. */
const MAX_FIXED_POINT_ROUNDS = 4;

const labelCount = (s: string): number => s.match(REDACTION_LABEL)?.length ?? 0;
const codePoints = (s: string): number => [...s].length;
/**
 * The text the engine derives from a raw press string (NFKC, controls / bidi /
 * zero-width stripped, Zs runs collapsed, trimmed: wot-engine `sanitizePressText`),
 * which the transcript and the replay file carry. null when the engine would
 * refuse the string (it then appears nowhere but in the raw record).
 */
const engineText = (s: string): string | null => {
  const r = sanitizePressText(s, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, true);
  return r.ok ? r.text : null;
};
/**
 * The characters the engine's sanitiser deletes (a copy of its strip set; if the two
 * ever drift, the fixed-point check still holds and only falls back to the marker
 * more often). Deleting a line break JOINS the words around it ("bonds⏎with" →
 * "bondswith"), so a string can be harmless raw and credential-shaped once sanitised.
 */
const ENGINE_STRIP = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/**
 * The write-path check (G-44): would `writeOutput`'s `redact()` change this string
 * once it is serialised into a record? `{ ok }` when not; otherwise the string as
 * the write path would leave it (labels made the edge marker), or `null` when that
 * cannot be read back as one string. The engine's sanitised form (what the
 * transcript and the replay file carry) is checked too: on a hit there, the
 * characters the engine strips are deleted from the raw string and it is redacted
 * again; when that changes nothing, `null` (the whole string goes).
 */
function writePathView(r: string): { ok: true } | { ok: false; next: string | null; hits: number } {
  const j = JSON.stringify(r);
  const rj = redact(j);
  if (rj !== j) {
    let next: string | null = null;
    try {
      const v: unknown = JSON.parse(rj);
      if (typeof v === 'string') next = v.replace(REDACTION_LABEL, DIP_PRESS_REDACTION_MARKER);
    } catch {
      next = null;
    }
    return { ok: false, next, hits: Math.max(1, labelCount(rj) - labelCount(j)) };
  }
  const san = engineText(r);
  if (san !== null && san !== r) {
    const js = JSON.stringify(san);
    if (redact(js) !== js) {
      // Delete what the engine deletes anyway (the engine's text is unchanged by it), so the
      // join is visible to the redactor in the raw string too; the next round re-checks.
      const stripped = r.replace(ENGINE_STRIP, '');
      if (stripped === r) return { ok: false, next: null, hits: 1 };
      const rs = redact(stripped);
      return { ok: false, next: rs.replace(REDACTION_LABEL, DIP_PRESS_REDACTION_MARKER), hits: Math.max(1, labelCount(rs) - labelCount(stripped)) };
    }
  }
  return { ok: true };
}

/**
 * One string at the edge: redact it, then make it a fixed point of the file-write
 * redactor BY CONSTRUCTION (G-43, G-44): apply the write path to the serialised
 * bytes and repeat until nothing changes (bounded), else the whole string becomes
 * the marker. Never longer than the input (G-42). Returns the string and the spans
 * replaced (0 = unchanged, the same string back).
 */
function redactEdgeString(v: string): { text: string; replaced: number } {
  let r = redact(v);
  let replaced = r === v ? 0 : Math.max(1, labelCount(r) - labelCount(v));
  r = r.replace(REDACTION_LABEL, DIP_PRESS_REDACTION_MARKER);
  let fixed = false;
  for (let round = 0; round < MAX_FIXED_POINT_ROUNDS; round++) {
    const w = writePathView(r);
    if (w.ok) {
      fixed = true;
      break;
    }
    replaced += w.hits;
    if (w.next === null) break;
    r = w.next;
  }
  if (!fixed) r = DIP_PRESS_REDACTION_MARKER;
  if (r === v) return { text: v, replaced: 0 };
  // G-42 backstop: a string never grows (the marker is cut to the input's length in code points).
  const max = codePoints(v);
  if (codePoints(r) > max) r = [...DIP_PRESS_REDACTION_MARKER].slice(0, max).join('');
  return { text: r, replaced: Math.max(1, replaced) };
}

/**
 * G-40: run the one Redactor (registered secrets and credential shapes) over every
 * string of an accepted target payload (press bodies, `terms.note`,
 * `intent.notes`, orders, …) BEFORE `act()`, replacing each match with
 * `DIP_PRESS_REDACTION_MARKER`. The engine, the transcript, the record and the
 * files then hold the same bytes, and `writeOutput`'s redaction finds nothing to
 * change (G-44: enforced per string by `redactEdgeString`), so a report stays
 * verifiable whatever the target wrote (plain English such as "the bearer
 * shipments" matches the `Bearer <token>` shape).
 * Returns the payload (never mutates the input) and the number of spans replaced.
 */
export function redactPressText(payload: Record<string, unknown>): { payload: Record<string, unknown>; replaced: number } {
  let replaced = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const r = redactEdgeString(v);
      replaced += r.replaced;
      return r.text;
    }
    if (depth >= MAX_WALK_DEPTH || typeof v !== 'object' || v === null) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  const out = walk(payload, 0) as Record<string, unknown>;
  return replaced ? { payload: out, replaced } : { payload, replaced: 0 };
}

// ------------------------------------------------------------------ recorded inputs, validity

/**
 * The target power's recorded action array (contracts 2.2.0 `recorded_inputs`:
 * the seat's action frames in decision order). One entry per decision the
 * target had (the adapter's `decision` timing entries): the payload the engine
 * accepted from the target (`diplomacy.targetInputs`, the wire form minus
 * `thought`, signatures attested) or null (miss / refused frame). An in-process
 * reference target exchanges no frames; its entry is the engine action it took.
 */
export function dipRecordedActions(rec: EpisodeRecord, seat: string = rec.targetSeat): unknown[] {
  if (!isDiplomacyRecord(rec) || seat !== rec.targetSeat) return [];
  const d = rec.diplomacy;
  const external = d.roster[d.power]?.agent === 'external';
  const byTick = new Map(d.targetInputs.map((x) => [x.tick, x.payload]));
  return rec.timing
    .filter((e) => e.event === 'decision' && e.seat === seat)
    .map((e) => {
      if (external) return byTick.get(e.tick) ?? null;
      const inp = rec.inputs[e.tick] as { actions?: Record<string, unknown> } | undefined;
      return inp?.actions?.[seat] ?? null;
    });
}

/**
 * The anti-flake rule (arena-scenarios README): when a reference seat fails an
 * oracle, the episode is invalid, every target verdict is `not_assessed` with
 * `reason_code: episode_invalid`, and the episode counts toward neither pass
 * nor fail.
 */
export function dipValidity(rec: EpisodeRecord): { valid: boolean; invalidBy: string[] } {
  if (!isDiplomacyRecord(rec)) return { valid: true, invalidBy: [] };
  const v = computeDipVerdicts(rec);
  return { valid: v.valid, invalidBy: [...v.invalidBy] };
}
