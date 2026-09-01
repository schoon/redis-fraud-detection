'use strict';

// Concurrent throughput on the real-time scoring path — the actual question a
// fraud-decisioning system has to answer under load: how many "should we
// allow this transaction" decisions per second can each engine support, and
// what does the tail latency look like once it's busy.
//
// A CLI tool rather than a UI button, on purpose: generating load from inside
// the same process serving the demo page would have the load generator
// competing with the thing being measured. The UI's Throughput tab reads the
// results file this writes.
//
// Design choices carried over from the sibling demos, because they mattered
// there and matter here identically:
//   - worker_threads, not one event loop. A single-threaded Node client
//     saturates before either engine does.
//   - one connection/pool per worker, not a small pool shared across many —
//     that produced a 29x-looking "handicap" in the Oracle demo that was
//     mostly queueing on connection acquisition, not the engine.
//   - engines run sequentially, never at the same time, so they don't compete
//     for the same cores.
//   - client CPU is measured once, in the main thread, after the run — not
//     summed per worker (summing inflated an earlier demo's numbers by the
//     worker count).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { COUNT, DATA_FILE } = require('./config');

const RESULTS_FILE = path.join(path.dirname(DATA_FILE), 'bench-results.json');
const SCENARIOS = ['typical', 'impossible_travel', 'velocity_spike', 'large_unfamiliar_purchase', 'everything_at_once'];

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
function randomCustomerId(rng) {
  return `C${String(Math.floor(rng() * COUNT)).padStart(9, '0')}`;
}

if (!isMainThread) {
  const { engine, durationMs, workerIndex } = workerData;

  (async () => {
    const { createStore } = require('./redis-store');
    const pg = require('./postgres-store');
    const { scoreTransaction } = require('./scoring');
    const { buildScenario } = require('./scenarios');

    let redisStore = null;
    if (engine === 'redis') {
      redisStore = createStore();
      await redisStore.connect();
    } else {
      // One connection per worker, matching Redis. This was tried at 2 and 4
      // per worker on the theory that getCustomerAndHistory's Promise.all (two
      // queries: the customer row, the last-50 transactions) can't actually
      // run concurrently over a single physical connection, so a slightly
      // larger pool should let a competently-configured app get real
      // parallelism there. It made things WORSE, not better: at concurrency
      // 16, QPS fell from 6,212 (max=1) to 1,530 (max=4), and at concurrency
      // 32 with max=2 the whole run stalled long enough to hit a 5-minute
      // timeout. 16 workers x 4 connections is 64 live Postgres backend
      // processes competing for 14 cores, and Postgres — one OS process per
      // connection — degrades sharply once connection count runs well past
      // core count. This is exactly why real Postgres deployments front it
      // with a bounded pooler (PgBouncer) rather than letting client pools
      // scale freely. See docs/METHODOLOGY.md.
      pg.init({ max: 1 });
    }

    // A simple deterministic-per-worker RNG so each worker draws a different,
    // reproducible sequence of customers rather than every worker hammering
    // the same handful of keys/rows.
    let seed = (workerIndex + 1) * 2654435761;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const latencies = [];
    let errors = 0;
    const deadline = nowMs() + durationMs;
    let i = 0;

    while (nowMs() < deadline) {
      const id = randomCustomerId(rng);
      const scenarioKey = SCENARIOS[i % SCENARIOS.length];
      i += 1;
      const t0 = nowMs();
      try {
        const data = engine === 'redis'
          ? await redisStore.getCustomerAndHistory(id)
          : await pg.getCustomerAndHistory(id);
        if (data) {
          const { candidate, injectedHistory } = buildScenario(scenarioKey, data.customer, data.history);
          const history = injectedHistory
            ? [...data.history.slice(0, 50 - injectedHistory.length), ...injectedHistory]
            : data.history;
          scoreTransaction(data.customer, history, candidate);
        }
        latencies.push(nowMs() - t0);
      } catch {
        errors += 1;
      }
    }

    if (redisStore) await redisStore.close();
    parentPort.postMessage({ latencies, errors });
  })().catch((err) => {
    parentPort.postMessage({ latencies: [], errors: 1, fatal: err.message });
  });

  return;
}

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function runEngine(engine, concurrency, durationMs) {
  const cpu0 = process.cpuUsage();
  const wall0 = nowMs();
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, w) => new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { engine, durationMs, workerIndex: w } });
      worker.on('message', resolve);
      worker.on('error', reject);
    }))
  );
  const wallMs = nowMs() - wall0;
  const cpu1 = process.cpuUsage(cpu0);
  const cpuMs = (cpu1.user + cpu1.system) / 1000;

  const all = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const errors = results.reduce((n, r) => n + r.errors, 0);

  return {
    engine, count: all.length, errors,
    wallMs: Number(wallMs.toFixed(0)),
    qps: Math.round(all.length / (wallMs / 1000)),
    p50: Number(percentile(all, 50).toFixed(3)),
    p95: Number(percentile(all, 95).toFixed(3)),
    p99: Number(percentile(all, 99).toFixed(3)),
    max: Number((all[all.length - 1] || 0).toFixed(3)),
    clientCpuRatio: Number((cpuMs / wallMs).toFixed(2)),
  };
}

async function main() {
  const concurrency = Math.min(Number(arg('concurrency', 16)), 64);
  const durationMs = Number(arg('duration', 10)) * 1000;
  const warmupMs = 2000;
  const cores = os.cpus().length;

  console.log('Concurrent throughput — real-time score & decision');
  console.log(`  corpus:      ${COUNT.toLocaleString()} customers × 50 transactions`);
  console.log(`  concurrency: ${concurrency} worker threads per engine`);
  console.log(`  duration:    ${durationMs / 1000}s measured, ${warmupMs / 1000}s warm-up`);
  console.log(`  host:        ${cores} cores`);
  console.log('  engines run sequentially, never simultaneously\n');

  const out = { concurrency, durationSec: durationMs / 1000, cores, engines: {} };

  for (const engine of ['redis', 'postgres']) {
    process.stdout.write(`  ${engine}: warming up...`);
    await runEngine(engine, concurrency, warmupMs);
    process.stdout.write(' measuring...');
    const r = await runEngine(engine, concurrency, durationMs);
    out.engines[engine] = r;
    process.stdout.write(' done\n');
  }

  const r = out.engines.redis;
  const p = out.engines.postgres;

  console.log('\n           QPS        p50       p95       p99       max     errors');
  for (const e of [r, p]) {
    console.log(
      `  ${e.engine.padEnd(8)} ${String(e.qps).padStart(8)}  `
      + `${e.p50.toFixed(2).padStart(8)}  ${e.p95.toFixed(2).padStart(8)}  `
      + `${e.p99.toFixed(2).padStart(8)}  ${e.max.toFixed(2).padStart(8)}  ${String(e.errors).padStart(6)}`
    );
  }
  console.log(`\n  throughput ratio: ${(r.qps / p.qps).toFixed(2)}x  (redis / postgres)`);

  console.log(`\n  client CPU per wall second (vs ${cores} cores):`);
  for (const e of [r, p]) {
    const pct = ((e.clientCpuRatio / cores) * 100).toFixed(0);
    const warn = e.clientCpuRatio > cores * 0.8
      ? '  <-- CLIENT-BOUND: this is a load-generator limit, not an engine limit'
      : '';
    console.log(`    ${e.engine.padEnd(8)} ${e.clientCpuRatio.toFixed(2)} (${pct}% of host)${warn}`);
  }

  out.generatedAt = new Date().toISOString();
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
  console.log(`\n  results written to ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error('bench failed:', err.message);
  process.exit(1);
});
