# `agents/` — sample bots + the thin client (Phase-1 Stage B3)

Reference agents that exercise the Phase-1 protocol end to end: authenticate →
queue → play a full Grid Tactics duel → fetch the hash-committed replay. They are
the "I can improve this" hook — a ≤50-line reflex floor and a stronger scripted
heuristic that shows the ceiling.

**Pillar 9 (ADDENDUM-001): every policy here is a SCRIPTED, deterministic function.
There are NO LLM calls anywhere in this directory.** These bots demonstrate that the
skill gap in these scenarios is pure engineering (state, inference, planning), not a
bigger model.

Everything is driven by the generated wire types + AJV validators in
[`wot-contracts`](../packages/wot-contracts), so the agents can never drift from the
contracts. Run with `tsx` — no build step.

## Layout

| Path | What it is |
|---|---|
| `lib/client.ts` | The thin, framework-agnostic client. `connectAndPlay(...)` does the full bootstrap + play loop; `registerAgent(...)` mints a passport in dev-auth mode. |
| `lib/grid.ts` | Pure Grid Tactics helpers: roster stats, the RPS triangle, geometry, action builders. |
| `lib/heuristic.ts` | The configurable scripted engine (capability flags = difficulty dial). |
| `lib/env.ts` | Env-driven credential bootstrap + a console logger for `onEvent`. |
| `reflex/policy.ts` | The ≤50-line reflex reference policy. |
| `reflex/run.ts` | Runnable: plays one match with the reflex policy. |
| `hunter/policy.ts` | The stronger scripted heuristic (fog memory, RPS, predictive fire, token efficiency). |
| `hunter/run.ts` | Runnable: plays one match with the hunter policy. |
| `house-bot/policy.ts` | Difficulty-tiered backfill policy (`bronze`/`silver`/`gold`), exported as a plain `policy(obs)=>action`. |
| `test/policy.test.ts` | Policy unit tests (contract-valid actions, RPS target choice). |

## Prerequisites

- Node ≥ 22 (uses the global `fetch`). `ws` and `tsx` are already installed at the
  `ascension/` workspace root — **do not run `npm install`**.
- A local sandbox exposing the management + arena planes (delivered by
  platform/arena + docker-compose):
  - gateway (REST) on `http://localhost:8080`
  - passports (token/JWKS) on `http://localhost:8081`
  - arena (WSS) on `ws://localhost:8082`

  The agents only need the **gateway** base URL; the queue response tells them which
  arena URL to connect to.

All commands below are run from the `ascension/` directory.

## Run an agent

### With an existing passport

```bash
export BASE_URL=http://localhost:8080
export WOT_CLIENT_ID=cid_...          # from POST /v1/agents (portal or dev-auth)
export WOT_CLIENT_SECRET=wotk_sk_...
export WOT_LEAGUE=core                 # edge | core | frontier (optional)

npx tsx agents/reflex/run.ts           # the ≤50-line floor
npx tsx agents/hunter/run.ts           # the stronger heuristic
```

### Zero-setup (dev-auth self-registration)

If `WOT_CLIENT_ID` / `WOT_CLIENT_SECRET` are absent, the runner registers a fresh
passport via `POST /v1/agents` using a dev bearer token. **This only works when the
sandbox gateway is started with `WOT_DEV_AUTH=1`** (fail-closed, off by default — a
register endpoint with auth bypassed is a passport-minting oracle). Override the dev
token with `WOT_DEV_AUTH_TOKEN` if the sandbox expects a specific value.

```bash
BASE_URL=http://localhost:8080 npx tsx agents/reflex/run.ts
```

On success each runner prints the result, reason, and the fetched `replay_id`/hash.

### Watch two bots fight

Run the hunter and the reflex agent in two terminals against the same sandbox;
matchmaking pairs them (or backfills with a house bot). The hunter should win most
of the time — that gap is the point.

## Use the house bot as matchmaking backfill

```ts
import { createHouseBot, policy } from './agents/house-bot/policy.ts';

const gold = createHouseBot('gold');    // hardest tier
const action = gold(observation);       // plain (obs) => action

// or the ready-made silver-tier singleton:
const action2 = policy(observation);
```

Difficulty is a heuristic-quality dial (RPS awareness, fog memory, predictive fire,
step depth) — never a model.

## `connectAndPlay` signature

```ts
function connectAndPlay(opts: {
  baseUrl: string;            // management-plane URL, e.g. http://localhost:8080
  clientId: string;
  clientSecret: string;
  policy: (obs: Observation) => Action;   // your scripted decision function
  league?: 'edge' | 'core' | 'frontier';  // default 'core'
  scope?: string;                          // default 'play:duel spectate:read'
  onEvent?: (e: ClientEvent) => void;      // optional observability hook
  validateOutgoing?: boolean;              // validate each action vs the contract
}): Promise<{ result: 'win' | 'loss' | 'draw'; matchEnd: MatchEnd; replay: unknown }>;

function registerAgent(opts: {
  baseUrl: string; displayName: string; league?: League; authToken?: string;
}): Promise<{ clientId: string; clientSecret: string; agentId: string }>;
```

`connectAndPlay` mints a token, enters the duel queue, opens the WSS session, sends
`hello`, then loops `observation → policy(obs) → action` (echoing `turn_id`+`nonce`)
until `match_end`, whereupon it fetches the replay and resolves. It logs and
continues on `ack`/`reject`, **stops** on `session_superseded`/`session_revoked`, and
**reconnects once** (re-minting the token, `hello.resume=true`) on a transient socket
drop. Every SDK error says what to do next.

## Develop / test

```bash
# Typecheck the agents in isolation (siblings are written concurrently):
npx tsc --noEmit -p agents/tsconfig.json

# Run the policy unit tests:
node --test --import tsx agents/test/policy.test.ts
```
