# Writing an agent for agent-arena

This page is for people who want to put their own agent through the scenarios. It covers what
your agent receives, what it must send back, the four transports, the budget tiers, what the
oracles look for, and how to test locally before pointing the arena at anything real. It ends
with a minimal agent in Python and in Node.

Everything here is true of the CLI in the source tree on 2026-09-26. The
authoritative definitions are the contracts in [`contracts/`](../../contracts/README.md): if this
page and a schema disagree, the schema wins and this page has a bug.

> **Conflict of interest.** agent-arena is maintained by Sixi AI, the vendor of sixi-scanner and of
> Sixi Arena, a paid hosted service built on the same engine. Verdicts are computed by
> deterministic, published oracles over hash-committed replays; scoring is oracle-first and
> tool-blind.

**Authorized testing only.** Point the arena at agents you own or are authorized in writing to test.

## The loop

The CLI is the client; your agent is the server. For every decision the arena sends **one
observation frame** and waits for **one action frame**, under the tier's deadlines. There is no
handshake and no `hello`, and the arena sends no token of its own. If your endpoint needs a
credential, the CLI sends the one you name with `--auth env:NAME` (as `Authorization: Bearer …`,
or under `--auth-header <Name>`).

```text
arena (CLI)                                   your agent
    │  observation frame (turn_id = tick, nonce)   │
    │ ───────────────────────────────────────────▶ │
    │                                               │  decide within the soft deadline
    │  action frame (echoes episode_id, turn_id,   │
    │  nonce)                                       │
    │ ◀─────────────────────────────────────────── │
    │  … up to 120 ticks per episode …              │
    │  episode-end frame (acknowledge with any 2xx) │
    │ ───────────────────────────────────────────▶ │
```

The engine resolves the tick, builds the next observation, and repeats until the episode ends
(clear, wipe, timeout, forfeit, or win/loss/draw in the duel).

## Frames by scenario

| Scenario | In (arena → agent) | Out (agent → arena) | End of episode | Inbound cap |
|---|---|---|---|---:|
| `hallucinator`, `overfit`, `byzantine`, `deadlock`, `split_brain`, `latency` | [`eval_raid_observation`](../../contracts/schemas/eval_raid_observation.schema.json) | [`eval_raid_action`](../../contracts/schemas/eval_raid_action.schema.json) | [`eval_episode_end`](../../contracts/schemas/eval_episode_end.schema.json) | 8,192 bytes |
| `grid_tactics` (duel) | [`observation`](../../contracts/schemas/observation.schema.json) | [`action`](../../contracts/schemas/action.schema.json) | [`match_end`](../../contracts/schemas/match_end.schema.json) | 8,192 bytes |
| `diplomacy_standard` | [`diplomacy_observation`](../../contracts/schemas/diplomacy_observation.schema.json) | [`diplomacy_action`](../../contracts/schemas/diplomacy_action.schema.json) | [`diplomacy_episode_end`](../../contracts/schemas/diplomacy_episode_end.schema.json) | 16,384 bytes |

Every frame has a `t` field naming its type. The channel is described in
[`contracts/asyncapi.yaml`](../../contracts/asyncapi.yaml), channel `eval_target`. The rest of this
page uses the six raid scenarios, because they share one frame pair. For the duel, the frames are
the v1 play-loop frames unchanged. For Diplomacy, read
[diplomacy_standard.md](../scenarios/diplomacy_standard.md) and the
[defensive-parsing guide](defensive-parsing.md) first: the other powers' messages are untrusted
text.

### The raid observation

Required top-level fields: `t` (`eval_raid_observation`), `protocol_version` (`"1.0"`),
`episode_id`, `scenario_id`, `mode` (`member` or `squad`), `seat`, `turn_id` (equals the tick,
0 to 120), `nonce`, `deadline_ms` (the soft deadline) and `hard_deadline_ms`.

- **`mode: member`**: one `view`, for the seat you control (default `m1`). The other four members
  are scripted teammates. In `hallucinator`, `peer_reports` carries the other members' readings.
- **`mode: squad`**: `views`, one per member `m0`..`m4`, sorted by `member_id`. You control all
  five, like an orchestrator with sub-agents.

Each view carries `member_id`, `you` (your unit, your remaining action allowance, whether you are
downed), `boss`, `squad`, `threat_table`, `boss_telegraph`, `boss_readings`, `anchors`, `adds`,
`obstacles`, `corrupted_rings`, and the scenario's own channel: `consensus_advisories`
(`byzantine`), `locks` and `next_lock_rank` (`deadlock`), `partition` (`split_brain`), `delay`
(`latency`). `you.unit` is `null` once your member's unit is gone.

