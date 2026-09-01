# Methodology and caveats

Read this before presenting.

This is vendor-authored competitive material, so the method is stated in full
and the code is short enough to audit. A rigged benchmark is worse than no
benchmark: the first thing a customer's DBA will do is read
`src/redis-store.js` and `src/postgres-store.js`.

---

## Both engines answer the same question

- **The same corpus, byte-identical.** 100,000 customers, 50 transactions
  each, generated once to `data/customers.jsonl` and loaded into both stores.
  `npm run validate` recomputes every expected answer independently from that
  file and checks it against what each store returns — not against what the
  other store returns, which would prove nothing if both were wrong.
- **One scoring function, `src/scoring.js`, used by both.** Whichever store
  answers a request, the risk score and the ALLOW/REVIEW/DECLINE decision
  come out of the identical code path. There's no way for one engine to
  "win" by scoring more leniently.
- **Postgres has a real, non-trivial schema.** Two tables, a foreign key,
  four indexes — `customers_pkey`, `transactions_pkey`,
  `(customer_id, occurred_at DESC)` for the history/velocity queries, and
  `(category, outcome)` for the breakdown aggregate. `ANALYZE` runs before
  any timing, so the planner has real statistics.
- **No artificial resource cap on either engine.** Both containers share the
  full host — 14 cores, no memory limit, no licence-imposed CPU ceiling.
  That's a genuine difference from a licensed-database comparison, where a
  free tier's CPU cap would need its own caveat on every throughput number.

## How timing works

- The `/api/score`, `/api/velocity`, and `/api/breakdown` endpoints each run
  the requested number of samples **alternating which engine goes first**,
  so neither systematically benefits from running second (a warm cache, a
  just-reused connection).
- The **median** is reported, never the minimum.
- Times are wall clock, measured in the application via
  `process.hrtime.bigint()`.
