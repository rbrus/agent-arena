/**
 * contractsDir(): one call that finds contracts/ in the private layout
 * (<private-root>/{contracts, ascension/}), the public layout
 * (agent-arena/{contracts, packages/}) and the image build (/src/contracts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractsDir, workspaceRoot } from '../src/contracts-dir.ts';

function withoutOverride<T>(fn: () => T): T {
  const saved = process.env.WOT_CONTRACTS_DIR;
  delete process.env.WOT_CONTRACTS_DIR;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.WOT_CONTRACTS_DIR = saved;
  }
}

/** A synthetic tree: `ws` gets a workspace package.json and packages/p/src; `contracts` lists dirs that get schemas/. */
function layout(ws: string, contracts: string[]): { top: string; start: string } {
  const top = mkdtempSync(join(tmpdir(), 'wot-cdir-'));
  const root = join(top, ws);
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['packages/*'] }));
  writeFileSync(join(root, 'packages', 'p', 'package.json'), JSON.stringify({ name: 'p' }));
  for (const c of contracts) mkdirSync(join(top, c, 'schemas'), { recursive: true });
  return { top, start: join(root, 'packages', 'p', 'src') };
}

test('this checkout: contractsDir() has schemas/ and fixtures/', () => {
  const dir = withoutOverride(() => contractsDir());
  assert.ok(existsSync(join(dir, 'schemas')), dir);
  assert.ok(existsSync(join(dir, 'fixtures')), dir);
});

test('public layout: <workspace root>/contracts', () => {
  const { top, start } = layout('agent-arena', ['agent-arena/contracts']);
  try {
    assert.equal(withoutOverride(() => workspaceRoot(start)), join(top, 'agent-arena'));
    assert.equal(withoutOverride(() => contractsDir(start)), join(top, 'agent-arena', 'contracts'));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('private layout: <workspace root>/../contracts', () => {
  const { top, start } = layout('ascension', ['contracts']);
  try {
    assert.equal(withoutOverride(() => contractsDir(start)), join(top, 'contracts'));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('both present: the in-repo contracts/ wins (a sibling of the clone cannot shadow it)', () => {
  const { top, start } = layout('agent-arena', ['agent-arena/contracts', 'contracts']);
  try {
    assert.equal(withoutOverride(() => contractsDir(start)), join(top, 'agent-arena', 'contracts'));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('neither present: throws naming both paths', () => {
  const { top, start } = layout('agent-arena', []);
  try {
    assert.throws(
      () => withoutOverride(() => contractsDir(start)),
      (e: Error) => e.message.includes(join(top, 'agent-arena', 'contracts')) && e.message.includes(join(top, 'contracts')) && e.message.includes('WOT_CONTRACTS_DIR'),
    );
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('WOT_CONTRACTS_DIR wins, and a value without schemas/ throws', () => {
  const { top, start } = layout('agent-arena', ['agent-arena/contracts', 'elsewhere']);
  const saved = process.env.WOT_CONTRACTS_DIR;
  try {
    process.env.WOT_CONTRACTS_DIR = join(top, 'elsewhere');
    assert.equal(contractsDir(start), join(top, 'elsewhere'));
    process.env.WOT_CONTRACTS_DIR = join(top, 'agent-arena');
    assert.throws(() => contractsDir(start), /has no schemas\/ directory/);
  } finally {
    if (saved === undefined) delete process.env.WOT_CONTRACTS_DIR;
    else process.env.WOT_CONTRACTS_DIR = saved;
    rmSync(top, { recursive: true, force: true });
  }
});
