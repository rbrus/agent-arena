/**
 * Version and engine build hash. The build hash is arena-report's SCOPED
 * digest (`engineBuildDigest`, contracts 2.2.0): a non-Diplomacy report records
 * scope `core` (no `src/diplomacy/**`), so Diplomacy commits do not invalidate
 * core goldens. In the esbuild bundle the per-file source manifest is embedded
 * at build time (`define: { __ARENA_ENGINE_SOURCES__ }`, build.ts); under tsx
 * (development, tests) arena-report hashes the workspace sources. Both feed the
 * same function, so a report produced by either verifies with the other.
 */

import pkg from '../package.json' with { type: 'json' };
import { engineBuildDigest, engineBuildScopeFor, type EngineBuildDigest, type EngineBuildScope } from 'arena-report';

declare const __ARENA_BUNDLED__: boolean | undefined;

export const CLI_NAME = 'agent-arena';
export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
export const ENGINE_VERSION = 'arena@2.0.0';
export const USER_AGENT = `agent-arena/${VERSION} (+https://github.com/rbrus/agent-arena)`;
/** HOSTED-PROFILE §2.4 step 8: the hosted runner identifies itself as such. */
export const HOSTED_USER_AGENT = `agent-arena/${VERSION} (+https://github.com/rbrus/agent-arena; sixi-hosted)`;

export const BUNDLED: boolean = typeof __ARENA_BUNDLED__ === 'boolean' && __ARENA_BUNDLED__;

const cache = new Map<EngineBuildScope, EngineBuildDigest>();

function scoped(scope: EngineBuildScope): EngineBuildDigest {
  let d = cache.get(scope);
  if (!d) {
    d = engineBuildDigest({ scope });
    cache.set(scope, d);
  }
  return d;
}

/** `engine.build_hash` for one scope (`sha256:<64 hex>`). */
export function engineBuildHash(scope: EngineBuildScope): string {
  return scoped(scope).digest;
}

/**
 * The scope a scenario's reports record, this build's hash for it, and the
 * digest of the source manifest it was derived from (contracts 2.3.0
 * `engine.build_scope` / `engine.source_manifest_digest`).
 */
export function engineBuildFor(scenarioId: string): { scope: EngineBuildScope; digest: string; manifestDigest: string } {
  const scope = engineBuildScopeFor(scenarioId);
  const d = scoped(scope);
  return { scope, digest: d.digest, manifestDigest: d.manifestDigest };
}
