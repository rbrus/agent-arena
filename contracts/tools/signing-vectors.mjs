// Regenerate contracts/fixtures/signing_vectors.json (signing.md §6) after an edit to a signed schema example, and
// (2.4.0) contracts/fixtures/press_signing_vectors.json (signing.md §7) after an edit to a diplomacy_action example.
//
// Signs the RFC 8785 (JCS) bytes of each signed example, with /signing/signature removed, inside DSSE PAE,
// with the Ed25519 key of RFC 8032 §7.1 TEST 1. That key is a PUBLISHED TEST VECTOR (its private half is
// printed in the RFC); it is not, and must never become, a Sixi key. contract-check.mjs verifies the output.
//
// Run from the repo root: node contracts/tools/signing-vectors.mjs
//
// (2.9.0) Harness mode, signing.md §11.4 "Fixture": the fixture pack pins a PLACEHOLDER engine build (the hosted_context
// example's `engine_build_hash`), so a real runner refuses it with pack_engine_mismatch, by design. A harness that needs a
// loadable pack re-signs a COPY with its own build:
//   node contracts/tools/signing-vectors.mjs --engine-build sha256:<64 hex> --out <dir>
// writes <dir>/<pack id>/pack.dsse.json (pack_manifest examples[0] with engine.builds = [<build>], same test key and keyid)
// plus the variant files, prints the digests as JSON, and writes NOTHING under contracts/ (it refuses an --out there).
// The copy's envelope digest differs from fixtures/signing_vectors.json pack_vectors by construction.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const jcs = (v) => {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('JCS: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
};
const pae = (type, body) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `), body]);
const unsigned = (doc) => { const d = JSON.parse(JSON.stringify(doc)); delete d.signing.signature; return d; };
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

const RFC8032_TEST1_SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const RFC8032_TEST1_PUB = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
const x = RFC8032_TEST1_PUB.toString('base64url');
const priv = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: RFC8032_TEST1_SEED.toString('base64url'), x }, format: 'jwk' });
const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });

const example = (f, i) => JSON.parse(readFileSync(join(CONTRACTS, 'schemas', f), 'utf8')).examples[i];
const vectors = [];
for (const [f, i] of [['report.schema.json', 2], ['hosted_context.schema.json', 0], ['crosscheck_record.schema.json', 0]]) {
  const doc = example(f, i);
  const body = Buffer.from(jcs(unsigned(doc)), 'utf8');
  const type = doc.signing.payload_type;
  const sig = sign(null, pae(type, body), priv);
  if (!verify(null, pae(type, body), pub, sig)) throw new Error(`self-check failed for ${f}`);
  vectors.push({ document: `schemas/${f}#/examples/${i}`, payload_type: type, jcs_bytes: body.length, jcs_sha256: sha(body), signature: sig.toString('base64') });
}
// (2.5.0) deletion receipts (signing.md §9): a separate list, so readers of the three 2.2.0 vectors are unaffected.
const receiptVectors = [];
for (const [f, i] of [['deletion_receipt.schema.json', 0]]) {
  const doc = example(f, i);
  const body = Buffer.from(jcs(unsigned(doc)), 'utf8');
  const type = doc.signing.payload_type;
  const sig = sign(null, pae(type, body), priv);
  if (!verify(null, pae(type, body), pub, sig)) throw new Error(`self-check failed for ${f}`);
  receiptVectors.push({ document: `schemas/${f}#/examples/${i}`, payload_type: type, jcs_bytes: body.length, jcs_sha256: sha(body), signature: sig.toString('base64') });
}
// (2.6.0) scenario-pack envelope (signing.md §11): the DSSE envelope of pack_manifest examples[0], written as the
// fixture pack directory fixtures/packs/<id>/ (pack.dsse.json + the variant file the example pins by digest).
const PACK_TYPE = 'application/vnd.sixi.arena-pack+json';
const PACK_KEYID = 'sixi-arena-manifest-ed25519-20261101';
function packEnvelope(pm) {
  const payload = Buffer.from(jcs(pm), 'utf8');
  const sig = sign(null, pae(PACK_TYPE, payload), priv);
  if (!verify(null, pae(PACK_TYPE, payload), pub, sig)) throw new Error('self-check failed for the pack envelope');
  const envelope = `${JSON.stringify({ payloadType: PACK_TYPE, payload: payload.toString('base64'), signatures: [{ keyid: PACK_KEYID, sig: sig.toString('base64') }] }, null, 2)}\n`;
  return { payload, sig, envelope };
}
function checkVariants(pm, dir) {
  for (const sc of pm.scenarios.filter((s) => s.data)) {
    const got = sha(readFileSync(join(dir, sc.data.ref)));
    if (got !== sc.data.digest) throw new Error(`pack fixture: ${sc.data.ref} digests to ${got}, pack_manifest examples[0] pins ${sc.data.digest}`);
  }
}
// (2.9.0) harness mode: re-sign a copy of the fixture pack for another engine build; touches nothing under contracts/.
{
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const build = opt('--engine-build');
  if (build !== undefined || argv.includes('--out')) {
    const out = opt('--out');
    if (!/^sha256:[0-9a-f]{64}$/.test(build ?? '')) throw new Error('--engine-build needs sha256:<64 lower-case hex>');
    if (!out) throw new Error('--engine-build needs --out <dir> (outside contracts/)');
    const rel = relative(resolve(CONTRACTS), resolve(out));
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('--out must be outside contracts/: the fixture pack and the vectors are never overwritten in harness mode');
    const pm = example('pack_manifest.schema.json', 0);
    const src = join(CONTRACTS, 'fixtures', 'packs', pm.id);
    checkVariants(pm, src);
    pm.engine.builds = [build];
    const { payload, envelope } = packEnvelope(pm);
    const dst = join(resolve(out), pm.id);
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, 'pack.dsse.json'), envelope);
    for (const sc of pm.scenarios.filter((s) => s.data)) { mkdirSync(dirname(join(dst, sc.data.ref)), { recursive: true }); copyFileSync(join(src, sc.data.ref), join(dst, sc.data.ref)); }
    console.log(JSON.stringify({ id: pm.id, version: pm.version, engine_build: build, dir: dst, keyid: PACK_KEYID, payload_sha256: sha(payload), envelope_sha256: sha(envelope) }, null, 2));
    process.exit(0);
  }
}
const packVectors = [];
{
  const pm = example('pack_manifest.schema.json', 0);
  const dir = join(CONTRACTS, 'fixtures', 'packs', pm.id);
  checkVariants(pm, dir);
  const type = PACK_TYPE;
  const keyid = PACK_KEYID;
  const { payload, sig, envelope } = packEnvelope(pm);
  writeFileSync(join(dir, 'pack.dsse.json'), envelope);
  packVectors.push({
    document: 'schemas/pack_manifest.schema.json#/examples/0',
    envelope: `fixtures/packs/${pm.id}/pack.dsse.json`,
    payload_type: type,
    keyid,
    payload: 'JCS of the example (any JSON bytes are allowed; the signature is over the exact payload bytes)',
    payload_bytes: payload.length,
    payload_sha256: sha(payload),
    envelope_bytes: Buffer.byteLength(envelope),
    envelope_sha256: sha(envelope),
    signature: sig.toString('base64'),
    variants: pm.scenarios.filter((s) => s.data).map((s) => ({ scenario_id: s.id, base: s.base, file: `fixtures/packs/${pm.id}/${s.data.ref}`, digest: s.data.digest })),
    engine_builds_placeholder: true,
    note: 'engine.builds pins a placeholder build (the hosted_context example engine_build_hash), so a real runner refuses this pack with pack_engine_mismatch by design. A harness re-signs a copy for its own build: node contracts/tools/signing-vectors.mjs --engine-build sha256:<hex> --out <dir> (signing.md section 11.4).',
  });
}

