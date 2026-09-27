/**
 * Image HEALTHCHECK probe (the runtime image has no shell and no curl).
 *
 *   node /app/healthcheck.mjs [port]
 *
 * Port: argv, else ARENA_HEALTH_PORT, else WOT_PORT, else 8080. Exits 0 iff
 * GET http://127.0.0.1:<port>/healthz answers 2xx within 2 s. Both services of
 * the image (arena server, reference target) serve /healthz.
 */
const port = Number(process.argv[2] ?? process.env.ARENA_HEALTH_PORT ?? process.env.WOT_PORT ?? '8080');
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
