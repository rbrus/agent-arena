/**
 * `verify --hosted-seal --result <path>`: the verification result as a file, for the Sixi seal step's
 * verifier job (docs/phase-9/pr/PR6.md: the job's stdout goes to logs, and the sealer reads the result from the
 * run's `seal/` folder; without it every seal fails `verify_no_result`).
 *
 * Semantics:
 *   - The file holds exactly the document `--json` prints on stdout (same bytes: 2-space JSON, redacted, inert,
 *     LF-terminated), whether or not `--json` is also given. stdout is unchanged by `--result`.
 *   - It is written for every outcome the verification reaches: 0 verified, 1 mismatch, 2 unverifiable or
 *     signature_invalid, and 3 when a misuse is found after the path was accepted (a sealed bundle without
 *     --key, a pack scenario, …: `{"ok":false,"status":"misuse","exitCode":3,"errors":[…]}`). The file's
 *     `exitCode` always equals the process exit code. No file means the verifier did not finish.
 *   - The path is checked before anything else is read: it must not exist (create-only, O_EXCL; a symbolic link
 *     is refused, O_NOFOLLOW), its parent must be an existing directory, and it must be outside the bundle
 *     directory (signing.md §5.1: no other file belongs to the bundle). A refusal is exit 3 and writes nothing.
 *   - A write failure after verification is exit 2 (`result_not_written`), whatever the verification said.
 */

import { closeSync, constants as fsConstants, fsyncSync, lstatSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError, misconfig } from './errors.ts';
import { EXIT_CODES } from './report.ts';
import { jsonDocument } from './ui.ts';

const NEXT = 'pass --result a path that does not exist yet, in a writable directory outside the bundle (the verifier job writes /run/arena/seal/verify.json).';
const INSIDE = '--result points inside the bundle being verified; the result is not a bundle file (signing.md §5.1).';

/**
 * An accepted `--result` path (G-61): the path as given (resolved), and the physical directories the bundle
 * boundary was checked on. `writeResultFile` checks both again immediately before it creates the file.
 */
export interface ResultTarget {
  /** The absolute path the file is created at (its last component is never followed, O_NOFOLLOW). */
  path: string;
  /** The bundle directory as given (resolved); its physical form is re-derived at write time. */
  bundleDir: string;
  /** The physical (realpath) parent directory of `path` at check time. */
  parent: string;
}

/** Windows and macOS file systems are case-insensitive by default: compare paths without case there. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (FOLD_CASE ? p.toLowerCase() : p);

/** `p` equals `dir` or lies below it. `path.relative`, not a prefix test, so a bundle of `/` contains every path. */
export function isInside(p: string, dir: string): boolean {
  const r = relative(norm(dir), norm(p));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** The physical path of a directory (symbolic links, `..`, 8.3 names resolved), or undefined when it cannot be resolved. */
function physical(dir: string): string | undefined {
  try {
    return realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/** The bundle boundary on physical paths: `parent` (physical) + `name` must lie outside the bundle's physical directory. */
function outsideBundle(parent: string, name: string, bundleDir: string): boolean {
  const b = resolve(bundleDir);
  if (b === sep || /^[A-Za-z]:\\?$/.test(b)) return false; // a bundle of `/` (or a drive root) contains every path
  const pb = physical(b) ?? b;
  return !isInside(join(parent, name), pb);
}

/** Check `--result` before the bundle is read. `bundleDir` is the directory being verified. */
export function prepareResultPath(arg: string, bundleDir: string): ResultTarget {
  if (!arg.trim()) throw misconfig('--result needs a file path.', NEXT);
  const p = resolve(arg);
  const b = resolve(bundleDir);
  if (isInside(p, b)) throw misconfig(INSIDE, NEXT);
  let exists = true;
  try {
    lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw misconfig(`--result: the path cannot be checked (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, NEXT);
    exists = false;
  }
  if (exists) throw misconfig('--result: a file (or link) already exists at that path; the result is written create-only, never over another file.', NEXT);
  let parentStat;
  try {
    parentStat = statSync(dirname(p));
  } catch {
    throw misconfig('--result: the directory for the result does not exist.', NEXT);
  }
  if (!parentStat.isDirectory()) throw misconfig('--result: the parent of the result path is not a directory.', NEXT);
  // G-61: the boundary on physical paths. A parent reached through a link into the bundle, or a bundle named
  // through a link, is still inside.
  const parent = physical(dirname(p));
  if (parent === undefined) throw misconfig('--result: the directory for the result cannot be resolved.', NEXT);
  if (!outsideBundle(parent, basename(p), b)) throw misconfig(INSIDE, NEXT);
  return { path: p, bundleDir: b, parent };
}

function notWritten(why: string): CliError {
  return new CliError(`result_not_written: ${why}; do not seal on this run.`, EXIT_CODES.error, NEXT);
}

/**
 * Write the result document create-only (O_EXCL | O_NOFOLLOW), then fsync. G-61: immediately before the open,
 * the parent is resolved again and must still be the directory accepted at check time, outside the bundle; where
 * the platform has no O_NOFOLLOW (Windows), the final path is checked with lstat right before the open.
 */
export function writeResultFile(target: ResultTarget, doc: unknown): void {
  const text = jsonDocument(doc);
  const { path } = target;
  const parent = physical(dirname(path));
  if (parent === undefined || norm(parent) !== norm(target.parent)) throw notWritten('the directory for the result changed after --result was checked (it is gone, or is now a link)');
  if (!outsideBundle(parent, basename(path), target.bundleDir)) throw notWritten('the directory for the result now resolves inside the bundle');
  const noFollow = fsConstants.O_NOFOLLOW;
  if (noFollow === undefined) {
    let present = true;
    try {
      lstatSync(path);
    } catch {
      present = false;
    }
    if (present) throw notWritten('a file or link appeared at --result after it was checked');
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (noFollow ?? 0), 0o644);
  } catch (e) {
    throw notWritten(`the verification result could not be created at --result (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    let n = 0;
    while (n < buf.length) n += writeSync(fd, buf, n, buf.length - n);
    fsyncSync(fd);
  } catch (e) {
    try {
      unlinkSync(path); // never leave a truncated result behind
    } catch {
      /* the sealer refuses an unparsable result anyway */
    }
    throw notWritten(`the verification result could not be written in full (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  } finally {
    closeSync(fd);
  }
}
