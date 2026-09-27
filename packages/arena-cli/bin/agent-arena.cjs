#!/usr/bin/env node
'use strict';
/*
 * The `agent-arena` bin. npm links a workspace bin only when its file exists at
 * install time, and dist/ is built after `npm ci` (`npm run build:cli`), so the
 * bin is this committed shim: it loads the self-contained bundle, or says what to
 * do next when the bundle is not built yet. It reads no argument, variable or
 * file other than the bundle's path; the bundle does everything else.
 */
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const bundle = join(__dirname, '..', 'dist', 'agent-arena.cjs');
if (!existsSync(bundle)) {
  process.stderr.write('error: agent-arena is not built in this checkout (packages/arena-cli/dist/agent-arena.cjs is missing). Next: run `npm run build:cli` in the workspace root, then run `npx agent-arena` again (or run the source: `npx tsx packages/arena-cli/src/bin.ts`).\n');
  process.exit(2);
}
require(bundle);
