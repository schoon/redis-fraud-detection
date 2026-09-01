# redis-fraud-detection

A customer-facing demo comparing Redis against Postgres for real-time
credit/fraud decisioning. Node/Express backend, single-file vanilla
frontend, both engines in Docker.

Published at <https://github.com/schoon/redis-fraud-detection> (private).

## Stack

- **Backend:** Node.js + Express
- **Redis client:** the `redis` meta-package (not `@redis/client` alone) —
  this demo only uses core commands (Hashes, Sorted Sets, `MULTI`/`EXEC`),
  so either would work; the meta-package was already the dependency in the
  sibling demos and there was no reason to diverge.
- **Postgres:** `pg`, plus `pg-copy-streams` for the bulk seeder only. The
  live app code (`postgres-store.js`) uses plain parameterized queries —
  `pg-copy-streams` never appears outside `seed-postgres.js`.
- **Frontend:** one `public/index.html`. No framework, no build step.

## Commands

```bash
docker compose up -d     # Redis 8 on :6382, Postgres 16 on :5433
npm run seed             # generate 100k customers + 5M transactions, load both engines (~1.5 min)
npm start                # demo on :3030
npm run bench            # concurrent throughput sweep, writes data/bench-results.json
npm run validate         # independent ground-truth check, 12 checks
```

`npm run seed` is safe to re-run — both seeders wipe their engine first.

## The one rule that matters: both engines answer the same question

This is vendor-authored competitive material. A customer's DBA will read
`src/redis-store.js` and `src/postgres-store.js`. If the two engines are
found to be scoring differently, the demo is worse than useless — it costs
credibility.

**`src/scoring.js` is the single source of truth.** Every score and
decision, on both engines, must go through `scoreTransaction()`. Never let
either store's route implement its own risk logic — if a factor needs to
change, change it once, in that file.

**Every write goes through both `getCustomerAndHistory` call sites with the
same shape of history** — oldest-first, capped at 50, byte-identical between
stores. `npm run validate` checks this directly against the raw corpus file,
not by comparing the two stores to each other (two engines agreeing proves
nothing if both are wrong).

**The UI must keep refusing to show a speed multiplier when the two engines
disagree** on a decision or a count. `agree` / `countsMatch` / `totalsMatch`
exist for exactly this. Don't "fix" a disagreement by hiding it — find out
why they disagree.

**Report the median, never the minimum**, and keep alternating which engine
runs first in every timed comparison (`/api/score`, `/api/velocity`,
`/api/breakdown` all do this already).

