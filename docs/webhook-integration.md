# Webhook integration guide (merchants)

This guide describes what the backend implements today. It does not yet define
outbound webhook event types or payload schemas, so those sections are omitted
rather than guessed. Payment status today is detected by the Horizon payment
watcher, not by webhooks.

## What exists

- **Inbound signature guard.** `webhookReplayGuard` in
  `src/middleware/webhookReplay.middleware.ts` verifies signed requests and
  rejects replays. It is not mounted on any route yet (see `docs/webhooks.md`).
- **Delivery log (read-only).** `GET /api/v1/webhooks/deliveries` and
  `GET /api/v1/webhooks/deliveries/:id` return rows from
  `webhook_delivery_logs`. Both require the `admin` or `manager` role. The list
  accepts `event` and `status` filters and standard pagination.
- **Not implemented:** an event catalogue, payload schemas, an outbound
  dispatcher, or retry logic. The delivery log has an `attempt` field, but no
  writer for it was found in the files reviewed for this guide.

## Verifying a signed request

Send two headers with the raw JSON body:

| Header | Value |
|---|---|
| `X-Webhook-Timestamp` | Unix time in seconds when you signed the body. |
| `X-Webhook-Signature` | `sha256=<hex>` where `<hex>` is HMAC-SHA256 over `${timestamp}.${rawBody}`, keyed with the shared secret. |

The backend helper is `signWebhook(secret, rawBody, timestampSeconds)`. Sign the
exact bytes you send. Re-serialising JSON changes the signature.

Shared secret: `WEBHOOK_SECRET` (at least 32 random characters, for example
`openssl rand -hex 32`). The guard refuses to start with an empty secret.

## Responses

| Status | Meaning |
|---|---|
| 401 | Missing header, malformed timestamp, timestamp outside the window, or bad signature. |
| 409 | The same signature was already accepted inside the window (replay). |
| 500 | Server misconfiguration: the route is missing the raw-body parser. |

## Timestamp window and replays

- Accepted when within `WEBHOOK_TOLERANCE_SECONDS` (default 300) of server time, either direction.
- A valid signature is stored for twice the tolerance. A second delivery in that period gets 409.
- Only validly signed requests are stored.
- Retries: this backend does not retry. If you retry, re-sign with a fresh timestamp, or treat 409 as "already delivered".

## Limits

- The replay store is per process. Multi-instance deployments need a shared store behind `getRedis()`.
- Keep server and sender clocks in sync (NTP).
- Rotate the secret by deploying the new value to both sides.
