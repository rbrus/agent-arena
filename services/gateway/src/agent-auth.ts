/**
 * Agent-plane authentication + scope enforcement for the gateway (management
 * plane, REST). The agent presents its RFC 9068 `at+jwt` access token as
 * `Authorization: Bearer <jwt>`; scope claims gate each route
 * (agent-passports §3.4). Reserved claims (`parent_agent_id`/`act`) must verify
 * normally (§2.3).
 */

import type { NextFunction, Request, Response } from 'express';
import { hasScope, verifyAccessToken, type AccessClaims } from 'wot-auth';
import { sendError } from './lib.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      requestId?: string;
      startTime?: number;
      claims?: AccessClaims;
    }
  }
}

function bearer(req: Request): string | null {
  const authz = req.get('authorization');
  if (!authz || !authz.startsWith('Bearer ')) return null;
  const token = authz.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Express middleware factory: verify the access token and assert `requiredScope`
 * is present. 401 `unauthenticated` for a missing/invalid/expired token; 403
 * `insufficient_scope` for a valid token lacking the scope (RFC 6750 challenge
 * headers on both). Verified claims land on `res.locals.claims`.
 */
export function requireAgentScope(requiredScope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      sendError(res, 'unauthenticated', 'A valid bearer token is required.');
      return;
    }
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(token);
    } catch {
      sendError(res, 'unauthenticated', 'The access token is invalid or expired.');
      return;
    }
    if (!hasScope(claims, requiredScope)) {
      sendError(res, 'insufficient_scope', `This operation requires the '${requiredScope}' scope.`, {
        wwwAuthenticate: `Bearer error="insufficient_scope", scope="${requiredScope}"`,
      });
      return;
    }
    res.locals.claims = claims;
    next();
  };
}
