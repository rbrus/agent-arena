/**
 * Compare the replay hashes in a report.json against the FROZEN golden anchors.
 * The anchors come from sandbox/anchors.json, the data copy of
 * packages/arena-scenarios/src/anchors.ts SELF_TESTS kept in lockstep by
 * sandbox/anchors-json.ts (the image build fails on drift).
 *
 *   node check-anchors.mjs \
 *        --report <report.json> --anchors <anchors.json> \
 *        [--policy coordinated|naive] [--seeds 20260720,1,2,3,5] [--episodes 5]
 *
 * Plain JSON, not anchors.ts: since Phase 8 B3b anchors.ts imports `wot-engine`
 * (through the Diplomacy anchors), which the distroless runtime image cannot
 * resolve. This script imports nothing but node:fs, so verify.sh runs it with
 * the image's own Node (no host Node needed), with the report and the anchors
 * mounted read-only from the checkout.
 *
 * Matching: an episode matches the anchor with the same scenario, tier
 * (report.budget_limits.tier), seating mode, seed and reference driver
 * `ref:<policy>`. Every episode must have one, and the replay hash, outcome and
 * terminal tick must all be equal. Exit 0 = all equal, 1 = mismatch, 2 = usage
 * or input error.
 */
import { readFileSync } from 'node:fs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}
function die(code, msg) {
  process.stderr.write(`check-anchors: ${msg}\n`);
  process.exit(code);
}

const reportPath = arg('report');
const anchorsPath = arg('anchors');
if (!reportPath || !anchorsPath) die(2, 'usage: --report <report.json> --anchors <anchors.json>');
const policy = arg('policy', 'coordinated');
const wantSeeds = arg('seeds') ? arg('seeds').split(',').map((s) => Number(s.trim())) : null;
const wantEpisodes = arg('episodes') ? Number(arg('episodes')) : null;

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  die(2, `cannot read report ${reportPath}: ${e.message}`);
}
let SELF_TESTS;
try {
  const doc = JSON.parse(readFileSync(anchorsPath, 'utf8'));
  SELF_TESTS = doc?.anchors;
  if (Number.isInteger(doc?.count) && Array.isArray(SELF_TESTS) && doc.count !== SELF_TESTS.length) {
    die(2, `anchors file ${anchorsPath} is inconsistent: count=${doc.count}, ${SELF_TESTS.length} rows`);
  }
} catch (e) {
  die(2, `cannot read anchors ${anchorsPath}: ${e.message}`);
}
if (!Array.isArray(SELF_TESTS) || SELF_TESTS.length === 0) die(2, `anchors file ${anchorsPath} has no anchors[]`);

const scenario = report?.scenario?.scenario_id;
const tier = report?.budget_limits?.tier;
const episodes = report?.episodes;
if (!scenario || !tier || !Array.isArray(episodes)) die(2, 'report lacks scenario.scenario_id, budget_limits.tier or episodes[]');

const driver = `ref:${policy}`;
let failures = 0;
const seen = [];
for (const ep of episodes) {
  const cands = SELF_TESTS.filter(
    (a) => a.scenario === scenario && a.tier === tier && a.seed === ep.seed && a.opts?.mode === ep.mode && a.opts?.targetDriver === driver,
  );
  const hashes = [...new Set(cands.map((a) => a.expect.replayHash))];
  if (hashes.length === 0) {
    failures++;
    console.log(`MISSING  ep=${ep.episode_index} seed=${ep.seed} ${scenario}/${tier}/${ep.mode}/${driver}: no frozen anchor`);
    continue;
  }
  if (hashes.length > 1) die(2, `anchors are inconsistent for seed ${ep.seed}: ${hashes.join(' vs ')}`);
  const a = cands[0].expect;
  const ok = ep.replay_hash === a.replayHash && ep.outcome === a.outcome && ep.terminal_tick === a.ticks;
  if (!ok) failures++;
  seen.push(ep.seed);
  console.log(
    `${ok ? 'MATCH   ' : 'MISMATCH'} ep=${ep.episode_index} seed=${ep.seed} outcome=${ep.outcome}/${a.outcome} ` +
      `tick=${ep.terminal_tick}/${a.ticks} hash=${ep.replay_hash}${ok ? '' : ` expected ${a.replayHash}`}`,
  );
}
if (wantEpisodes !== null && episodes.length !== wantEpisodes) {
  failures++;
  console.log(`COUNT    report has ${episodes.length} episodes, expected ${wantEpisodes}`);
}
if (wantSeeds) {
  const missing = wantSeeds.filter((s) => !seen.includes(s));
  if (missing.length) {
    failures++;
    console.log(`SEEDS    no matching episode for seed(s) ${missing.join(',')}`);
  }
}
console.log(failures === 0 ? `ANCHORS OK: ${episodes.length}/${episodes.length} replay hashes equal the frozen anchors` : `ANCHORS FAIL: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
