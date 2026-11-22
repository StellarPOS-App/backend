# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Redis-backed exchange-rate cache (60-second TTL, single-flight fetches) for all Stellar checkout conversions, with a configured-rate fallback.
- Transactional outbox for order confirmations: the email row commits with the sale and is delivered asynchronously, exactly once per sale.
- Merchant email verification endpoints (`/api/v1/verification/send`, `/resend`, `/confirm`, `/status`) with a 24-hour link lifetime and resend cooldown.
- Human-readable Stellar memos containing merchant name and order total within the 28-byte `MEMO_TEXT` limit.
- Dead-letter queue inspection and requeue: failed jobs keep id, payload, error, stack and timestamp; admin endpoints `GET /api/v1/queues/dead-letters` and `POST /api/v1/queues/dead-letters/:id/requeue` (#211).
- API versioning policy (`docs/versioning.md`), an `X-API-Version` header on `/api/v1` responses, and a 404 listing supported versions for unknown `/api/v<N>` paths (#212).
- `webhookReplayGuard` middleware (signed timestamp window plus short-lived replay store) and `docs/webhooks.md` for future webhook routes (#209).
- CI scans the built Docker image with Trivy and fails on fixable HIGH or
  CRITICAL vulnerabilities.

## [0.2.0]

The first version that boots, serves real data, and takes payments.

### Added
- Embedded SQLite (`node:sqlite`) schema for users, products, customers, sales,
  line items, payments, and Stellar payment requests.
- JWT auth with admin, manager and cashier roles; staff management; profile and
  password updates.
- Products with search, categories, low-stock flags, stock adjustments, and
  archive-on-delete.
- Customers with visit and lifetime-spend stats.
- Atomic sales with stock reservation, discounts, tax, voids, and refunds.
- Cash (with change), card, and split-tender payments.
- Stellar checkout: SEP-0007 QR requests, a Horizon payment watcher with a
  persisted cursor, on-chain verification by hash, and request expiry that
  releases stock.
- Analytics: summary, daily revenue, hourly histogram, top products.
- Socket.IO events for payments, completed sales, and low stock.
- Demo seed script, Dockerfile, docker-compose, CI on Node 22 and 24.
- 56 tests.

### Removed
- Unused dependencies (Prisma, Bull, Twilio, Sharp, PM2, and others) that were
  declared but never wired up.
- The commit-generation script and the fabricated contributor list.
