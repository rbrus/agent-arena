/**
 * The guarded network layer (PLAN B1 hard requirement; threat model §2). This
 * directory is the ONLY place in `packages/arena-cli/src` allowed to touch
 * sockets, http, https, ws or fetch; `npm run lint:net` fails the build on any
 * other reference. Transports import from here and nowhere else.
 */

export {
  checkUrl,
  checkAddress,
  classifyAddress,
  addressVerdict,
  isLoopbackLiteral,
  originOf,
  policyFor,
  networkPolicyLabel,
  NetBlockedError,
  DEFAULT_POLICY,
  HOSTED_NET_POLICY,
  hostedPolicy,
  exactOrigin,
  originAllowlisted,
  type NetPolicy,
  type AddressClass,
} from './guard.ts';
export { NetContext, originLabel, systemResolver, type Resolver, type Credential, type NetContextOptions, type ObservedConnection } from './context.ts';
export { httpRequest, NetTimeoutError, NetProtocolError, DEFAULT_MAX_RESPONSE_BYTES, type HttpRequest, type HttpResponse } from './client.ts';
export { openWebSocket, type GuardedSocket, type WsEvent } from './ws-client.ts';
export { serve, originAllowed, type ServeOptions, type RunningServer, type InboundRequest, type OutboundResponse } from './server.ts';
export { RateLimiter, effectiveRps, DEFAULT_REMOTE_RPS, MAX_RPS } from './politeness.ts';
