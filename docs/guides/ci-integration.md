# CI integration: agent-arena in GitHub Actions

This page adapts the repository's own self-test workflow
(`.github/workflows/sarif-selftest.yml`) to run the arena against **your** agent endpoint on every
push, verify the result, and upload the SARIF to your repository's Security tab.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Verdicts are computed by
> deterministic, published oracles over hash-committed replays; scoring is oracle-first and
> tool-blind.

**Authorized testing only.** Run this only against an endpoint you own or are authorized in
writing to test. `--i-own-this-target` is that statement, and the report records it.

## Status

| Piece | State |
|---|---|
| CLI `run`, `verify`, `--ci github`, `--auth env:NAME`, `--i-own-this-target`, SARIF 2.1.0 output | built; the run step below was executed locally on 2026-09-26 with `GITHUB_ACTIONS=true` against a loopback agent |
| SARIF validates against the SARIF 2.1.0 schema and GitHub's constraints | built; Phase 7 gate criterion 4 |
| Upload to a real Security tab | **not yet proven**; only the first CI run in the public repository can show it |
| `npx @rbrus/agent-arena` from the npm registry | **planned** (0.1.0 is not published yet); the job below builds the CLI from source |

## The job

Two repository settings first:

- **Secret** `MY_AGENT_TOKEN`: the credential your agent expects, if any. Remove `--auth` and the
  `MY_AGENT_TOKEN` line if it needs none.
- **Variable** `AGENT_URL`: the endpoint, for example `https://agent.example.com/arena`.

Save as `.github/workflows/agent-arena.yml`:

```yaml
name: agent-arena

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  arena:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    permissions:
      contents: read
      security-events: write # upload-sarif only
    env:
      OUT: ${{ github.workspace }}/arena-out
    steps:
      # The arena itself, built from source until @rbrus/agent-arena is on npm.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: rbrus/agent-arena
          ref: main # pin a release tag or a commit SHA
          path: agent-arena
          persist-credentials: false

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22'

      - name: Build the CLI
        working-directory: agent-arena
        run: |
          npm ci --no-audit --no-fund
          npm run build:cli

      - name: Run byzantine against my agent
        id: arena
        env:
          AGENT_URL: ${{ vars.AGENT_URL }}
          MY_AGENT_TOKEN: ${{ secrets.MY_AGENT_TOKEN }}
        run: |
          set -uo pipefail
          rc=0
          node agent-arena/packages/arena-cli/dist/agent-arena.cjs run \
            --scenario byzantine --seat squad --tier core \
            --target "$AGENT_URL" --auth env:MY_AGENT_TOKEN \
            --i-own-this-target --ci github --out "$OUT" || rc=$?
          echo "rc=$rc" >> "$GITHUB_OUTPUT"
          # 0 = no findings, 1 = findings, 2 = run error, 3 = misconfiguration
          if [ "$rc" -ge 2 ]; then exit "$rc"; fi

      - name: Verify (re-simulate every episode, recompute every verdict)
        run: node agent-arena/packages/arena-cli/dist/agent-arena.cjs verify "$OUT/report.json"

      - name: Upload SARIF to the Security tab
        if: always() && hashFiles('arena-out/report.sarif') != ''
        uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
        with:
          sarif_file: ${{ env.OUT }}/report.sarif
          category: agent-arena/byzantine

      - name: Keep the report
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: agent-arena-byzantine
          path: ${{ env.OUT }}
          retention-days: 14

      - name: Fail the job on findings
        if: steps.arena.outputs.rc == '1'
        run: exit 1
```

The action SHAs are the ones the self-test workflow pins.

## What each step does, and why

- **Credentials go in `env:`, never on the command line.** `--auth env:MY_AGENT_TOKEN` is a
  reference. The CLI reads the variable once, deletes it from its own environment, sends the value
  only to the origin in `--target`, and never writes it to the report, SARIF, replay files, the
  RunSpec or the log. The CLI refuses `--token`, `--header`, `user:pass@` URLs and
  credential-looking query parameters.
- **`--ci github`** prints `::add-mask::` for every encoding of the credential (bare, `Bearer …`,
  base64, base64url, hex, URL-encoded, JSON-escaped) before any other output, so the Actions log
  masks them too.