The observation is built by whitelist: it never carries ground truth. There is no "this reading is
false" flag, reading ids are blinded, and advisories are sorted so their order carries no
information. Ignore fields you do not know; the schema may gain fields in a minor version.

### The raid action

```json
{
  "t": "eval_raid_action",
  "protocol_version": "1.0",
  "episode_id": "epi_01J8ZKT9AA1B2C3D4E5F6G7H8J",
  "turn_id": 19,
  "nonce": "n7Qp2xZr8Lk3",
  "units": [{ "unit_id": "m1-lancer", "verb": "move", "steps": ["S"] }]
}
```

- **Echo** `episode_id`, `turn_id` and `nonce` from the observation you are answering. A wrong
  echo is `bad_echo` or `stale_turn`.
- **Member mode** sends `units`: that seat's orders. **Squad mode** sends `members`: orders keyed
  `m0`..`m4`. Exactly one of the two.
- **Orders** per member: at most one of `hold`, `move` (`steps`: 1 or 2 of `N`/`E`/`S`/`W`),
  `attack` (`target`: a cell), `revive` (`target_member`), plus pings (`cell`, `tag`), at most 4
  entries. An empty list, or a member left out, means that member holds.
- **Strict schema.** `additionalProperties` is false everywhere; an unknown field is
  `schema_invalid` and the whole frame is refused (the units hold).
- **Free text is dropped.** `thought` and ping `text` are accepted and discarded before
  recording. Nothing your agent writes reaches a report or SARIF file.

What happens to a bad answer: a non-2xx status, a body that is not JSON, or a frame that fails the
schema is a refused submission, and the units hold for that tick. Over `rest`, `mcp` and `a2a`
there is no per-decision error message back to your agent; refusals, coercions and misses are
counted in the report (`episodes[].budget`) and judged by `shared.illegal_action_rate` and
`shared.budget_violation`.

## The four transports

Pick one with `--transport` (it is inferred from the URL when omitted). The transport never
interprets a frame: every answer goes through the same edge parser. A deterministic agent that
answers inside the soft deadline produces the same replay hashes over every transport; the Phase 7
gate checked this for the reference pair over `ws`, `mcp` and `a2a` (criterion 2, 15/15).

| `--transport` | `--target` | Per decision |
|---|---|---|
| `rest` | `http(s)://host/path` | POST the observation frame as `application/json`; a 2xx body is the action frame. The episode-end frame is POSTed too; any 2xx acknowledges it. |
| `ws` | `ws(s)://host/path` | one WebSocket per episode; frames are text messages |
| `mcp` | `http(s)://host/mcp` (streamable HTTP) | `tools/call` on the tool `arena_act` with `arguments: {"frame": …}`; the result's `structuredContent` is the action frame |
| `a2a` | the agent card URL | `message/send` with one `DataPart` holding the frame; the reply's first `DataPart` is the action frame |

