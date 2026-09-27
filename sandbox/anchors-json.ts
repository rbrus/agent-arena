/**
 * sandbox/anchors.json <- packages/arena-scenarios/src/anchors.ts SELF_TESTS.
 *
 * verify.sh checks the replay hashes of a sandbox run against the frozen
 * anchors with check-anchors.mjs, run by the image's Node. It cannot import
 * anchors.ts there: since Phase 8 B3b anchors.ts imports the Diplomacy anchors,
 * which import `wot-engine`, and the runtime image has no sources and no
 * node_modules. So the frozen table is kept as data in sandbox/anchors.json,
 * and this script keeps the copy honest:
 *
 *   tsx sandbox/anchors-json.ts            # --check (default): exit 1 on drift
 *   tsx sandbox/anchors-json.ts --write    # regenerate after a re-freeze
 *
 * The image build runs --check (sandbox/Dockerfile), so a stale anchors.json
 * fails `docker compose build` and verify.sh. The file comes from the CHECKOUT,
 * not from the image, so verifying a published image (ARENA_IMAGE=...) still
 * compares it against the anchors the checkout froze.
 *
 * Only the static SELF_TESTS rows are exported. Diplomacy anchors are computed
 * from the engine's golden tables, not frozen rows, and the sandbox does not
 * run Diplomacy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_TESTS } from '../packages/arena-scenarios/src/anchors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'anchors.json');

export function renderAnchorsJson(): string {
  const rows = SELF_TESTS.map((r) => ({
    scenario: r.scenario,
    name: r.name,
    seed: r.seed,
    tier: r.tier,
    opts: r.opts,
    expect: r.expect,
  }));
  // One row per line: a re-freeze reads as a per-anchor diff.
  const body = rows.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  return (
    '{\n' +
    '  "source": "packages/arena-scenarios/src/anchors.ts SELF_TESTS",\n' +
    '  "generated_by": "sandbox/anchors-json.ts --write (do not edit by hand; the image build runs --check)",\n' +
    `  "count": ${rows.length},\n` +
    '  "anchors": [\n' +
    body +
    '\n  ]\n}\n'
  );
}

const mode = process.argv.includes('--write') ? 'write' : 'check';
const want = renderAnchorsJson();
if (mode === 'write') {
  writeFileSync(OUT, want);
  console.log(`anchors-json: wrote ${OUT} (${SELF_TESTS.length} anchors)`);
} else {
  let have = '';
  try {
    have = readFileSync(OUT, 'utf8');
  } catch {
    // missing file: reported as drift below
  }
  if (have !== want) {
    console.error(
      `anchors-json: DRIFT: ${OUT} does not match packages/arena-scenarios/src/anchors.ts. ` +
        'Next: run `npx tsx sandbox/anchors-json.ts --write` and review the diff (a changed hash is a re-freeze).',
    );
    process.exit(1);
  }
  console.log(`anchors-json: sandbox/anchors.json matches anchors.ts (${SELF_TESTS.length} anchors)`);
}