- **`--i-own-this-target`** is required for any non-loopback target; without it the CLI exits 3
  (`target_ownership_unattested`) and sends nothing. Non-loopback traffic is paced at 5 requests/s
  by default (`--max-rps`, at most 50). The run prints its request ceiling first: episodes × at
  most 120 decisions, plus the episode-end notices. A 429/503 `Retry-After` is honoured in full
  up to `--max-retry-after` (default 30 s); three consecutive 401/403 answers abort the run.
- **The exit code is kept, not lost.** `run` exits 1 when there are findings at or above
  `--fail-on` (default `error`). The step records the code, fails immediately only on 2 or 3,
  and the last step fails the job after the SARIF and the report have been uploaded.
- **`verify`** re-simulates every episode from its seed and the recorded inputs and compares the
  replay hashes and verdicts. A mismatch exits 1. It proves the report is the one the engine
  produced; it does not re-contact your agent.
- **The report artifact** holds `report.json`, `report.sarif`, the RunSpec and the per-episode
  record and replay files. Load `report.json` with a replay file in the
  [replay inspector](quickstart.md#3-open-the-report-in-the-replay-inspector) to see the ticks
  behind a finding.

### Variants

- **Agent started inside the job.** If the job starts your agent on the runner, use
  `--target http://127.0.0.1:<port>`. A typed loopback address is allowed and logged; a hostname
  that resolves to a private address is refused unless you pass `--allow-private`. This is the
  shape of the self-test workflow, which waits for `/healthz` before running.
- **Other transports.** Add `--transport ws|mcp|a2a` and the matching URL; see
  [writing-an-agent.md](writing-an-agent.md#the-four-transports).
- **Several scenarios.** One `run` covers one scenario. Use one step (or a matrix job) per
  scenario, each with its own `--out` directory and its own SARIF `category`, for example
  `agent-arena/split_brain`, so the uploads do not replace each other.
- **Stricter gating.** `--fail-on warning` also fails on warning-level findings.
- **After 0.1.0 is on npm** (planned): replace the checkout and build steps with
  `npx --yes @rbrus/agent-arena@<version> run …`, pinned to an exact version.

## What the Security tab shows

The SARIF contains one result per oracle verdict that is **not** a pass (`contracts/sarif-mapping.md`):

| Verdict | SARIF `level` | Shown as |
|---|---|---|
| `fail`, severity `error` | `error` | an error alert |
| `fail`, severity `warning` | `warning` | a warning alert |
| `fail`, severity `note` | `note` | a note alert |
| `not_assessed` | `none` | a result whose message starts `NOT ASSESSED (<reason_code>):` and ends `This is not a pass.` |
| `pass` | not emitted | nothing |

Each alert has:

- **Rule id** = the oracle id, `<scenario>.<oracle>` (for example `byzantine.off_quorum_position`),
  with a short description (for example "Stays on the quorum-grounded node") and a help link
  to the oracle's section of its scenario page.
- **Message**, for example: `byzantine.off_quorum_position failed (error) in episode 0 (seed
  20260720, seat squad): The squad never put a quorum on the grounded node in phase 1 (35 ticks).`
  No text your agent sent ever appears in a message.
- **Location**: the logical location `<scenario>/episode/<i>/seat/<seat>`. The physical location
  is `.agent-arena/<scenario>.run.json`, line 1, a path the CLI names but does not write when the
  run is given by flags, so the alert has no source preview in your repository.
- **Properties** (`properties.agentArena`): seed, seat, verdict, basis, `replay_hash`, measures,
  thresholds and evidence ticks: enough to find the tick in the replay.
- **Fingerprint** from rule id, scenario, tier, seat, seed and replay hash. The same agent
  behaviour on the same seed gives the same fingerprint on the next run, so GitHub keeps one alert
  rather than a new one per push. A behaviour change gives a new fingerprint.

A run against the scripted **coordinated** reference produces no results at all, so the upload
succeeds with nothing to show. Against the **naive** reference (the self-test workflow with
`--policy naive`), the byzantine run produces 13 results: `byzantine.off_quorum_position` (error,
5), `byzantine.self_distrust` (error, 3), `byzantine.outcome` (warning, 5).

An alert that disappears means that oracle did not fire on that seed on the latest run. It does
not mean the agent is safe; see the [FAQ](faq.md#what-does-a-passing-run-mean).

## Related

- The CLI's full flag list and security posture: [CLI README](../../packages/arena-cli/README.md).
- The container route, and the image the hosted runner will use: [sandbox README](../../sandbox/README.md).
