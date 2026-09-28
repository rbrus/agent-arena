/**
 * `agent-arena serve-reference`: the included reference agent as a local
 * target over REST, WS, MCP and A2A on one port (`npm run target:reference`).
 *
 * diplomacy_standard: `--policy robust|credulous|injector|house` (coordinated /
 * naive are aliases of robust / credulous), `--agent-seed` = the served agents'
 * tie-break salt (default 20261115, the goldens' seed; see reference/diplomacy.ts).
 *
 * `--ownership-token <sixi-verify=…>` (env ARENA_OWNERSHIP_TOKEN; the flag wins) also serves
 * the Sixi Arena ownership proof at GET /.well-known/sixi-verify (reference/ownership-proof.ts).
 * Off by default; the value is never printed.
 */

import { SCENARIO_IDS } from 'arena-scenarios';
import { DIPLOMACY } from '../diplomacy.ts';
import { misconfig } from '../errors.ts';
import { DIP_DEFAULT_AGENT_SEED, DIP_SERVED_POLICIES } from '../reference/diplomacy.ts';
import { dipPolicyOf, referenceNames, type ServePolicy } from '../reference/policy.ts';
import { OWNERSHIP_PROOF_PATH, resolveOwnershipToken } from '../reference/ownership-proof.ts';
import { startReferenceServer, type ReferenceServer } from '../reference/serve.ts';
import type { HostedReferenceOptions } from '../reference/run-token.ts';
import { loadPublicKeySet } from '../keys.ts';
import { info, isJson, out, outJson, warn } from '../ui.ts';

export interface ServeFlags {
  scenario?: string;
  seat?: string;
  policy?: string;
  port?: string;
  host?: string;
  /** diplomacy_standard: the served agents' tie-break salt (uint32). */
  agentSeed?: string;
  /** Explicit opt-in for any --host other than loopback (G-27). */
  allowNonLoopback?: boolean;
  /** G-39: browser origins allowed to call the server (exact `scheme://host[:port]`); default none. */
  allowOrigin?: string[];
  /** Hosted reference mode (cross-check leg H; I-7): Host allowlist + `sixi_run_token` verification. */
  hosted?: boolean;
  /** --hosted: the verified origin this reference target is served on (`https://host[:port]`). */
  verifiedOrigin?: string;
  /** --hosted: the pinned run-token key (PEM, OKP JWK or JWKS). */
  runTokenKey?: string;
  /** --hosted: the expected `iss` of run tokens (optional). */
  runTokenIssuer?: string;
  /** --hosted: refuse requests without a run token (default: tokenless requests are served, for the open legs). */
  requireRunToken?: boolean;
  /** Sixi ownership token (`sixi-verify=` + 32 hex) served at /.well-known/sixi-verify; wins over the env. */
  ownershipToken?: string;
  /** Where ARENA_OWNERSHIP_TOKEN is read from (default process.env). */
  env?: Record<string, string | undefined>;
}

const VERIFIED_ORIGIN = /^(https|wss):\/\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*(:[0-9]{1,5})?$/;

function hostedOptions(f: ServeFlags): HostedReferenceOptions | undefined {
  const any = f.verifiedOrigin !== undefined || f.runTokenKey !== undefined || f.runTokenIssuer !== undefined || !!f.requireRunToken;
  if (!f.hosted) {
    if (any) throw misconfig('--verified-origin, --run-token-key, --run-token-issuer and --require-run-token belong to --hosted.', 'add --hosted, or drop them for a local reference target.');
    return undefined;
  }
  if (!f.verifiedOrigin || !VERIFIED_ORIGIN.test(f.verifiedOrigin)) throw misconfig('--hosted needs --verified-origin https://host[:port] (the origin the Sixi manifest verified; lower-case, no path).', 'e.g. --verified-origin https://xcheck-ref.example.com');
  if (!f.runTokenKey) throw misconfig('--hosted needs --run-token-key: the public key(s) Sixi run tokens are signed with (PEM, OKP JWK or JWKS).', 'pass the published run-token JWKS file.');
  if (f.runTokenIssuer !== undefined && !/^[\x21-\x7e]{1,256}$/.test(f.runTokenIssuer)) throw misconfig('--run-token-issuer must be a printable string without spaces.');
  return { verifiedOrigin: f.verifiedOrigin, runTokenKeys: loadPublicKeySet(f.runTokenKey, '--run-token-key'), requireToken: !!f.requireRunToken, ...(f.runTokenIssuer ? { issuer: f.runTokenIssuer } : {}) };
}

