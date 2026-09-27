/**
 * `npx agent-arena` from a fresh checkout (public-docs finding): npm links a workspace
 * bin only when its file exists at install time, and dist/ is built after `npm ci`.
 * The bin is therefore the committed shim bin/agent-arena.cjs, which loads the bundle.
 * This test builds a temp workspace from the real package.json (install-time fields
 * only: no dependencies to fetch), installs it offline, and runs the linked bin before
 * and after the bundle exists.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION } from '../src/build-info.ts';
import { PKG, scratch } from './helpers.ts';

test('fresh checkout: npm install links the agent-arena bin before dist/ exists; it names build:cli until built, and runs the bundle after', { timeout: 300_000 }, async () => {
  const real = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { name: string; version: string; type: string; bin: Record<string, string>; files: string[] };
  assert.equal(real.bin['agent-arena'], 'bin/agent-arena.cjs', 'the bin is the committed shim, not a build output');
  assert.ok(real.files.includes('bin/agent-arena.cjs') && real.files.includes('dist/agent-arena.cjs'), 'both are published');
  assert.ok(existsSync(join(PKG, 'bin', 'agent-arena.cjs')));

  const root = scratch('arena-bin-');
  const pkgDir = join(root, 'packages', 'arena-cli');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'bin-link-probe', private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({ name: real.name, version: real.version, type: real.type, bin: real.bin, files: real.files }, null, 2)}\n`);
  copyFileSync(join(PKG, 'bin', 'agent-arena.cjs'), join(pkgDir, 'bin', 'agent-arena.cjs'));

  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' } as NodeJS.ProcessEnv;
  const npm = (args: string[]) => spawnSync('npm', args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  const inst = npm(['install', '--offline', '--ignore-scripts']);
  assert.equal(inst.status, 0, inst.stderr);
  assert.ok(existsSync(join(root, 'node_modules', '.bin', 'agent-arena')), 'npm linked the bin without dist/');

  const before = npm(['exec', '--offline', '--', 'agent-arena', 'version']);
  assert.equal(before.status, 2, before.stdout + before.stderr);
  assert.match(before.stderr, /^error: agent-arena is not built in this checkout .* Next: run `npm run build:cli` in the workspace root/m);

  const { bundle } = await import('../build.ts');
  await bundle(join(pkgDir, 'dist', 'agent-arena.cjs'));
  const after = npm(['exec', '--offline', '--', 'agent-arena', 'version']);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.ok(after.stdout.includes(VERSION), after.stdout);
  const listed = npm(['exec', '--offline', '--', 'agent-arena', 'list-scenarios', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok((JSON.parse(listed.stdout) as unknown[]).length > 0 || /byzantine/.test(listed.stdout));
});
