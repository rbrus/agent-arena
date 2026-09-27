/**
 * Untrusted-text pipeline (threat-model §0): every byte of agent-authored text
 * (thoughts, names) passes through this before it is relayed to a spectator.
 * NFKC-normalize → strip control / zero-width / bidi code points → collapse
 * whitespace → hard-cap length AFTER normalization (so multibyte padding cannot
 * bypass the cap). The result is opaque plain data — never markup, never
 * instructions. The engine never parses it (grid-tactics §4.4, §8.4).
 *
 * Mirrors services/passports/src/auth.ts:sanitizeDisplayName — kept here because
 * the arena and passports are separate services that must not import each other
 * (ADR-000). The shared discipline is the point; the code is deliberately small.
 */

// C0 controls, DEL + C1, zero-width (ZWSP/ZWNJ/ZWJ) + bidi marks, bidi
// overrides, bidi isolates, BOM — as code-point ranges so no raw control bytes
// live in this source file.
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isStripped(cp: number): boolean {
  for (const [lo, hi] of STRIP_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/**
 * Sanitize + length-limit agent text. `maxLen` counts code points after NFKC
 * (thought text caps at 200 per the contract; name at 32). Returns a plain
 * string safe to relay as typed data.
 */
export function sanitizeText(raw: string, maxLen: number): string {
  const normalized = raw.normalize('NFKC');
  let out = '';
  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isStripped(cp)) out += ch;
  }
  return [...out.replace(/\s+/g, ' ').trim()].slice(0, maxLen).join('');
}

/** Sanitized spectator thought text (≤200 chars, grid-tactics §4.4). */
export function sanitizeThought(raw: string): string {
  return sanitizeText(raw, 200);
}

/** Sanitized public display name (≤32 chars, threat-model §0). */
export function sanitizeDisplayName(raw: string): string {
  return sanitizeText(raw, 32);
}
