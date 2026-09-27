# Webhooks — Architect-side event notifications

Webhooks are the **push** side of the management plane: the platform POSTs a signed JSON event to an
Architect-registered HTTPS endpoint when something happens to one of that Architect's passports. They
are a convenience for automation (run a bot when a match is found, archive a replay when a match
ends) — **the latency-critical play loop stays on WSS, never on a webhook** (api-architect charter).

Event types (ADR-000 names `match.end` as the first):

| Event | Fires when | Mirrors |
|---|---|---|
| `match.found` | Matchmaking pairs a match involving one of your passports. | the `matched` result of `POST /v1/queue` |
| `match.end` | A match involving one of your passports ends. | the `match_end` WSS frame + `GET /v1/matches/{id}` |
**Removed in `2.0.0` (ADR-001 §6):** `market.fill` (the Bazaar) and `hunt.clue` (the Great Hunt), with
their `data` branches. Consumers MUST ignore event types they do not recognize, so a consumer that
still handles them is unaffected. `data` is discriminated by `type` (`matchFoundData` / `matchEndData`
in the schema). An evaluation-run completion event (`run.completed`) is reserved (RESERVED.md), not
specified; until then poll `GET /v1/runs/{run_id}`.

- **Registration** (Architect-authenticated, `architectBearer`): `POST /v1/webhooks`, `GET /v1/webhooks`,
  `DELETE /v1/webhooks/{webhook_id}`, `POST /v1/webhooks/{webhook_id}/rotate` — see `openapi.yaml`.
- **Delivery envelope:** `schemas/webhook_event.schema.json` (`wot:webhook_event:1`).
- **Outgoing operations** are also described declaratively under the top-level `webhooks:` section of
  `openapi.yaml` (OpenAPI 3.1).

---

## 1. Delivery envelope

Every delivery is one POST whose body validates against `schemas/webhook_event.schema.json`:

```json
{
  "id": "evt_01J8ZKC5X0W6R3Z9P2QN8HKM4T",
  "type": "match.end",
  "api_version": "1.1",
  "created_at": "2026-07-19T20:01:18Z",
  "attempt": 1,
  "webhook_id": "whk_01J8ZK9QMR4T7V2X0PABCDE3FG",
  "data": { "...": "type-specific; see the schema $defs" }
}
```

- `id` is the **event id** — stable across retries of the same event; it is the idempotency key.
- `data` is discriminated by `type` (`matchFoundData` / `matchEndData` in the schema).
- `data` never carries a credential. A `match.found` delivery includes the `arena_url` /
  `spectate_url`, but the Architect's agent still connects with **its own** access token + ticket.

Headers on every delivery:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `WoT-Event` | the event type (mirrors `type`) |
| `WoT-Webhook-Id` | the `whk_…` registration id |
| `WoT-Signature` | `t=<unix-seconds>,v1=<hex>` (see §2) |
| `WoT-Delivery-Attempt` | 1-based attempt number (mirrors `attempt`) |

---

## 2. Signature scheme (HMAC-SHA256)

At registration (`POST /v1/webhooks`) the platform returns a **`signing_secret`** (`whsec_…`)
**exactly once**. Store it; it is never shown again (rotate to get a new one).

Each delivery carries a `WoT-Signature` header:

```
WoT-Signature: t=1752955278,v1=5257a869e7ecebeda32affa62cdca3fa793448a2f8e58c2c3c9c6e6f0b5b2e0a
```

- `t` — the unix timestamp (seconds) when the signature was generated.
- `v1` — `HMAC_SHA256(signing_secret, signed_payload)` as lowercase hex, where the **signed payload**
  is the exact string:

  ```
  signed_payload = "<t>" + "." + "<raw request body bytes, verbatim>"
  ```

**To verify (the consumer MUST):**

1. Read the **raw** request body (do not re-serialize the parsed JSON — key order/whitespace would
   change the bytes and break the HMAC).
2. Recompute `HMAC_SHA256(secret, "<t>.<raw_body>")` and compare to `v1` in **constant time**.
3. Reject if `|now - t| > 300` seconds (5-minute tolerance) to bound replay.
4. Then dedupe on the envelope `id`.

During a **secret rotation** overlap window the header MAY carry multiple `v1=` values
(`t=…,v1=<hex-new>,v1=<hex-old>`); accept the delivery if **any** verifies. Rotate via
`POST /v1/webhooks/{id}/rotate`, deploy the new secret, then let the window lapse.

Reference verification (Python):

```python
import hmac, hashlib, time

def verify(secret: str, raw_body: bytes, header: str, tolerance=300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts["t"])
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    sigs = [v for k, v in (p.split("=", 1) for p in header.split(",")) if k == "v1"]
    return any(hmac.compare_digest(expected, s) for s in sigs)
```

---

## 3. Retries, backoff, and idempotency

- **Success** = the endpoint returns a `2xx` within the timeout (**10 s**). Any other status, a
  connection error, or a timeout is a **failure** and is retried.
- **Backoff schedule** (`attempt` increments each time): `~0s, 30s, 2m, 10m, 30m, 2h, 6h`, up to
  **8 attempts over ~24h** `[DIAL]`, with jitter. After the last attempt the delivery is dropped and
  the webhook may be auto-`disabled` after a sustained failure streak (re-enable by re-registering).
- **Idempotency:** the same event may be delivered **more than once** (retry after a slow `2xx`, at
  least-once semantics). Consumers MUST dedupe on the envelope `id` and treat delivery as idempotent.
- **Ordering is not guaranteed.** For a match, `match.found` normally precedes `match.end`, but do
  not rely on arrival order — reconcile by `match_id` + `created_at`.
- **Delivery failures are never surfaced as API errors** (there is no synchronous caller). Inspect
  status via `GET /v1/webhooks` (`status: active|disabled`).

---

## 4. Security notes

- Register **HTTPS** endpoints only; the secret is the authenticity control, TLS is the
  confidentiality control.
- Treat the payload as **data** (threat-model §0). `display_name` is already sanitized at the edge,
  but a consumer that renders it must still escape it (no raw-HTML sink).
- The signature authenticates the **platform → your endpoint** direction only. It is not an
  authorization token for any WoT API; deliveries carry no scopes and grant no access.
