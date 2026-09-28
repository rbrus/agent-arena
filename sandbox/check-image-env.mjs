/**
 * Assert that the image's environment is one the hosted runner and the Sixi promotion accept
 * (contracts/fixtures/hosted_env.json, signing.md §3.1-§3.1.3; security review SX-9).
 *
 *   node check-image-env.mjs <hosted_env.json> [--config-env <file>]
 *
 * verify.sh runs it INSIDE the image with no extra -e flags, so process.env is the image's ENV plus what
 * `docker run` itself adds (PATH, HOSTNAME, HOME). Two checks on that process env, as `run --hosted` makes them:
 *   1. no must_be_absent variable is set (an ENV line that sets one makes every hosted run refuse);
 *   2. the guarded name families (ARENA_*, NODE_*, SSL*, OPENSSL*, proxies): each one set is a job-template name,
 *      or an allowed_values name with exactly its value (NODE_ENV=production; since 2.15.0
 *      SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt, the distroless CA bundle).
 * With --config-env <file> (the JSON array of `docker image inspect --format '{{json .Config.Env}}'`), a third:
 *   3. the image config Env holds only PATH, HOME, NODE_VERSION and the names hosted_env.json allows (allowed, and
 *      allowed_values with their value), no ARENA_* name and no loader or resolver variable. It is the rule of the
 *      Sixi promotion's image-Env check (SX-9), so an image that fails here would be refused there.
 * Imports only node:fs. Names only, never values. Exit 0 = clean, 1 = a finding, 2 = usage or input error.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const path = args[0];
const ci = args.indexOf('--config-env');
const configPath = ci > 0 ? args[ci + 1] : undefined;
if (!path || (ci > 0 && !configPath)) {
  process.stderr.write('check-image-env: usage: check-image-env.mjs <hosted_env.json> [--config-env <file>]\n');
  process.exit(2);
}
let doc;
try {
  doc = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  process.stderr.write(`check-image-env: cannot read ${path}: ${e.message}\n`);
  process.exit(2);
}
const rules = doc.must_be_absent;
const gf = doc.guarded_families;
if (!Array.isArray(rules) || rules.length === 0 || !gf || !Array.isArray(gf.allowed) || !Array.isArray(gf.allowed_values)) {
  process.stderr.write(`check-image-env: ${path} has no must_be_absent[] or guarded_families\n`);
  process.exit(2);
}
const allowedValue = Object.fromEntries(gf.allowed_values.map((a) => [a.name, a.value]));
const families = new RegExp(`(?:${gf.families.join('|')})`, 'i');
const proxy = new RegExp(gf.proxy, 'i');
const secrets = (doc.secrets ?? []).map((s) => new RegExp(s.pattern));
const absentRe = (r) => (r.pattern ? new RegExp(r.pattern) : null);

const hits = [];
// 1. must be absent
for (const r of rules) {
  const re = absentRe(r);
  for (const [name, value] of Object.entries(process.env)) {
    if (re ? !re.test(name) : name !== r.name) continue;
    if (r.unless === 'empty' && value === '') continue;
    hits.push(`${name} (must be absent: ${r.field ?? 'environment'})`);
  }
}
// 2. guarded families
const listed = new Set(rules.map((r) => r.name));
for (const [name, value] of Object.entries(process.env)) {
  if (listed.has(name) || rules.some((r) => r.pattern && new RegExp(r.pattern).test(name))) continue;
  if (!families.test(name) && !proxy.test(name)) continue;
  if (Object.hasOwn(allowedValue, name)) {
    if (value !== allowedValue[name]) hits.push(`${name} (guarded family: accepted only with the value hosted_env.json names)`);
    continue;
  }
  if (gf.allowed.includes(name) || secrets.some((re) => re.test(name))) continue;
  hits.push(`${name} (guarded family: not a hosted job-template name)`);
}
// 3. the image config Env (Sixi promotion rule, SX-9)
let configCount = 0;
if (configPath) {
  let env;
  try {
    env = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`check-image-env: cannot read ${configPath}: ${e.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(env)) {
    process.stderr.write(`check-image-env: ${configPath} is not a JSON array of NAME=value\n`);
    process.exit(2);
  }
  const base = new Set(['PATH', 'HOME', 'NODE_VERSION']);
  const seen = new Set();
  for (const kv of env) {
    configCount++;
    const i = String(kv).indexOf('=');
    const name = i > 0 ? kv.slice(0, i) : '';
    const value = i > 0 ? kv.slice(i + 1) : '';
    const up = name.toUpperCase();
    if (!name) hits.push('(an image Env entry without a name)');
    else if (seen.has(up)) hits.push(`${name} (image Env: set twice)`);
    else if (up.startsWith('LD_') || ['HOSTALIASES', 'RES_OPTIONS', 'LOCALDOMAIN'].includes(up)) hits.push(`${name} (image Env: loader or resolver variable)`);
    else if (up === 'NODE_OPTIONS') { if (value !== '' || up !== name) hits.push(`${name} (image Env: only an empty NODE_OPTIONS)`); }
    else if (up.startsWith('ARENA_')) hits.push(`${name} (image Env: the job template decides every ARENA_ variable)`);
    else if (base.has(name) || gf.allowed.includes(name)) { /* ok */ }
    else if (Object.hasOwn(allowedValue, name) && allowedValue[name] === value) { /* ok */ }
    else hits.push(`${name} (image Env: outside the hosted_env.json allow-list plus PATH, HOME, NODE_VERSION)`);
    seen.add(up);
  }
}
if (hits.length) {
  console.log(`IMAGE ENV FAIL: ${hits.length} finding(s): ${hits.join(', ')}`);
  process.exit(1);
}
console.log(
  `IMAGE ENV OK: none of the ${rules.length} must-be-absent hosted variables is set, every guarded-family variable is accepted` +
    (configPath ? `, and the ${configCount} image config Env entries are all allowed (SX-9)` : ''),
);
