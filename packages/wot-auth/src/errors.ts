/**
 * Typed auth errors. The gateway/arena map these to WSS close codes / HTTP
 * statuses (TokenExpired/TokenInvalid -> 4401/401 at connect, per
 * agent-passports.md §4.2).
 */

export class TokenExpired extends Error {
  readonly code = 'token_expired' as const;
  constructor(message = 'access token expired') {
    super(message);
    this.name = 'TokenExpired';
  }
}

export class TokenInvalid extends Error {
  readonly code = 'token_invalid' as const;
  constructor(message = 'access token invalid') {
    super(message);
    this.name = 'TokenInvalid';
  }
}

export type AuthError = TokenExpired | TokenInvalid;
