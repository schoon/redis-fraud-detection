# redis-fraud-detection

Real-time credit/fraud decisioning: **Redis** vs **Postgres**, on the same
laptop, over an identical **100,000-customer, 5,000,000-transaction** corpus,
with per-decision latency shown live.

A buy-now-pay-later lender has to answer one question in real time on every
checkout: given this customer's last 50 transactions, should this new one be
allowed? The data — and the scoring logic — live identically in both engines.
The only thing that differs is how fast each one hands back the history that
gets scored.

> **Method and caveats live in [docs/METHODOLOGY.md](docs/METHODOLOGY.md).**
> Read it before presenting: it covers the write-time vs read-time
> aggregation trade-off, the Postgres connection-pool finding, and what this
> demo does not support.

## Quick start

```bash
npm install
npm run demo
```

Then open **<http://localhost:3030>**.

`npm run demo` starts both containers, generates 100,000 customers with 50
transactions each, loads Redis and Postgres, and starts the web server. On
this machine the full cycle — generate, load 5M rows into each engine, index,
`ANALYZE` — takes under two minutes.

### Before you start

| Need | Why |
| ---- | --- |
| **Docker** with Compose v2 | runs both engines |
| **Node.js 18+** | the app and seeders |
| **~1.5 GB free disk** | `data/customers.jsonl` (~480 MB) + Postgres's table and index storage (~830 MB) |
| Ports **3030**, **6382**, **5433** free | app, Redis, Postgres |

Ports are deliberately clear of any other Redis demo or a default local Redis
on 6379, so this can run alongside them.

### Running the steps individually

```bash
docker compose up -d          # Redis 8 on :6382, Postgres 16 on :5433
npm run seed                  # generate 100k customers, load both engines
npm start                     # http://localhost:3030
```

### Stopping

```bash
docker compose down
```

No volumes are declared, so this discards the data. `npm run seed` is safe to
re-run — both seeders wipe their engine first.

## The scenarios, and how each engine answers them

| Scenario | Redis | Postgres |
| -------- | ----- | -------- |
| **Score & decision** | `HGETALL cust:<id>` + `ZRANGE ... REV` for the last 50 | `SELECT` customer row + `SELECT ... ORDER BY occurred_at DESC LIMIT 50` |
| **Velocity** (transactions in a trailing window) | `ZCOUNT` | `COUNT(*)` over the `(customer_id, occurred_at)` index |
| **Portfolio breakdown** | `HGETALL` on one maintained counter Hash | `SELECT category, outcome, COUNT(*) ... GROUP BY` over 5M rows |
| **Write path** (append + rescoring) | one `MULTI`/`EXEC`: `ZADD` + `ZREMRANGEBYRANK` + `HSET` + `HINCRBY` ×2 | `BEGIN`; `INSERT`; `UPDATE`; `COMMIT` |
| **Concurrent throughput** | `npm run bench` | `npm run bench` |
| **Architecture** | one Hash + one capped Sorted Set per customer | two tables, four indexes, one FK |
| **Live feed** | `GET /api/live-batch?engine=redis` in a loop | `GET /api/live-batch?engine=postgres` in a loop |

Both engines run every scoring decision through the exact same function,
[`src/scoring.js`](src/scoring.js) — whichever store answers, the risk score
and the ALLOW/REVIEW/DECLINE decision come out of identical code. A latency
difference is a data-access difference, never a scoring difference.

## Live feed

The **Live Feed** tab is the "does this hold up checkout" answer in one
glance: real checkouts, real random customers, real scoring, streaming
through both engines side by side, at whatever rate each engine can sustain.
Each side shows the numbers that matter to a lender more than any benchmark —

- **checkouts/sec** — how many customers this engine can serve at once
  without anyone queueing
- **p50 / p99 / p99.9 wait** — how long the typical customer sits at
  checkout, and how long the unluckiest one in a hundred, then in a
  thousand, sits — computed live from a rolling window of the last ~5,000
  scored checkouts on each side, so it's a real (if short-horizon)
  percentile, not a single sample