/** An exact web origin: scheme, host, optional port; no path, no wildcard, not `null`. */
const ORIGIN = /^https?:\/\/(?:[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

export async function serveReferenceCommand(f: ServeFlags): Promise<ReferenceServer> {
  if (f.scenario !== undefined && !SCENARIO_IDS.includes(f.scenario as never)) throw misconfig(`unknown scenario "${f.scenario.slice(0, 40)}".`, `pick one of: ${SCENARIO_IDS.join(', ')}.`);
  const isDip = f.scenario === DIPLOMACY;
  const policy = (f.policy ?? (isDip ? 'robust' : 'coordinated')) as ServePolicy;
  if (isDip) {
    if (!['coordinated', 'naive', ...DIP_SERVED_POLICIES].includes(policy)) throw misconfig(`--policy for ${DIPLOMACY} is ${DIP_SERVED_POLICIES.join(', ')}.`);
    if (f.seat !== undefined) throw misconfig('--seat does not apply to a served Diplomacy reference: it plays whichever power the arena seats it at.', 'pick the power on the run side: agent-arena run --scenario diplomacy_standard --seat <power>|auto.');
  } else {
    if (policy !== 'coordinated' && policy !== 'naive') {
      throw misconfig(
        `--policy ${String(policy).slice(0, 20)} is a ${DIPLOMACY} reference.`,
        (DIP_SERVED_POLICIES as readonly string[]).includes(policy) ? `add --scenario ${DIPLOMACY}, or use --policy coordinated|naive.` : '--policy is coordinated or naive.',
      );
    }
    if (f.agentSeed !== undefined) throw misconfig(`--agent-seed applies to --scenario ${DIPLOMACY} only.`);
  }
  let agentSeed = DIP_DEFAULT_AGENT_SEED;
  if (f.agentSeed !== undefined) {
    if (!/^\d{1,10}$/.test(f.agentSeed) || Number(f.agentSeed) > 0xffffffff) throw misconfig('--agent-seed must be a uint32.', `e.g. --agent-seed ${DIP_DEFAULT_AGENT_SEED} (the default, the engine goldens' seed).`);
    agentSeed = Number(f.agentSeed);
  }
  if (f.seat !== undefined && !['squad', 'member', 'duel'].includes(f.seat)) throw misconfig('--seat is squad, member or duel.');
  if (f.seat === 'member') warn('member seating: the reference squads plan jointly over all five views, so a single member only approximates them (use --seat squad to reproduce the golden anchors).');
  const port = f.port === undefined ? 8080 : Number(f.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw misconfig('--port must be 0..65535 (0 = any free port).');
  const host = f.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.includes(host)) {
    if (!f.allowNonLoopback) {
      throw misconfig(
        `--host ${host.slice(0, 64)} would make the reference agent reachable from other machines; serve-reference binds loopback only by default.`,
        'drop --host (127.0.0.1), or add --allow-non-loopback if you really want it on the network (e.g. inside a container).',
      );
    }
    warn(`binding ${host} (--allow-non-loopback): the reference agent is reachable from other machines.`);
  }
  const allowedOrigins = f.allowOrigin ?? [];
  for (const o of allowedOrigins) {
    if (!ORIGIN.test(o)) throw misconfig(`--allow-origin ${o.slice(0, 80)} is not an exact origin.`, 'give scheme://host[:port] with no path or wildcard, e.g. --allow-origin http://localhost:5173.');
  }
  if (allowedOrigins.length) warn(`--allow-origin: web pages from ${allowedOrigins.join(', ')} can drive this reference agent from a browser.`);
  const hosted = hostedOptions(f);
  const ownershipToken = resolveOwnershipToken(f.ownershipToken, f.env ?? process.env);
  if (hosted) info(`hosted reference: Host must name ${hosted.verifiedOrigin}; run tokens verified (${hosted.runTokenKeys.length} pinned key(s))${hosted.requireToken ? ', required' : '; tokenless requests are served (open legs)'}`);
  let server: ReferenceServer;
  try {
    server = await startReferenceServer({ port, host: host === 'localhost' ? '127.0.0.1' : host, policy, scenario: f.scenario, allowedOrigins, ...(isDip ? { agentSeed } : {}), ...(hosted ? { hosted } : {}), ...(ownershipToken !== undefined ? { ownershipToken } : {}) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw misconfig(`cannot listen on ${host}:${port} (${code ?? 'error'}).`, code === 'EADDRINUSE' ? 'pick another --port, or stop what is using it.' : 'check --host and --port.');
  }
  const names = referenceNames()[f.scenario ?? 'byzantine'];
  const dipName = { robust: 'robust-diplomat', credulous: 'credulous-diplomat', injector: 'injector', house: 'house-diplomat' }[dipPolicyOf(policy)];
  const shown = isDip ? `${policy}: ${dipName}, tie-break salt ${agentSeed}` : `${policy}${f.scenario ? `: ${names?.[policy as 'coordinated']}` : ''}`;
  if (isJson()) outJson({ ok: true, policy, scenario: f.scenario ?? 'any', port: server.port, urls: server.urls, ...(isDip ? { agent_seed: agentSeed } : {}), ...(ownershipToken !== undefined ? { ownership_proof: OWNERSHIP_PROOF_PATH } : {}) });
  else {
    out(`reference agent (${shown}, scripted, no model) on ${host}:${server.port}`);
    out(`  rest  ${server.urls.rest}`);
    out(`  ws    ${server.urls.ws}`);
    out(`  mcp   ${server.urls.mcp}   (tool arena_act)`);
    out(`  a2a   ${server.urls.a2a}`);
    out(`  health ${server.urls.healthz}`);
    if (ownershipToken !== undefined) out(`  proof ${server.urls.healthz.replace(/\/healthz$/, OWNERSHIP_PROOF_PATH)}   (Sixi ownership token; value not shown)`);
    info(
      isDip
        ? `try: agent-arena run --scenario ${DIPLOMACY} --seat germany --fill table:commitment --horizon 1904 --seeds ${agentSeed} --target ${server.urls.rest.replace(/\/$/, '')}`
        : `try: agent-arena run --scenario ${f.scenario ?? 'byzantine'} --seat squad --target ${server.urls.rest.replace(/\/$/, '')}`,
    );
    if (isDip) info(`the served diplomat reproduces the in-process ref:${dipPolicyOf(policy)} exactly on episodes whose seed is ${agentSeed} (its tie-break salt); other seeds are played by an equally deterministic agent`);
  }
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}
