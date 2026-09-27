// Wrapper so `npm test` can run the cross-check suite (qa/ is outside the test glob).
// It takes ~80 s and drives 69 CLI runs, so it is opt-in: ARENA_CROSSCHECK=1 npm test.
import { test } from 'node:test';
if (process.env.ARENA_CROSSCHECK === '1') {
  await import('../../../qa/crosscheck.test.ts');
} else {
  test('cross-check suite (skipped; set ARENA_CROSSCHECK=1 to run)', { skip: true }, () => {});
}