**Impossible travel alone tops out at REVIEW, and that stays in.** It's
30 (geo) + up to 4 (velocity) + up to 20 (credit) = 54, below the 60-point
DECLINE threshold, on purpose — see
[docs/METHODOLOGY.md](docs/METHODOLOGY.md#impossible-travel-alone-never-declines).
Don't retune the weights to make this scenario DECLINE on its own; that would
be tuning the demo to a talking point rather than modeling realistic
business logic.

## Known traps — don't reintroduce these

**The Postgres COPY connection-release-timing bug.** In `seed-postgres.js`,
the pool connection used for `COPY` must only be released inside the
stream's `finish`/`error` handlers, never in a `finally` block that runs
synchronously after creating the stream. Releasing early returns a
still-busy connection to the pool mid-copy, and the resulting error
("Connection terminated") surfaces two steps later, nowhere near the actual
bug. The `copyInto()` helper exists specifically to get this right — don't
inline the COPY logic elsewhere without it.

**Don't increase the Postgres pool size in `src/bench.js` past one connection
per worker without re-running the full concurrency sweep.** It was tried at
`max: 2` and `max: 4` per worker on the reasonable-sounding theory that two
queries per request (`Promise.all` of the customer row and the history
range) could use real parallelism from a slightly bigger pool. It made
throughput *worse* — 16 workers × 4 connections is 64 OS-level Postgres
backend processes competing for 14 cores. Full numbers in
[docs/METHODOLOGY.md](docs/METHODOLOGY.md#postgres-connection-pool-scaling).

**`validate.js`'s write-path check mutates real state**, on both engines —
it's testing the actual write path, not a mock of it. So does the UI's Write
Path tab. Re-run `npm run seed` after either before taking or quoting any
measurement; don't add a "cleanup" step to `validate.js` itself; the mutation
is what makes the check honest (it's proving the real write path works, not
a side effect to be hidden).

**Frontend: guard every render function against stale/out-of-order
responses.** `search()` in `public/index.html` hands each `runXxx()`
function a `stale()` closure captured at call time; every function checks
`if (stale()) return;` immediately after its fetch resolves and before
touching the DOM. Without this, a slow request from a previously-selected
tab can resolve after a newer one and silently overwrite the UI with stale
content — this happened during development (the Breakdown tab intermittently
showed leftover Velocity content) and traced back to a Postgres `GROUP BY`
query that occasionally took ~800ms under load, arriving after the user had
already switched tabs. If you add a seventh tab, its render function needs
this guard too.

**CSS: don't give an element both a `hidden` attribute and an unconditional
`display` value on its class.** `[hidden]` and a class selector have equal
specificity, and the class rule — being an author rule — wins over the `hidden`
attribute regardless of source order. `.decision-row` had exactly this bug
(`display: flex` unconditionally, defeating `hidden`); the fix is an explicit
`.decision-row[hidden] { display: none; }` override. Same trap applies to any
future element toggled via the `hidden` attribute rather than a class.

## Redis data model

One Hash and one capped Sorted Set per customer, plus one shared counter Hash.

- `cust:<id>` — Hash. Customer fields: `city`, `state`, `home_lat`,
  `home_lon`, `credit_score`, `signup_at`, `preferred_categories`,
  `current_score`, `current_decision`, `txn_count`.
- `cust:<id>:txns` — Sorted Set, score = transaction timestamp (ms epoch),
  member = JSON-encoded transaction. Capped at exactly 50 members via
  `ZREMRANGEBYRANK 0 -51` inside the same `MULTI` as every `ZADD` — this is
  the operational window, not a ledger. Don't remove the trim.
- `breakdown:by_category` — Hash, one counter per `<category>|<outcome>`
  pair, maintained with `HINCRBY` at write time. This is what makes the
  breakdown tab O(1) on the Redis side; see
  [docs/METHODOLOGY.md](docs/METHODOLOGY.md#write-time-vs-read-time-the-breakdown-numbers-are-not-the-same-query-twice).

Every write (`appendTransaction`) touches all three in one `MULTI`/`EXEC`:
`ZADD` + `ZREMRANGEBYRANK` + `HSET` + `HINCRBY` ×2 (transaction count,
breakdown counter) → `EXEC`.

## Postgres schema

Two tables, one FK, four indexes:

- `customers` — `customer_id` (PK), city/state/lat/lon, `credit_score`,
  `signup_at`, `preferred_categories`, `current_score`, `current_decision`,
  `txn_count`.
- `transactions` — `id` (bigserial PK), `customer_id` (FK), `amount`,
  `category`, `lat`/`lon`, `occurred_at` (timestamptz), `outcome`. No cap —
  unlike Redis, this ledger keeps every row, which is the honest and
  realistic role for a relational transaction table.
- Indexes: `transactions_customer_time_idx (customer_id, occurred_at DESC)`
  for history/velocity; `transactions_category_outcome_idx (category,
  outcome)` for the breakdown aggregate.

`timestamptz` binding: write with a JS `Date` object, never a raw ms-epoch
number — `pg` won't coerce a bare number into `timestamptz`. Read back with
`Number(dateObject)`, which works via `Date.valueOf()`.

## Bulk-load vs live-write

`seed-redis.js` and `seed-postgres.js` use bulk operations — one `ZADD` per
customer carrying all 50 members, one `COPY` stream for Postgres, breakdown
counters aggregated in a JS `Map` during the pass and written as a **single**
final `HSET`. This is deliberately not the same code path as
`appendTransaction`/the live write-path route. Don't collapse them into one
function "for consistency" — the bulk path exists to load 5,000,000 rows in
seconds; the live path exists to demonstrate one real-time write, and its
cost (one `MULTI`/`EXEC` or one transaction) is exactly what's being
measured in the Write Path tab.

## Layout

```
docker-compose.yml
src/
  config.js        constants: ports, corpus size, PRNG seed
  generate.js       synthetic corpus -> data/customers.jsonl
  scoring.js        the single scoring function used by both engines
  scenarios.js      the 5 candidate-transaction presets
  redis-store.js    Redis queries + appendTransaction
  postgres-store.js Postgres queries + appendTransaction
  seed-redis.js     bulk loader
  seed-postgres.js  bulk loader (COPY)
  server.js         Express routes
  bench.js          concurrent throughput CLI (worker_threads)
  validate.js       independent ground-truth checks
public/
  index.html        the whole frontend
data/                generated, gitignored
docs/
  METHODOLOGY.md
```

Keep the frontend a single self-contained `index.html` — no build step.
