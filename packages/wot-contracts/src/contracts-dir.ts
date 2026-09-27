/**
 * Locate the `contracts/schemas` directory by walking up from a start
 * directory to the first ancestor that contains it.
 *
 * Two layouts must work unchanged (docs/phase-7/EXTRACTION.md §1, §11.2):
 *   - private repo:  <private-root>/{contracts, ascension/packages/wot-contracts}
 *   - public repo:   agent-arena/{contracts, packages/wot-contracts}
 * A fixed `join(HERE, '..', '..', ...)` only works in one of them.
 *
 * `WOT_CONTRACTS_DIR` overrides the search (points at the `contracts/` dir).
 *
 * `contractsDir()` (below) is the fixed-order variant for tests and tools: it
 * needs no start directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function findContractsDir(start: string): string {
  const override = process.env.WOT_CONTRACTS_DIR;
  if (override) {
    const dir = resolve(override);
    if (!existsSync(join(dir, 'schemas'))) {
      throw new Error(`WOT_CONTRACTS_DIR=${dir} has no schemas/ directory`);
    }
    return dir;
  }
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'contracts');
    if (existsSync(join(candidate, 'schemas'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`contracts/schemas not found in any ancestor of ${start}`);
    }
    dir = parent;
  }
}

export function findSchemasDir(start: string): string {
  return join(findContractsDir(start), 'schemas');
}

/**
 * The npm workspace root: the first ancestor of `start` (default: this
 * package) whose package.json declares `workspaces`.
 *   private repo:  <private-root>/ascension
 *   public repo:   agent-arena
 *   image build:   /src
 */
export function workspaceRoot(start: string = HERE): string {
  let dir = resolve(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown }).workspaces) return dir;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no npm workspace root (package.json with "workspaces") above ${start}`);
    dir = parent;
  }
}

/**
 * The `contracts/` directory (the one holding `schemas/`, `fixtures/`, ...),
 * for tests and tools that read contract files. Use this instead of
 * `join(HERE, '..', '..', '..', '..', 'contracts')`, which only works in the
 * private layout.
 *
 * Resolution order, first hit wins:
 *   1. `WOT_CONTRACTS_DIR` (must contain `schemas/`, else throws);
 *   2. `<workspace root>/contracts`     public layout (and the image build);
 *   3. `<workspace root>/../contracts`  private layout (beside ascension/).
 * The in-repo directory is tried before the parent one so that, in a public
 * clone, a stray `contracts/` next to the clone can never shadow the repo's
 * own contracts. In the private layout there is no `ascension/contracts`, so
 * the order changes nothing there.
 *
 * Throws, naming every path it tried, when none has a `schemas/` directory.
 * `start` (default: this package) only exists so tests can point it at a
 * synthetic layout.
 */
export function contractsDir(start: string = HERE): string {
  const override = process.env.WOT_CONTRACTS_DIR;
  if (override) {
    const dir = resolve(override);
    if (!existsSync(join(dir, 'schemas'))) throw new Error(`WOT_CONTRACTS_DIR=${dir} has no schemas/ directory`);
    return dir;
  }
  const root = workspaceRoot(start);
  const tried = [join(root, 'contracts'), resolve(root, '..', 'contracts')];
  for (const dir of tried) if (existsSync(join(dir, 'schemas'))) return dir;
  throw new Error(
    `contracts/ not found: tried ${tried.join(' and ')} (neither has schemas/). ` +
      'Set WOT_CONTRACTS_DIR to the contracts directory, or run from a full checkout.',
  );
}