// (2.6.0) run tokens (signing.md §10): compact JWS, header {alg: EdDSA, typ: at+jwt, kid?}, Ed25519 over the ASCII
// "header.payload" with the same test key. Every vector is validly signed by the key it names, so a reject is caused
// by the rule under test; `context` is what the verifier is configured with and what the request carries.
const runTokenVectors = [];
{
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const tkid = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url'); // RFC 7638
  const TEST2_SEED = Buffer.from('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex');
  const TEST2_PUB = Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex');
  const priv2 = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: TEST2_SEED.toString('base64url'), x: TEST2_PUB.toString('base64url') }, format: 'jwk' });
  const hc = example('hosted_context.schema.json', 0);
  const now = Math.floor(Date.parse('2026-11-10T14:00:00Z') / 1000);
  const deadline = Math.floor(Date.parse(hc.wall_clock_deadline) / 1000);
  const base = { iss: 'https://arena.sixi.example', aud: hc.verified_origin.origin, sub: hc.run_id, org: hc.org_ref, iat: now - 30, nbf: now - 30, exp: deadline + 300, jti: 'rtk_01JB5H0STED0EXAMP1E0000J1' };
  const ctx = { audience: hc.verified_origin.origin, issuer: 'https://arena.sixi.example', x_agent_arena_run: hc.run_id, now, pinned_keys: [{ key: 'test1', kid: tkid }] };
  const kidless = { ...ctx, pinned_keys: [{ key: 'test1', kid: null }] };
  const mk = (header, claims, key = priv) => {
    const input = `${b64(header)}.${b64(claims)}`;
    return `${input}.${sign(null, Buffer.from(input, 'ascii'), key).toString('base64url')}`;
  };
  const H = { alg: 'EdDSA', typ: 'at+jwt', kid: tkid };
  const add = (id, description, token, expect, context = ctx) => runTokenVectors.push({ id, description, context, token, expect });
  add('accept-full', 'every claim, header {alg, typ, kid}; exp = wall_clock_deadline + 5 minutes', mk(H, base), { result: 'accept', sub: base.sub, jti: base.jti });
  add('accept-minimal', 'no kid, no iss, no nbf, no iat, no org; verifier without an issuer; aud as a one-element array', mk({ alg: 'EdDSA', typ: 'at+jwt' }, { aud: [base.aud], sub: base.sub, exp: base.exp, jti: base.jti }), { result: 'accept', sub: base.sub, jti: base.jti }, { ...kidless, issuer: null });
  add('reject-no-kid-named-keys', 'the accept-minimal token against pinned keys that carry kids: a token without kid is checked only against kid-less pinned keys', mk({ alg: 'EdDSA', typ: 'at+jwt' }, { aud: [base.aud], sub: base.sub, exp: base.exp, jti: base.jti }), { result: 'reject', reason: 'unknown_kid' }, { ...ctx, issuer: null });
  add('accept-exp-within-skew', 'exp 30 s in the past: inside the 60 s skew', mk(H, { ...base, exp: now - 30 }), { result: 'accept', sub: base.sub, jti: base.jti });
  add('reject-typ-jwt', 'typ JWT instead of at+jwt', mk({ ...H, typ: 'JWT' }, base), { result: 'reject', reason: 'bad_header' });
  add('reject-typ-missing', 'no typ member', mk({ alg: 'EdDSA', kid: tkid }, base), { result: 'reject', reason: 'bad_header' });
  add('reject-header-jwk', 'an embedded jwk header member (the key never comes from the token)', mk({ ...H, jwk: { kty: 'OKP', crv: 'Ed25519', x } }, base), { result: 'reject', reason: 'bad_header' });
  add('reject-alg', 'alg ES256', mk({ ...H, alg: 'ES256' }, base), { result: 'reject', reason: 'bad_header' });
  add('reject-unknown-kid', 'kid names no pinned key', mk({ ...H, kid: 'EXAMPLE-unpinned-kid' }, base), { result: 'reject', reason: 'unknown_kid' });
  add('reject-other-key', 'signed by another key (RFC 8032 TEST 2) without a kid', mk({ alg: 'EdDSA', typ: 'at+jwt' }, base, priv2), { result: 'reject', reason: 'bad_signature' }, kidless);
  add('reject-aud-other-origin', 'aud names another origin', mk(H, { ...base, aud: 'https://other.example.com' }), { result: 'reject', reason: 'aud' });
  add('reject-aud-with-path', 'aud is a URL with a path, not the origin', mk(H, { ...base, aud: `${base.aud}/act` }), { result: 'reject', reason: 'aud' });
  add('reject-sub-not-run-id', 'sub is not a run id', mk(H, { ...base, sub: 'org_EXAMPLE0000001' }), { result: 'reject', reason: 'sub' });
  add('reject-sub-other-run', 'a token of another run, presented with this run header (replay across runs)', mk(H, { ...base, sub: 'run_01JB5H0STED0EXAMP1E00000R3' }), { result: 'reject', reason: 'run_binding' });
  add('reject-expired', 'exp 61 s in the past', mk(H, { ...base, exp: now - 61 }), { result: 'reject', reason: 'exp' });
  add('reject-exp-missing', 'no exp', mk(H, Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'exp'))), { result: 'reject', reason: 'exp' });
  // (2.7.0) lifetime cap: exp − iat ≤ 3600 and exp − now ≤ 3600 + 60 (each vector breaks exactly one bound).
  { const iat = now + 1800 - 7200; add('reject-lifetime-2h', 'a 2 h token: exp − iat = 7200 (> 3600), while exp is only 30 minutes ahead, so only the from-issue bound fails', mk(H, { ...base, iat, nbf: iat, exp: now + 1800 }), { result: 'reject', reason: 'exp' }); }
  { const { iat: _i, nbf: _n, ...noIat } = base; add('reject-exp-90min-ahead', 'no iat; exp 90 minutes ahead: exp − now = 5400 > 3600 + 60, so only the from-now bound fails', mk(H, { ...noIat, exp: now + 5400 }), { result: 'reject', reason: 'exp' }); }
  add('reject-nbf-future', 'nbf 61 s in the future', mk(H, { ...base, nbf: now + 61 }), { result: 'reject', reason: 'nbf' });
  add('reject-jti-missing', 'no jti', mk(H, Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'jti'))), { result: 'reject', reason: 'jti' });
  add('reject-jti-short', 'jti of 7 characters', mk(H, { ...base, jti: 'rtk_123' }), { result: 'reject', reason: 'jti' });
  add('reject-iss', 'iss differs from the configured issuer', mk(H, { ...base, iss: 'https://issuer.example.com' }), { result: 'reject', reason: 'iss' });
  {
    const t = mk(H, base);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const i = A.indexOf(t.at(-1));
    add('reject-noncanonical-signature', 'the accept-full token with a non-canonical last base64url character (same 64 bytes after lenient decoding)', t.slice(0, -1) + A[(i & ~3) | ((i & 3) ^ 1)], { result: 'reject', reason: 'malformed' });
  }
  for (const v of runTokenVectors) {
    const [h, p, s] = v.token.split('.');
    const k = v.id === 'reject-other-key' ? createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: TEST2_PUB.toString('base64url') }, format: 'jwk' }) : pub;
    if (v.id !== 'reject-noncanonical-signature' && !verify(null, Buffer.from(`${h}.${p}`, 'ascii'), k, Buffer.from(s, 'base64url'))) throw new Error(`self-check failed for run-token vector ${v.id}`);
  }
}

