/**
 * Assert that the image's DEFAULT environment carries none of the variables the
 * hosted-runner contract requires to be absent (contracts/fixtures/hosted_env.json
 * `must_be_absent`, signing.md §3.1). The hosted runner runs this exact image
 * (the sim is the spec), so an `ENV` line in sandbox/Dockerfile that sets one
 * of them makes every `run --hosted` refuse with `(environment)`.
 *
 *   node check-image-env.mjs <hosted_env.json>
 *
 * verify.sh runs it INSIDE the image with no extra -e flags, so process.env is
 * the image's ENV plus what `docker run` itself adds (PATH, HOSTNAME, HOME).
 * Imports only node:fs. Exit 0 = clean, 1 = a must-be-absent variable is set,
 * 2 = usage or input error.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('check-image-env: usage: check-image-env.mjs <hosted_env.json>\n');
  process.exit(2);
}
let rules;
try {
  rules = JSON.parse(readFileSync(path, 'utf8')).must_be_absent;
} catch (e) {
  process.stderr.write(`check-image-env: cannot read ${path}: ${e.message}\n`);
  process.exit(2);
}
if (!Array.isArray(rules) || rules.length === 0) {
  process.stderr.write(`check-image-env: ${path} has no must_be_absent[]\n`);
  process.exit(2);
}

const hits = [];
for (const r of rules) {
  const re = r.pattern ? new RegExp(r.pattern) : null;
  for (const [name, value] of Object.entries(process.env)) {
    if (re ? !re.test(name) : name !== r.name) continue;
    if (r.unless === 'empty' && value === '') continue;
    hits.push(`${name} (must be absent: ${r.field ?? 'environment'})`); // the name only, never the value
  }
}
if (hits.length) {
  console.log(`IMAGE ENV FAIL: the image sets ${hits.length} must-be-absent variable(s): ${hits.join(', ')}`);
  process.exit(1);
}
console.log(`IMAGE ENV OK: none of the ${rules.length} must-be-absent hosted variables is set in the image`);