The row list is deliberately throttled to a human-readable pace (roughly
7–8 new rows/sec per side); the rate and latency numbers above it are not —
they reflect every request, not just the ones drawn on screen. Redis
consistently runs at roughly double Postgres's rate here at zero extra
configuration, and its tail latency (p99.9) stays close to its own median
while Postgres's stretches further — the same pattern as the
[Concurrent throughput](#concurrent-throughput) benchmark, just watched live.

## Observed on one laptop

**Measured 2026-09-01.** 100,000 customers, 5,000,000 transactions, Redis 8
and Postgres 16 both in Docker on a 14-core Apple-silicon MacBook, neither
engine CPU-capped. Median of 5 runs per sample.

| Scenario | Redis | Postgres | Ratio |
| -------- | ----- | -------- | ----- |
| Score & decision (typical purchase) | 0.52 ms | 0.73 ms | **1.4×** |
| Velocity (1-hour window) | 0.26 ms | 0.37 ms | **1.4×** |
| Write path (append + rescoring) | 1.33 ms | 9.57 ms | **7.2×** |
| Portfolio breakdown (5M-row aggregate) | 0.5–0.9 ms | ~155 ms | **~150–290×** |

**Read the breakdown row before you present it.** That gap isn't "Redis is
faster at the same query" — it's two different computational strategies. See
[Methodology](docs/METHODOLOGY.md#write-time-vs-read-time-the-breakdown-numbers-are-not-the-same-query-twice).

Every scenario reaches the **same ALLOW/REVIEW/DECLINE decision** on both
engines, verified against independently-computed ground truth — see
[Validating the results](#validating-the-results).

Loading the same 5,000,000 transactions:

| | Redis | Postgres |
| --- | ----- | -------- |
| Load rate | ~530,000–580,000 rows/sec | ~66,000–68,000 rows/sec |
| Index build | included in the write | 5.8 s for 4 indexes, then 0.4 s for `ANALYZE` |
| On disk | ~130 MB resident (200,001 keys) | ~808 MB transactions + ~16 MB customers |

## Concurrent throughput

```bash
npm run bench
npm run bench -- --concurrency=8 --duration=15
```

**Measured 2026-09-02, concurrency 16, 8s per engine:**

| Engine | QPS | p50 | p95 | p99 | p99.9 | max | client CPU |
| ------ | --- | --- | --- | --- | ----- | --- | ---------- |
| Redis | 23,360 | 0.62 ms | 1.03 ms | 1.27 ms | 1.78 ms | 39.1 ms | 19% of 14 cores |
| Postgres | 9,929 | 1.34 ms | 2.51 ms | 3.66 ms | 8.42 ms | 93.3 ms | 18% of 14 cores |

**p99.9 is the number that answers "does this ever hold up a customer."**
The median tells you about the typical checkout; p99.9 tells you what the
unluckiest one in a thousand actually experiences. Here Redis's tail barely
moves off its median (0.62 ms → 1.78 ms) while Postgres's stretches
considerably further (1.34 ms → 8.42 ms) — neither is slow enough to notice
at checkout at this concurrency, but the gap is real and it widens the
further out the tail you look.

**2.35× throughput.** Unlike a licensed database with a CPU-count cap, neither
engine here is artificially constrained — both share the full 14-core host,
so this ratio is not caveated the way a licensed-engine comparison would be.
Neither client is CPU-bound at these numbers (see
[Methodology](docs/METHODOLOGY.md#concurrent-throughput)), so the gap is the
engines, not the load generator.

One real, load-bearing finding from building this benchmark: increasing the
Postgres client connection pool past one connection per worker made
throughput **worse**, not better — see
[Methodology](docs/METHODOLOGY.md#postgres-connection-pool-scaling) before
changing `src/bench.js`.

## Validating the results

```bash
npm run validate
```

Every expected answer — corpus counts, velocity counts, geo distances,
portfolio totals, decisions — is computed **independently** from
`data/customers.jsonl` in plain JavaScript, with no help from either engine,
then compared against what Redis and Postgres actually return. Two engines
agreeing proves nothing if both are wrong.

**Last clean run: 12 checks, 12 passed, 0 failed.**

⚠️ `validate.js`'s own write-path check appends one real transaction to both
stores as part of verifying the write path. Re-run `npm run seed` after
`npm run validate` (or before taking any measurement you plan to quote) to
get back to a pristine 5,000,000-row corpus.

## The five scenarios, in the UI

| Preset | What it demonstrates |
| ------ | --------------------- |
| **Typical purchase** | The common case — same category, similar amount, near home. ~99% ALLOW. |
| **Impossible travel** | Thousands of miles from the last transaction, minutes later. Always REVIEW, never DECLINE on its own — see [Methodology](docs/METHODOLOGY.md#impossible-travel-alone-never-declines) for why that's a deliberate scoring choice, not a bug. |
| **Velocity spike** | Four purchases in twenty minutes (simulated — never written to either store), then a fifth. |
| **Large, unfamiliar purchase** | A high-value buy in a category this specific customer has never used. |
| **Everything at once** | Far away, unfamiliar high-risk category, well above typical spend. Reliably DECLINEs. |

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `COUNT` | `100000` | Corpus size |
| `REDIS_URL` | `redis://localhost:6382` | Redis connection |
| `PORT` | `3030` | Demo web server |

Postgres connection details (`localhost:5433`, user/db `fraud`/`frauddb`) are
in [`src/config.js`](src/config.js).

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `Postgres tables not found — run: npm run seed` | Postgres was recreated. Re-run `npm run seed`. |
| `WARNING: customer counts differ between engines` on startup | One store is stale relative to the other — usually from `npm run validate` or manual write-path testing. Re-run `npm run seed`. |
| `Port 3030 is in use` | `PORT=3031 npm start` |
| Breakdown tab shows a huge ratio (200×+) one moment and a small one the next | The Postgres `GROUP BY` over 5M rows is sensitive to host contention — see [Methodology](docs/METHODOLOGY.md#write-time-vs-read-time-the-breakdown-numbers-are-not-the-same-query-twice). Not a bug; try again on a quieter machine. |
| Throughput tab shows "not run yet" | Run `npm run bench` once; the UI reads its output file, it doesn't generate load itself. |

## Not safe to expose

No authentication, no rate limiting, and the Postgres password is in
`docker-compose.yml`. It's a local demo — keep it on localhost.
