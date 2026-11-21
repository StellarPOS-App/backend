# Environment variables

The server reads its configuration from environment variables, and loads a
`.env` file from the project root when one exists. `.env.example` lists the
same variables with comments. Copy it to `.env` and fill it in.

A variable is **required** when the server refuses to start without it. An
empty value counts as unset. Booleans accept `1`, `true`, `yes` or `on`
(case-insensitive). Any other value means false. Integers must parse as
whole numbers, or the server refuses to start.

## Server

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test`. Production turns on stricter checks (see `JWT_SECRET`) and hides internal error messages. |
| `PORT` | `3000` | Port the HTTP and Socket.IO server listens on. |
| `CLIENT_URL` | `http://localhost:5173` | Origin of the point-of-sale web app, allowed by CORS and Socket.IO. |
| `LOG_LEVEL` | `debug`, or `info` when `NODE_ENV=production` | Winston log level: `error`, `warn`, `info`, `debug`. |

## Auth

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | none (**required**) | Signs login tokens. Use a random string of at least 32 characters, for example `openssl rand -hex 32`. In production the server refuses secrets shorter than 32 characters. Never reuse it or commit it. |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime, in the format accepted by `jsonwebtoken`, for example `12h`, `1d` or `3600`. |

## Database and backups

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/stellarpos.db` | Path to the SQLite file. Use `:memory:` for a throwaway run. |
| `BACKUP_INTERVAL_HOURS` | `0` (off) | Hours between automatic snapshots. `0` turns them off. `npm run db:backup` always takes one on demand. |
| `BACKUP_DIR` | `./data/backups` | Folder where snapshots are written. |
| `BACKUP_KEEP` | `14` | Number of automatic snapshots to keep. |

## Email

| Variable | Default | Description |
|---|---|---|
| `EMAIL_PROVIDER` | `log` | `log` prints receipts to the console. `resend` sends them through `api.resend.com`. |
| `EMAIL_API_KEY` | empty | Resend API key. Required when `EMAIL_PROVIDER=resend`. |
| `EMAIL_FROM` | `StellarPOS <receipts@example.com>` | Sender address on receipts. Use an address on a domain you have verified with your provider. |

## Store

| Variable | Default | Description |
|---|---|---|
| `STORE_NAME` | `StellarPOS Store` | Store name shown on receipts and in `GET /api/v1/store`. |
| `STORE_CURRENCY` | `USD` | ISO 4217 code for prices and receipts. Stored in upper case. |
| `TAX_RATE_BPS` | `0` | Sales tax in basis points, from `0` to `10000`. `750` means 7.5%. |

## Stellar

| Variable | Default | Description |
|---|---|---|
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet`. Any other value stops start-up with an error. |
| `STELLAR_NETWORK_PASSPHRASE` | Passphrase for `STELLAR_NETWORK` | Must match `STELLAR_NETWORK`: `Test SDF Network ; September 2015` on testnet, `Public Global Stellar Network ; September 2015` on mainnet. Start-up stops on a mismatch. |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` on testnet, `https://horizon.stellar.org` on mainnet | Horizon API the backend reads from. Keep it on the same network as `STELLAR_NETWORK`. |
| `STELLAR_MERCHANT_PUBLIC_KEY` | empty | Public key (`G...`) that receives customer payments. Stellar checkout is disabled while it is empty. Never put a secret key (`S...`) here. The backend only watches this account and never signs for it. |
| `STELLAR_ASSET_CODE` | `XLM` | Asset customers pay in, for example `USDC`. |
| `STELLAR_ASSET_ISSUER` | empty | Issuer public key of the asset. Leave it empty for native `XLM`. Payments must match both code and issuer. |
| `STELLAR_ASSET_RATE` | `1` | Store-currency units per one unit of the asset. Use `1` for USDC priced in USD. |
| `STELLAR_PAYMENT_TTL_MINUTES` | `15` | Minutes before an unpaid QR checkout expires. Its sale is voided and its stock released. |
| `STELLAR_WATCHER_ENABLED` | `true`, or `false` when `NODE_ENV=test` | Polls Horizon for incoming payments and settles matching checkouts. |
| `STELLAR_WATCHER_INTERVAL_MS` | `5000` | Milliseconds between watcher polls. |
| `STELLAR_PAYMENT_PROCESSOR_ID` | empty | Optional. Contract ID of the payment processor, from the contracts repo's `deployments/<network>.json`. Exposed in `GET /api/v1/store`. |
| `STELLAR_MERCHANT_REGISTRY_ID` | empty | Optional. Contract ID of the merchant registry, from the same file. Exposed in `GET /api/v1/store`. |

## Operations

| Variable | Default | Description |
|---|---|---|
| `HEALTH_CHECK_TIMEOUT_MS` | `1000` | Longest wait for each dependency probe behind `GET /health` and `GET /healthz` (database, Horizon). A probe that exceeds it counts as down. |
| `METRICS_TOKEN` | empty | Optional. When set, `GET /metrics` requires `Authorization: Bearer <token>`. Empty leaves the endpoint open, so keep it on a private network. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | On `SIGTERM` or `SIGINT`: milliseconds in-flight requests may run before their sockets are cut. The job queue then gets the same budget to flush. Must be greater than 0. |

## Scripts only

| Variable | Default | Description |
|---|---|---|
| `SEED_FORCE` | unset | Set to `1` to run `npm run db:seed` even when users already exist. |

`npm_package_version` is set by npm when you run a script. The app reads it to report its version (see `src/app.ts`). You do not set it yourself.

## Webhooks

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SECRET` | empty | Shared secret for verifying inbound webhook signatures (HMAC-SHA256). Required once a route mounts `webhookReplayGuard`, which refuses to start with an empty secret. Use at least 32 random characters. Never commit it. See `docs/webhooks.md`. |
| `WEBHOOK_TOLERANCE_SECONDS` | `300` | Accepted clock skew for the signed webhook timestamp, in seconds, in both directions. Signatures are also remembered for twice this long to reject replays. |

## Test runs

`tests/setup.ts` sets the variables a test run needs, including an in-memory
database and a test `JWT_SECRET`. You do not need a `.env` file to run
`npm test`.