const out = {
  description: 'Contract test vectors for signing.md (contracts 2.2.0). Each vector signs the JCS (RFC 8785) bytes of the named schema example with /signing/signature removed, wrapped in DSSE PAE with the payload type, using the Ed25519 key of RFC 8032 section 7.1 TEST 1. That key is a published test vector, not a Sixi key; the examples keep their own placeholder signing_key_id and an EXAMPLE placeholder signature, which is outside the signed bytes by construction. contract-check recomputes every jcs_sha256, verifies every signature, and checks that changing any signed member breaks it.',
  key: { source: 'RFC 8032 section 7.1 TEST 1', jwk: { kty: 'OKP', crv: 'Ed25519', x } },
  run_manifest_digest: { document: 'schemas/hosted_context.schema.json#/examples/0', digest: sha(jcs(unsigned(example('hosted_context.schema.json', 0)))) },
  vectors,
  receipt_vectors: receiptVectors,
  pack_vectors: packVectors,
  run_token_vectors: runTokenVectors,
};
writeFileSync(join(CONTRACTS, 'fixtures', 'signing_vectors.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors, ${receiptVectors.length} receipt, ${packVectors.length} pack, ${runTokenVectors.length} run-token`);

// ---------------------------------------------------------------- press signatures (signing.md §7, contracts 2.4.0)
// Detached compact JWS (RFC 7515 Appendix F) over the RFC 8785 bytes of the eight-member press payload, same test key.
// Every vector carries `signed_payload`: the exact payload bytes the SIGNER used. contract-check proves each JWS is a
// valid Ed25519 signature over `header "." b64url(signed_payload)` (so a reject is caused by the rule under test, never
// by a broken vector), then rebuilds the payload from `context` + `message` as a verifier must and compares the verdict.
const b64u = (s) => Buffer.from(s).toString('base64url');
const kid = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url'); // RFC 7638
const act = (i) => example('diplomacy_action.schema.json', i);
const strip = (m) => { const c = JSON.parse(JSON.stringify(m)); delete c.signature; return c; };
const offerMsg = strip(act(1).press[0]);
const renounceMsg = strip(act(3).press[0]);
const acceptMsg = strip(act(3).press[1]);
const EPI = act(1).episode_id;
const payloadOf = (ctx, m) => ({
  scenario: 'diplomacy',
  episode_id: ctx.episode_id,
  msg_id_expected: `prs:${ctx.phase}:r${ctx.round}:${ctx.power}:${ctx.index + 1}`,
  from: ctx.power,
  to: m.to,
  move: m.move,
  respond_to: m.respond_to ?? null,
  terms_hash: m.move === 'offer' || m.move === 'counter' ? sha(jcs(m.terms)) : null,
});
// The contract's LISTED order (documentation order), serialised as-is: what a signer that skips JCS produces.
const listedOrder = (p) => JSON.stringify({ scenario: p.scenario, episode_id: p.episode_id, msg_id_expected: p.msg_id_expected, from: p.from, to: p.to, move: p.move, respond_to: p.respond_to, terms_hash: p.terms_hash });
const jws = (header, payloadBytes) => {
  const h = b64u(JSON.stringify(header));
  const input = `${h}.${b64u(payloadBytes)}`;
  return `${h}..${sign(null, Buffer.from(input, 'ascii'), priv).toString('base64url')}`;
};
const ctxOffer = { episode_id: EPI, phase: 'S1902M', round: 2, power: 'germany', index: 0 };
const ctxRenounce = { episode_id: EPI, phase: 'F1902M', round: 2, power: 'germany', index: 0 };
const ctxAccept = { episode_id: EPI, phase: 'F1902M', round: 2, power: 'germany', index: 1 };
const H = { alg: 'EdDSA', kid };
const press = [];
const add = (id, description, context, message, header, signedPayload, expect) => {
  press.push({ id, description, context, message, header, signed_payload: signedPayload, jws: jws(header, signedPayload), expect });
};
const canonical = (ctx, m) => jcs(payloadOf(ctx, m));
add('accept-offer-key', 'offer (terms_hash over JCS(terms) as sent), header {alg, kid}', ctxOffer, offerMsg, H, canonical(ctxOffer, offerMsg), { result: 'accept' });
add('accept-accept-key', 'accept (terms_hash null, respond_to = the offer id as sent), seq 2 = batch position 2', ctxAccept, acceptMsg, H, canonical(ctxAccept, acceptMsg), { result: 'accept' });
add('accept-renounce-no-kid', 'renounce (respond_to = the cmt id), header {alg} only: kid is optional', ctxRenounce, renounceMsg, { alg: 'EdDSA' }, canonical(ctxRenounce, renounceMsg), { result: 'accept' });
add('accept-typ', 'header with typ: an allowed member, not interpreted', ctxOffer, offerMsg, { alg: 'EdDSA', kid, typ: 'JOSE' }, canonical(ctxOffer, offerMsg), { result: 'accept' });
add('reject-header-jwk', 'forged header member: an embedded jwk (the verifier must never take the key from the header)', ctxOffer, offerMsg, { alg: 'EdDSA', kid, jwk: { kty: 'OKP', crv: 'Ed25519', x } }, canonical(ctxOffer, offerMsg), { result: 'reject', reason: 'bad_header' });
add('reject-header-crit-b64', 'forged header members: crit + b64 (RFC 7797 unencoded payload is not accepted)', ctxOffer, offerMsg, { alg: 'EdDSA', b64: false, crit: ['b64'] }, canonical(ctxOffer, offerMsg), { result: 'reject', reason: 'bad_header' });
add('reject-header-alg', 'alg other than EdDSA', ctxOffer, offerMsg, { alg: 'ES256', kid }, canonical(ctxOffer, offerMsg), { result: 'reject', reason: 'bad_header' });
add('reject-kid-mismatch', 'header kid differs from the passport key kid', ctxOffer, offerMsg, { alg: 'EdDSA', kid: 'EXAMPLE-another-key-kid-00000000000000000000' }, canonical(ctxOffer, offerMsg), { result: 'reject', reason: 'kid_mismatch' });
add('reject-field-order', 'payload serialised in the listed field order instead of RFC 8785 (JCS) order', ctxOffer, offerMsg, H, listedOrder(payloadOf(ctxOffer, offerMsg)), { result: 'reject', reason: 'bad_signature' });
add('reject-scenario-id', 'payload scenario "diplomacy_standard" (the scenario id) instead of the literal "diplomacy"', ctxOffer, offerMsg, H, jcs({ ...payloadOf(ctxOffer, offerMsg), scenario: 'diplomacy_standard' }), { result: 'reject', reason: 'bad_signature' });
add('reject-abbreviated-power', 'msg_id_expected with the engine three-letter power (GER) instead of the full name', ctxOffer, offerMsg, H, jcs({ ...payloadOf(ctxOffer, offerMsg), msg_id_expected: 'prs:S1902M:r2:GER:1' }), { result: 'reject', reason: 'bad_signature' });
add('reject-moved-position', 'a signature made for batch position 2, sent at position 1 (replay to another seq)', ctxOffer, offerMsg, H, canonical({ ...ctxOffer, index: 1 }, offerMsg), { result: 'reject', reason: 'bad_signature' });
add('reject-other-episode', 'a signature captured in another episode', ctxOffer, offerMsg, H, canonical({ ...ctxOffer, episode_id: 'epi_01J9D1PX0MACY0EXAMP1E00001' }, offerMsg), { result: 'reject', reason: 'bad_signature' });
add('reject-terms-hash-null-omitted', 'accept payload that omits the null members instead of carrying them as null', ctxAccept, acceptMsg, H, jcs(Object.fromEntries(Object.entries(payloadOf(ctxAccept, acceptMsg)).filter(([, v]) => v !== null))), { result: 'reject', reason: 'bad_signature' });
// G-34 (security review): exactly one accepted encoding. Same signature bytes, last character with different unused
// low bits: a non-canonical base64url spelling that a lenient decoder maps to the same 64 bytes.
{
  const base = press.find((v) => v.id === 'accept-offer-key');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const i = A.indexOf(base.jws.at(-1));
  const alt = A[(i & ~3) | ((i & 3) ^ 1)];
  press.push({ ...base, id: 'reject-noncanonical-signature', description: 'the accepted offer signature re-spelled with a non-canonical last base64url character (same 64 bytes after lenient decoding; security review G-34)', jws: base.jws.slice(0, -1) + alt, expect: { result: 'reject', reason: 'malformed' } });
}
for (const v of press) {
  const [h, , s] = v.jws.split('.');
  if (!verify(null, Buffer.from(`${h}.${b64u(v.signed_payload)}`, 'ascii'), pub, Buffer.from(s, 'base64url'))) throw new Error(`self-check failed for press vector ${v.id}`);
}
const pressOut = {
  description: 'Contract test vectors for signing.md section 7 (press signatures, contracts 2.4.0). Each vector is a detached compact JWS (RFC 7515 Appendix F, alg EdDSA) made with the Ed25519 key of RFC 8032 section 7.1 TEST 1, a published test vector and never a passport or Sixi key. signed_payload is the exact payload the signer used; a verifier never reads it: it rebuilds the payload from context and message (signing.md section 7.3) and must reach expect. Every JWS is a valid Ed25519 signature over its own header and signed_payload, so each reject is caused by the rule it names. The messages are the diplomacy_action schema examples without their placeholder signatures. Regenerate with node contracts/tools/signing-vectors.mjs.',
  key: { source: 'RFC 8032 section 7.1 TEST 1', jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' } },
  sources: { offer: 'schemas/diplomacy_action.schema.json#/examples/1/press/0', renounce: 'schemas/diplomacy_action.schema.json#/examples/3/press/0', accept: 'schemas/diplomacy_action.schema.json#/examples/3/press/1' },
  vectors: press,
};
writeFileSync(join(CONTRACTS, 'fixtures', 'press_signing_vectors.json'), `${JSON.stringify(pressOut, null, 2)}\n`);
console.log(`wrote ${press.length} press vectors`);
