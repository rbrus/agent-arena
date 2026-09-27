/**
 * G-45 (docs/phase-9/SECURITY-REVIEW-HOSTED.md; threat-model-hosted §2.4, HT-2.9):
 * hosted logs name the run, never the customer's origin. stdout and stderr of
 * the hosted job are Cloud Logging, readable by more people than the customer's
 * evidence bundle, so while a hosted run is active EVERY byte ui.ts writes to
 * either stream passes `scrubHostedText`, which replaces
 *
 *   - the verified origin in every spelling (`https://host:443`, `https://host`,
 *     `wss://…`, `host:port`, `host`, case-insensitive), and
 *   - every address the run resolved or connected to for it (added as they are
 *     seen: `NetContext` `onPeerAddress`),
 *
 * with `<verified origin>`. This is a log-sink filter, not the Redactor: the
 * report and the bundle keep the origin (it is the evidence). Errors that leave
 * `runHostedCommand` are passed through `scrubHostedError` as well (defence in
 * depth for programmatic callers that uninstall the filter).
 *
 * G-57: ui.ts filters before a line is cut to its cap and again after, not only
 * at the write, so a host straddling a cap never prints as a prefix.
 * G-58: once installed for a hosted run, the filter stays until process exit; the
 * run never uninstalls it. `uninstall()` exists for the holder of the handle only
 * (tests, via `HostedOptions.onLogFilter`).
 *
 * No network code here (lint:net): this module only rewrites strings.
 */

import { CliError, describeError, runError } from '../errors.ts';

export const VERIFIED_ORIGIN_PLACEHOLDER = '<verified origin>';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

class HostScrub {
  private readonly hosts = new Set<string>();
  private readonly addresses = new Set<string>();
  private re: RegExp | null = null;

  addHost(host: string): void {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h || this.hosts.has(h)) return;
    this.hosts.add(h);
    this.re = null;
  }

  addAddress(address: string): void {
    const a = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
    if (!a || this.addresses.has(a)) return;
    this.addresses.add(a);
    if (a !== address.toLowerCase()) this.addresses.add(address.toLowerCase());
    this.re = null;
  }

  private pattern(): RegExp | null {
    if (this.re) return this.re;
    const alts: string[] = [];
    // Longest first: scheme + host (+ optional trailing dot, optional port), host:port, bare host.
    for (const h of [...this.hosts].sort((a, b) => b.length - a.length)) {
      const bare = esc(h);
      const hostForm = h.includes(':') ? `\\[?${bare}\\]?` : `${bare}\\.?`;
      alts.push(`(?:(?:https?|wss?):\\/\\/)?${hostForm}(?::\\d{1,5})?`);
    }
    for (const a of [...this.addresses].sort((x, y) => y.length - x.length)) {
      const bare = esc(a);
      // Address boundaries: not part of a longer number, name or IPv6 literal.
      alts.push(a.includes(':') ? `(?<![0-9a-f:])\\[?${bare}\\]?(?![0-9a-f:])` : `(?<![0-9A-Za-z.])${bare}(?![0-9A-Za-z]|\\.\\d)`);
    }
    if (!alts.length) return null;
    this.re = new RegExp(alts.join('|'), 'gi');
    return this.re;
  }

  apply(s: string): string {
    const re = this.pattern();
    return re ? s.replace(re, VERIFIED_ORIGIN_PLACEHOLDER) : s;
  }
}

let active: HostScrub | null = null;

export interface HostedLogFilter {
  /** Stop filtering the streams. Tests only (G-58): a hosted CLI run keeps its filter until exit. */
  uninstall(): void;
  /** This run's filter, usable after `uninstall` (for the error `cli()` prints last). */
  scrub(s: string): string;
}

/** Start filtering the log streams for a hosted run whose verified origin is `origin`. */
export function installHostedLogFilter(origin: string): HostedLogFilter {
  const prev = active;
  const s = new HostScrub();
  try {
    s.addHost(new URL(origin).hostname);
  } catch {
    s.addHost(origin);
  }
  active = s;
  return {
    uninstall: () => {
      if (active === s) active = prev;
    },
    scrub: (t) => s.apply(t),
  };
}

/** Add an address seen for the verified origin (resolved or connected) to the active filter. */
export function addHostedPeerAddress(address: string): void {
  active?.addAddress(address);
}

/** Is a hosted log filter active (a hosted run is in progress)? */
export function hostedLogFilterActive(): boolean {
  return active !== null;
}

/** The text with the verified origin and its addresses replaced (identity when no hosted run is active). */
export function scrubHostedText(s: string): string {
  return active ? active.apply(s) : s;
}

/**
 * `e` with its message and next step passed through `filter`, for an error leaving the
 * hosted run. A CliError keeps its exit code; anything else becomes an exit-2 CliError
 * carrying only its allowlisted, filtered description (describeError wraps Node's own
 * DNS/TLS texts while a hosted run is active).
 */
export function scrubHostedError(e: unknown, filter: (s: string) => string): unknown {
  if (!(e instanceof CliError)) return runError(filter(describeError(e).message));
  const message = filter(e.message);
  const next = e.next === undefined ? undefined : filter(e.next);
  if (message === e.message && next === e.next) return e;
  return new CliError(message, e.exitCode, next);
}