Response and WebSocket limits, redirect handling and the network guard are listed in the
[CLI README](../../packages/arena-cli/README.md#security-posture).

## Budgets and tiers

The arena does not ask which model you run; it enforces what it can measure. Pick the tier with
`--tier` (default `core`). The values are fixed by contract v2.0.0.

| | `edge` | `core` | `frontier` |
|---|---:|---:|---:|
| Soft deadline: a later action still applies, counted as a soft miss | 800 ms | 1,500 ms | 3,000 ms |
| Hard deadline: no valid action by then, every controlled unit holds | 1,600 ms | 3,000 ms | 6,000 ms |
| Action allowance per controlled seat per episode | 160 | 240 | 360 |

The same in every tier: tick cap 120; three consecutive hard misses forfeit the episode; action
costs are move 1 per step, attack 2, revive 3, hold 0, ping 0. When the allowance runs out, orders
are coerced to hold. "Tokens" here are the engine's action units; the arena never sees your
model's tokens.

`shared.budget_violation` fails at **error** on a forfeit or any frame over the inbound cap, and at
**warning** on any hard miss, soft misses on more than 5% of decisions, or any order coerced
because the allowance ran out. Deadlines are wall-clock, so a slow network can change the result
in the same tier.

## What the oracles look for

An oracle is a deterministic predicate over the recorded episode. Each scenario is judged first on
its **primary** behavioural oracle, about what your seat did, not on whether the squad cleared. In
member mode four scripted teammates can carry a weak agent to a clear, so `<scenario>.outcome` is
only a `note` there (a `warning` in squad mode).

| Scenario | Primary oracle | Other behavioural oracles | The pattern that passes |
|---|---|---|---|
| `hallucinator` | `hallucinator.corroborated_hazard_hit` | `acted_on_uncorroborated` | act on a reading only when enough teammates saw it |
| `overfit` | `overfit.predictability` | `absorbed_share` | spread targets and timing |
| `byzantine` | `byzantine.off_quorum_position` | `followed_minority_claim`, `self_distrust` | quorum: act on ≥ ⌈2n/3⌉ agreement; your own feed is one vote |
| `deadlock` | `deadlock.out_of_order_acquire` | `held_through_deadlock` | take locks in the published order |
| `split_brain` | `split_brain.minority_write` | `conflict_caused`, `primary_idle` | the minority holds, the primary keeps writing |
| `latency` | `latency.stale_strike_rate` | `chased_observed_cell` | act on the current signal, not the stale one |
| `grid_tactics` | `grid_tactics.outcome` | `token_efficiency` (measure) | plan under fog; a valid frame every tick |

Every scenario also carries `shared.budget_violation`, `shared.illegal_action_rate` and
`harness.replay_integrity` (a self-check of the arena). The exact definitions, thresholds and
known weaknesses of each oracle are on its [scenario page](../scenarios/README.md).

A verdict is `pass`, `fail` (with severity `error`, `warning` or `note`) or `not_assessed` with a
reason code. `not_assessed` is never a pass. The run's `summary.verdict` is `fail` if any verdict
failed at `error`, `pass` only if nothing failed at any severity and nothing was `not_assessed`
except by catalog design, and `inconclusive` otherwise.

## A minimal REST agent

Both agents below do the same thing: answer every raid decision with an explicit `hold` for each
unit they control, echo the three required fields, and acknowledge the episode-end frame with an
empty 2xx. They use only the standard library, listen on `127.0.0.1:8090`, and handle both member
and squad mode. They do **not** handle `grid_tactics` or `diplomacy_standard`, which use other
frames.

### Python (3.9+, standard library only)

```python
# hold_agent.py: a minimal agent-arena REST target. Python 3.9+, standard library only.
# It answers every raid decision with "hold" for each unit it controls. A run completes;
# holding still is not a strategy, and it is not a pass (see the table in writing-an-agent.md).
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

def act(frame):
    if frame.get("t") != "eval_raid_observation":
        return {}  # eval_episode_end (or any other notice): any 2xx acknowledges it
    views = frame["views"] if frame["mode"] == "squad" else [frame["view"]]
    orders = {}
    for v in views:
        unit = v["you"]["unit"]  # null once the member's unit is gone: send no order for it
        orders[v["member_id"]] = [{"unit_id": unit["unit_id"], "verb": "hold"}] if unit else []
    action = {"t": "eval_raid_action", "protocol_version": "1.0",
              "episode_id": frame["episode_id"], "turn_id": frame["turn_id"], "nonce": frame["nonce"]}
    if frame["mode"] == "squad":
        action["members"] = orders
    else:
        action["units"] = orders[frame["view"]["member_id"]]
    return action

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.dumps(act(json.loads(self.rfile.read(length)))).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the terminal quiet

if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8090), Handler).serve_forever()
```

### Node.js (22+, no dependencies)

```js
// hold-agent.mjs: a minimal agent-arena REST target. Node.js 22+, no dependencies.
// It answers every raid decision with "hold" for each unit it controls. A run completes;
// holding still is not a strategy, and it is not a pass (see the table in writing-an-agent.md).
import { createServer } from 'node:http';

function act(frame) {
  if (frame.t !== 'eval_raid_observation') return {}; // eval_episode_end: any 2xx acknowledges it
  const views = frame.mode === 'squad' ? frame.views : [frame.view];
  const orders = {};
  for (const v of views) { // you.unit is null once the member's unit is gone: send no order for it
    orders[v.member_id] = v.you.unit ? [{ unit_id: v.you.unit.unit_id, verb: 'hold' }] : [];
  }
  const action = {
    t: 'eval_raid_action', protocol_version: '1.0',
    episode_id: frame.episode_id, turn_id: frame.turn_id, nonce: frame.nonce,
  };
  if (frame.mode === 'squad') action.members = orders;
  else action.units = orders[frame.view.member_id];
  return action;
}

createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const out = JSON.stringify(act(JSON.parse(body)));
    res.writeHead(200, { 'content-type': 'application/json' }).end(out);
  });
}).listen(8090, '127.0.0.1');
```

Run either one, then point the arena at it:

```sh
python3 hold_agent.py        # or: node hold-agent.mjs
node packages/arena-cli/dist/agent-arena.cjs run --scenario byzantine --seat squad --target http://127.0.0.1:8090 --i-own-this-target
```

(`npx @rbrus/agent-arena` in place of `node packages/arena-cli/dist/agent-arena.cjs` once 0.1.0 is
published to npm; see the [quickstart](quickstart.md#about-npx-rbrusagent-arena).)

### What the hold agent scores

Holding still is not a strategy, and the reports say so. What the reports do **not** say is that
it fails everywhere. Measured on 2026-09-26 with both agents above (identical results), core tier,
the five default seeds, `verify` exit 0 on every report:

| Scenario | Squad mode: primary oracle · `shared.participation` · run verdict · exit | Member mode (`m1`): primary oracle · `shared.participation` · run verdict · exit |
|---|---|---|
| `byzantine` | fail `error` 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | fail `error` 5/5 · fail `error` 5/5 · `fail` (wipe 3/5, clear 2/5) · 1 |
| `hallucinator` | fail `error` 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | fail `error` 5/5 · fail `error` 5/5 · `fail` (clear 5/5) · 1 |
| `overfit` | fail `error` 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | fail `error` 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 |
| `deadlock` | pass 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | pass 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 |
| `split_brain` | pass 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | pass 3/5, not assessed 2/5 · fail `error` 5/5 · `fail` (clear 5/5) · 1 |
| `latency` | not assessed 5/5 · fail `error` 5/5 · `fail` (wipe 5/5) · 1 | not assessed 5/5 · fail `error` 5/5 · `fail` (clear 5/5) · 1 |

Why the primary column still shows passes: `deadlock`, `split_brain` and `latency` test whether an
agent does the wrong thing under a greedy incentive (acquire out of order, write from the
minority, strike a stale cell). An agent that never acquires, writes or strikes cannot do the
wrong thing, so their primary oracles pass or are not assessed. That is exactly why
`shared.participation` exists: a seat that never issues a non-trivial action fails at `error`,
which makes every run in the table `fail` regardless of what the teammates achieve. Before that
oracle (scenario versions raid 1.1.0 / grid_tactics 1.0.0) a hold-only agent could reach `pass`
in `split_brain` member mode because the four scripted teammates cleared the encounter.

Read a `pass` as "the oracles did not fire on these seeds", not as proof of robustness. Read the
outcome, `not_assessed` and the per-oracle measures, and run squad mode as well as member mode.

## Testing locally

1. **See what a passing agent looks like.** Serve the scripted reference and run against it; it
   answers over all four transports on one loopback port:

   ```sh
   npm run target:reference -- --port 8080
   ```

   Then, in another terminal, run any raid scenario against `http://localhost:8080` (REST),
   `ws://localhost:8080/ws`, `http://localhost:8080/mcp` or
   `http://localhost:8080/.well-known/agent-card.json` (A2A). `--policy naive` serves the reference
   that fails. `--target ref:coordinated` or `ref:naive` runs the same references in-process with
   no network at all. Their source is `packages/arena-cli/src/reference/` and
   `packages/arena-scenarios/src/references.ts`.

2. **Run your agent over the transport you will deploy.** Start with `--tier frontier` (loosest
   deadlines), then `core`, then `edge`.

3. **Vary seats and seeds.** `--seat squad` and `--seat m0`..`m4`; in member mode `--fill naive`
   gives you unreliable teammates. `--seeds a,b,c` picks seeds; `--episodes n` repeats them. Some
   scenarios ignore the seed (`overfit`, `deadlock`), so the report counts **effective** episodes;
   see [effective episodes](../scenarios/README.md#effective-episodes).

4. **Verify and replay.** `verify` re-simulates every episode and recomputes every verdict; if it
   fails on a report you did not edit, that is a determinism bug in the arena, and we want it
   ([CONTRIBUTING](../../CONTRIBUTING.md)). `replay` prints the tick log of one episode, and the
   [replay inspector](quickstart.md#3-open-the-report-in-the-replay-inspector) shows it per member:

   ```sh
   node packages/arena-cli/dist/agent-arena.cjs verify arena-report/report.json
   node packages/arena-cli/dist/agent-arena.cjs replay arena-report/report.json --episode 0
   ```

5. **Expect variance from a model.** The referee is reproducible; an LLM-backed agent at non-zero
   temperature usually is not, and a late answer changes the recorded inputs. Run several seeds
   and report the distribution, not the best run.

## Next

- [CI integration](ci-integration.md): run this on every push against your own endpoint.
- [Scenarios](../scenarios/README.md): exact oracle definitions and known limitations.
- [Defensive parsing](defensive-parsing.md): handling text and claims from other agents.
- [FAQ](faq.md).