- The UI never claims two engines agree unless they returned the same
  decision (score/velocity/breakdown all check this and surface a
  "disagreement" state instead of a speed multiplier if they don't).

## Write-time vs read-time: the breakdown numbers are not the same query twice

The portfolio breakdown scenario is the one place in this demo where the two
engines are doing **fundamentally different work**, not the same query
answered by two implementations:

- **Redis pays at write time.** Every `appendTransaction` call does
  `HINCRBY breakdown:by_category <category>|<outcome> 1` inside the same
  `MULTI`/`EXEC` as the write. Reading the breakdown is one `HGETALL` —
  O(1) regardless of how many transactions exist.
- **Postgres pays at read time.** `SELECT category, outcome, COUNT(*) FROM
  transactions GROUP BY category, outcome` has to touch the full transaction
  table on every call. There's no maintained aggregate; a real one would be a
  materialized view (with its own staleness question) or a
  trigger-maintained summary table (which is, structurally, doing what Redis
  does here).

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on the live 5,000,000-row table:

```
Finalize GroupAggregate (actual time=245.640..249.797 rows=30 loops=1)
  ->  Gather Merge (Workers Planned: 2, Workers Launched: 2)
        ->  Partial GroupAggregate (actual time=11.154..165.902 rows=21 loops=3)
              ->  Parallel Index Only Scan using transactions_category_outcome_idx
                    (actual time=0.022..67.806 rows=1666667 loops=3)
                    Heap Fetches: 0
Execution Time: 249.912 ms
```

**This is not a weak plan.** `Heap Fetches: 0` means it's a true index-only
scan — Postgres never touches the heap at all, just the index — running
across two parallel workers, exactly what a well-tuned Postgres would do for
this query. It still costs ~250 ms, because summing 5,000,000 rows into 30
buckets is real work proportional to row count, no matter how good the plan
is. That's the point the demo is making: the cost didn't disappear, it moved
to write time in Redis and stayed at read time in Postgres.

**Why the measured ratio swings between ~130× and ~300× across runs.**
Redis's side of this comparison is sub-millisecond (a single `HGETALL`), so
ordinary host-level noise — GC pauses, other processes on the same 14-core
laptop, even a headless Chrome tab open for testing — moves its absolute time
by a factor of 2–3× run to run, while Postgres's ~150–250 ms barely moves.
Since the ratio's numerator is the noisy, tiny number, the ratio itself is
the least stable figure in this demo. Quote the two absolute numbers, not
just the multiplier, and expect the multiplier to vary.

## Postgres connection-pool scaling

`src/bench.js` drives each engine with one `worker_threads` worker per
concurrency level, matching Redis with one connection per worker on the
Postgres side. That wasn't the first thing tried.

The theory: `getCustomerAndHistory` issues two queries (`Promise.all` of the
customer row and the last-50-transaction query), which can't actually run
concurrently over a single physical connection — so giving each worker a
small pool (`max: 2` or `max: 4`) should let a competently-configured client
get real parallelism there.

**It made things worse, not better.** At concurrency 16:

| Pool size per worker | QPS |
| --------------------- | --- |
| 1 (final) | 6,212–7,433 |
| 4 | 1,530 |
| 2 | benchmark stalled past a 5-minute timeout |

16 workers × 4 connections is 64 live Postgres backend processes — Postgres
is one OS process per connection — competing for 14 cores. Past a modest
multiple of the core count, adding connections buys queueing, not
parallelism. This is exactly why production Postgres deployments front it
with a bounded pooler (PgBouncer) rather than letting client-side pools scale
freely.

**Don't increase the pool size in `src/bench.js` without re-running the full
sweep first.** The current `max: 1` is load-bearing, not an oversight.

## Concurrent throughput

`npm run bench` loads both engines sequentially, never at the same time, so
they never compete for the same cores while being measured.

| Concurrency | Redis QPS | Postgres QPS | Redis p99 | Postgres p99 |
| ----------- | --------- | ------------- | --------- | ------------- |
| 16 | 22,827 | 7,433 | 1.42 ms | 4.67 ms |

Neither client is CPU-bound at this concurrency — the load generator used
19% of the host driving Redis and 15% driving Postgres, both far from
saturation, so the QPS gap reflects the engines, not the generator. (Client
CPU is measured once, in the main thread, after each run — summing
`process.cpuUsage()` per worker would inflate it by the worker count, since
each worker's reading is already the whole process's usage, not just that
worker's share.)

Unlike a licensed-database comparison, **there is no CPU cap to caveat
here** — both engines share the full 14-core host. The 3.07× throughput
ratio is a like-for-like measurement in that specific sense.

## Impossible travel alone never DECLINEs

The `impossible_travel` scenario — a purchase thousands of miles from the
customer's last transaction, minutes later, the classic account-takeover
signal — tops out at REVIEW, never DECLINE, when nothing else about the
transaction is unusual. This is deliberate, not a scoring gap:

- geography: 30 points (the maximum for this factor)
- velocity: up to 4 points (one prior transaction inside the window)
- credit score: up to 20 points, only if the customer's own credit score is
  poor

30 + 4 + 20 = 54, below the 60-point DECLINE threshold. A modest-dollar
purchase that's merely far away and fast isn't, on its own, enough signal to
auto-decline in this model — it needs a second factor (an unfamiliar
category, an amount well above the customer's norm) to cross the line, which
is exactly what the `everything_at_once` scenario adds. Real fraud systems
work this way for a reason: geography alone has too many honest explanations
(VPNs, travel, family) to justify an automatic decline by itself.

## What this demo does not support

- **Corpus size.** 100k customers / 5M transactions fits comfortably on one
  laptop. Nothing here says anything about behavior once the working set
  exceeds available memory.
- **Concurrency beyond the throughput tab**, and that tab is single-node,
  single-machine.
- **Durability, replication, failover.** This Redis configuration has
  persistence turned off (`--save ""`, `--appendonly no`) precisely so the
  numbers reflect an in-memory operational store, not a durability story.
  Postgres's WAL and crash recovery aren't exercised here either.
- **A real FICO integration.** "Credit score" here is a gaussian-distributed
  synthetic field on the generated customer record, modeled on FICO's
  300–850 scale because that's a familiar shape — not a call to any credit
  bureau.
- **Anything relational.** No joins beyond the one FK, no multi-table
  reporting. This demo's Postgres schema is about as close to Redis's
  data model as a relational schema gets; a real ledger system would have
  more tables and more joins, which would only widen Postgres's advantage on
  relational composition, an advantage this demo doesn't attempt to show.
- **Cold start.** Both engines are measured warm — a seeding-time warm-up
  pass runs before the server accepts requests.

If a customer pushes on any of these, the honest answer is that this demo
doesn't cover it.

## Numbers drift when the generator changes

The corpus is deterministic (`SEED` in `src/config.js`), but deterministic
*for the current generator*. Changing `src/generate.js` — amount
distributions, category weights, the historical-outlier injection — changes
every count and every measured number in the README along with it. Re-run
`npm run seed`, `npm run validate`, and `npm run bench`, and re-measure
before quoting anything.
