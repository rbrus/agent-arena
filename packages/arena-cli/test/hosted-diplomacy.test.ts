/**
 * Hosted Diplomacy: commit-then-reveal of the per-episode secret (contracts
 * signing.md §4, threat-model-hosted §2.5; HT-2.6/2.7). The manifest carries
 * only the commitment digest; the secrets arrive through the per-run secret
 * channel and must hash to it; the report discloses them after the run, and
 * `verify --hosted` rechecks the relation.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { signReport, toFileJson, toSarif, type Report } from 'arena-report';
import { verifyCommand } from '../src/commands/verify.ts';
import { CliError } from '../src/errors.ts';
import { episodeSecretCommitment } from '../src/hosted/manifest.ts';
import { startReferenceServer, type ReferenceServer } from '../src/reference/serve.ts';
import { setOutputMode } from '../src/ui.ts';
import { commitmentsFor, dipSecret, hostedEnv, MANIFEST_KID, ORIGIN, PLATFORM, PRIV, pubJwk, REPORT_KID, runSpec, signManifest, unsignedManifest, viaReference, writeInputs, runHosted } from './hosted-fixtures.ts';
import { scratch } from './helpers.ts';

let srv: ReferenceServer;
before(async () => {
  setOutputMode({ quiet: true });
  srv = await startReferenceServer({ port: 0, policy: 'robust', scenario: 'diplomacy_standard' });
});
after(async () => {
  await srv.close();
});

const dipSpec = () =>
  runSpec({
    scenario_id: 'diplomacy_standard',
    seeds: [20261115, 3],
    episodes: 2,
    seat: { mode: 'power', position: 'germany' },
    diplomacy: { profile: 'clean', horizon_year: 1901, fill: 'house' },
  } as never);

const SECRETS = [dipSecret('ep0'), dipSecret('ep1')];

function setup(secretsInManifest = SECRETS) {
  const spec = dipSpec();
  const m = signManifest(unsignedManifest(spec, { episode_secret_commitments: commitmentsFor(secretsInManifest) }));
  const dir = scratch();
  return { spec, m, dir, inputs: writeInputs(join(dir, 'in'), m, spec) };
}

const run = (s: ReturnType<typeof setup>, env: NodeJS.ProcessEnv) =>
  runHosted({ ...s.inputs, manifestKey: pubJwk(MANIFEST_KID), out: join(s.dir, 'out') }, { env, platform: PLATFORM, transportFactory: viaReference(srv.urls.rest, {}) });

const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof CliError && e.exitCode === 3 && re.test(e.message));

test('secrets that hash to the manifest commitments: the run plays with them, discloses them, and verify --hosted accepts the relation; a swapped secret is exit 1', async () => {
  const s = setup();
  const env = hostedEnv({ ARENA_DIP_SECRET_0: SECRETS[0], ARENA_DIP_SECRET_1: SECRETS[1] });
  const r = await run(s, env);
  assert.ok(r.exitCode === 0 || r.exitCode === 1);
  assert.equal(env.ARENA_DIP_SECRET_0, undefined, 'scrubbed on load');
  const out = join(s.dir, 'out');
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')) as Report;
  report.episodes.forEach((ep, i) => {
    const d = ep.diplomacy as { episode_secret?: string; episode_secret_commitment?: string };
    assert.equal(d.episode_secret, SECRETS[i]);
    assert.equal(d.episode_secret_commitment, episodeSecretCommitment(SECRETS[i]));
  });
  // Seal (test key) and verify --hosted: signatures, manifest beside the report, commitments.
  const sealed = signReport(report, PRIV, REPORT_KID, { sealedAt: '2026-11-10T14:07:00Z' });
  writeFileSync(join(out, 'report.json'), toFileJson(sealed));
  writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(sealed, { specPath: '.agent-arena/diplomacy_standard.run.json' })));
  assert.equal(verifyCommand(join(out, 'report.json'), { key: pubJwk(), hosted: true, manifestKey: pubJwk(MANIFEST_KID) }), 0);

  // A secret chosen after the fact (with a consistent per-episode commitment, re-sealed): the list no longer hashes to the manifest.
  const forged = JSON.parse(JSON.stringify(report)) as Report;
  const other = dipSecret('chosen-after-the-run');
  Object.assign(forged.episodes[0].diplomacy as object, { episode_secret: other, episode_secret_commitment: episodeSecretCommitment(other) });
  const reSealed = signReport(forged, PRIV, REPORT_KID, { sealedAt: '2026-11-10T14:07:00Z' });
  writeFileSync(join(out, 'report.json'), toFileJson(reSealed));
  writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(reSealed, { specPath: '.agent-arena/diplomacy_standard.run.json' })));
  assert.equal(verifyCommand(join(out, 'report.json'), { key: pubJwk(), hosted: true }), 1);
  // A disclosed secret that does not hash to its own commitment: exit 1 too.
  Object.assign(forged.episodes[0].diplomacy as object, { episode_secret: other, episode_secret_commitment: episodeSecretCommitment(SECRETS[0]) });
  const reSealed2 = signReport(forged, PRIV, REPORT_KID, { sealedAt: '2026-11-10T14:07:00Z' });
  writeFileSync(join(out, 'report.json'), toFileJson(reSealed2));
  writeFileSync(join(out, 'report.sarif'), toFileJson(toSarif(reSealed2, { specPath: '.agent-arena/diplomacy_standard.run.json' })));
  assert.equal(verifyCommand(join(out, 'report.json'), { key: pubJwk(), hosted: true }), 1);
});

test('only ARENA_DIP_SECRET_<n> (contracts 2.5.0): the ARENA_EPISODE_SECRETS array form and malformed names are scrubbed and refused', async () => {
  const env = hostedEnv({ ARENA_EPISODE_SECRETS: JSON.stringify(SECRETS) });
  await refused(run(setup(), env), /ARENA_EPISODE_SECRETS is not a contract variable/);
  assert.equal(env.ARENA_EPISODE_SECRETS, undefined);
  const env2 = hostedEnv({ ARENA_DIP_SECRET_00: SECRETS[0], ARENA_DIP_SECRET_1: SECRETS[1] });
  await refused(run(setup(), env2), /malformed episode-secret variable name/);
  assert.equal(env2.ARENA_DIP_SECRET_00, undefined);
});

test('commitment mismatch: secrets that do not hash to the manifest digest are refused before any I/O', async () => {
  await refused(run(setup(), hostedEnv({ ARENA_DIP_SECRET_0: SECRETS[1], ARENA_DIP_SECRET_1: SECRETS[0] })), /commit-then-reveal/);
});

test('empty, short, missing, extra or duplicated secrets are refused', async () => {
  await refused(run(setup(), hostedEnv({ ARENA_DIP_SECRET_0: '', ARENA_DIP_SECRET_1: SECRETS[1] })), /empty or short/);
  await refused(run(setup(), hostedEnv({ ARENA_DIP_SECRET_0: 'abcd', ARENA_DIP_SECRET_1: SECRETS[1] })), /empty or short/);
  await refused(run(setup(), hostedEnv({ ARENA_DIP_SECRET_0: SECRETS[0] })), /1 episode secret\(s\) were delivered for 2/);
  await refused(run(setup([SECRETS[0], SECRETS[0]]), hostedEnv({ ARENA_DIP_SECRET_0: SECRETS[0], ARENA_DIP_SECRET_1: SECRETS[0] })), /same secret/);
  await refused(run(setup(), hostedEnv({ ARENA_DIP_SECRET_0: SECRETS[0], ARENA_DIP_SECRET_1: SECRETS[1], ARENA_DIP_SECRET_2: dipSecret('extra') })), /3 episode secret\(s\) were delivered for 2/);
});

test('a Diplomacy manifest without commitments, or a non-Diplomacy one with them, is refused', async () => {
  const spec = dipSpec();
  const dir = scratch();
  const inputs = writeInputs(join(dir, 'in'), signManifest(unsignedManifest(spec)), spec);
  await refused(runHosted({ ...inputs, manifestKey: pubJwk(MANIFEST_KID), out: join(dir, 'out') }, { env: hostedEnv(), platform: PLATFORM }), /needs the per-episode secret commitments/);
  const spec2 = runSpec();
  const dir2 = scratch();
  const inputs2 = writeInputs(join(dir2, 'in'), signManifest(unsignedManifest(spec2, { episode_secret_commitments: commitmentsFor(SECRETS) })), spec2);
  await refused(runHosted({ ...inputs2, manifestKey: pubJwk(MANIFEST_KID), out: join(dir2, 'out') }, { env: hostedEnv(), platform: PLATFORM }), /not a Diplomacy scenario/);
  assert.ok(ORIGIN);
});
