/**
 * Every byte the CLI writes goes through `writeOutput` (redacted after
 * serialisation, then made inert: G-36, every bidi / format / tag / private-use
 * code point `\u`-escaped, lossless for JSON; never through a symlink,
 * engine-chosen names only). Diplomacy press is redacted at the edge, before the
 * engine (runner.ts, G-40), so the redaction here is a backstop that finds nothing
 * in a record. Every
 * report / record it reads goes through `readHostileJson` (size cap, JSON
 * only, forbidden keys, depth cap) — a report file is hostile until verified
 * (threat model boundary B4).
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { misconfig, runError } from './errors.ts';
import { inertJson } from './inert.ts';
import { redact } from './redact.ts';

/** `text` is serialised JSON (every file the CLI writes is). */
export function writeOutput(path: string, text: string): void {
  writeFileNoFollow(path, inertJson(redact(text)));
}

/**
 * Write `text` byte-for-byte (same symlink refusal as writeOutput, no rewrite).
 * Only for a document whose bytes were already verified and hold no target text:
 * the hosted run manifest, copied verbatim so the bundle carries what was signed.
 */
export function writeRaw(path: string, text: string): void {
  writeFileNoFollow(path, text);
}

function writeFileNoFollow(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o644);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ELOOP') throw misconfig(`refusing to write through a symlink at ${path}.`, 'choose another --out directory.');
    throw runError(`cannot write ${path} (${code ?? 'error'}).`, 'check that --out is a writable directory.');
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

function hostile(v: unknown, maxDepth: number): string | null {
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > maxDepth) return `nesting deeper than ${maxDepth}`;
    for (const k of Object.keys(x)) {
      if (FORBIDDEN.has(k)) return `forbidden key ${k}`;
      stack.push([(x as Record<string, unknown>)[k], d + 1]);
    }
  }
  return null;
}

export class HostileFileError extends Error {}

/** The exact bytes of a file, with the same symlink / regular-file / size refusals as readHostileJson. */
export function readHostileBytes(path: string, maxBytes: number, what: string): Buffer {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new HostileFileError(`${what} not found: ${path}`);
  }
  if (st.isSymbolicLink()) throw new HostileFileError(`${what} is a symlink; refusing to follow it: ${path}`);
  if (!st.isFile()) throw new HostileFileError(`${what} is not a regular file: ${path}`);
  if (st.size > maxBytes) throw new HostileFileError(`${what} is ${st.size} bytes, over the ${maxBytes}-byte cap: ${path}`);
  return readFileSync(path);
}

export function readHostileJson(path: string, maxBytes: number, what: string): unknown {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new HostileFileError(`${what} not found: ${path}`);
  }
  if (st.isSymbolicLink()) throw new HostileFileError(`${what} is a symlink; refusing to follow it: ${path}`);
  if (!st.isFile()) throw new HostileFileError(`${what} is not a regular file: ${path}`);
  if (st.size > maxBytes) throw new HostileFileError(`${what} is ${st.size} bytes, over the ${maxBytes}-byte cap: ${path}`);
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new HostileFileError(`${what} is not valid JSON: ${path}`);
  }
  const bad = hostile(v, 64);
  if (bad) throw new HostileFileError(`${what} has a hostile structure (${bad}): ${path}`);
  return v;
}

/** Resolve a report-relative reference (`episodes/episode-0.json`) strictly inside `baseDir`. */
export function resolveInside(baseDir: string, ref: string): string {
  if (typeof ref !== 'string' || !ref || isAbsolute(ref) || ref.includes('\0') || ref.includes('\\')) throw new HostileFileError('replay_ref must be a relative path');
  const n = normalize(ref);
  if (n.split(sep).includes('..')) throw new HostileFileError('replay_ref may not leave the report directory');
  const full = resolve(baseDir, n);
  const rel = relative(resolve(baseDir), full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new HostileFileError('replay_ref may not leave the report directory');
  return join(resolve(baseDir), rel);
}

/** `replay_ref` of episode n: a sibling of the report file (`report.episode-<n>.replay.json`). */
export function replayRefFor(reportBase: string, index: number): string {
  return `${reportBase}.episode-${index}.replay.json`;
}

/** The sibling record file of a replay reference (what `verify` re-simulates). */
export function recordRefFor(replayRef: string): string {
  if (!replayRef.endsWith('.replay.json')) throw new HostileFileError('replay_ref must end in .replay.json');
  return `${replayRef.slice(0, -'.replay.json'.length)}.record.json`;
}
