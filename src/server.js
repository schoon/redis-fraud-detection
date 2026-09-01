'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { REDIS_URL, PORT, COUNT, TXNS_PER_CUSTOMER } = require('./config');
const { createStore } = require('./redis-store');
const pg = require('./postgres-store');
const { scoreTransaction, VELOCITY_WINDOW_MS } = require('./scoring');
const { SCENARIOS, buildScenario, pickLiveScenario } = require('./scenarios');

const app = express();
app.use(express.json());

// no-store across the whole demo — this is a single HTML file that gets
// edited while presenting, and a stale cached copy reading as "the fix didn't
// land" is a real failure mode a sibling demo hit during development.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, lastModified: false }));

const redis = createStore();

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function randomCustomerId() {
  return `C${String(Math.floor(Math.random() * COUNT)).padStart(9, '0')}`;
}

// GET /api/sample-customer — a random real customer id, for the UI to seed a
// scenario without the presenter typing one in.
app.get('/api/sample-customer', (req, res) => {
  res.json({ id: randomCustomerId() });
});

// GET /api/meta — scenario catalogue, for the UI dropdown.
app.get('/api/meta', (req, res) => {
  res.json({
    scenarios: Object.entries(SCENARIOS).map(([key, s]) => ({
      key, label: s.label, description: s.description, simulated: Boolean(s.simulated),
    })),
  });
});

// GET /api/score?customer=<id>&scenario=<key>&runs=N
//
// The headline endpoint. Builds a candidate transaction for the requested
// scenario (a non-timed setup step, using Redis's copy of the history — both
// stores are verified byte-identical at seed time), then times BOTH engines
// answering the SAME question with the SAME candidate: fetch this customer's
// last 50 transactions and score it with the one shared scoring function.
app.get('/api/score', async (req, res) => {
  const customerId = /^C\d{9}$/.test(req.query.customer || '') ? req.query.customer : null;
  const scenarioKey = SCENARIOS[req.query.scenario] ? req.query.scenario : 'typical';
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);

  try {
    const id = customerId || randomCustomerId();

    // Setup: fetch once (untimed) to build the scenario against real history.
    const setup = await redis.getCustomerAndHistory(id);
    if (!setup) return res.status(404).json({ error: `no such customer: ${id}` });
    const { candidate, injectedHistory, label, description, simulated } =
      buildScenario(scenarioKey, setup.customer, setup.history);

    const runOnce = async (fetchFn) => {
      const t0 = nowMs();
      const data = await fetchFn(id);
      const history = injectedHistory
        ? [...data.history.slice(0, TXNS_PER_CUSTOMER - injectedHistory.length), ...injectedHistory]
        : data.history;
      const result = scoreTransaction(data.customer, history, candidate);
      const ms = nowMs() - t0;
      return { ms, result, customer: data.customer };
    };

    const rTimes = [];
    const pTimes = [];
    let rOut;
    let pOut;
    for (let i = 0; i < runs; i += 1) {
      if (i % 2 === 0) {
        rOut = await runOnce(redis.getCustomerAndHistory);
        pOut = await runOnce(pg.getCustomerAndHistory);
      } else {
        pOut = await runOnce(pg.getCustomerAndHistory);
        rOut = await runOnce(redis.getCustomerAndHistory);
      }
      rTimes.push(rOut.ms);
      pTimes.push(pOut.ms);
    }

    const agree = rOut.result.decision === pOut.result.decision && rOut.result.risk === pOut.result.risk;

    res.json({
      customer: { id, ...rOut.customer },
      scenario: { key: scenarioKey, label, description, simulated },
      candidate,
      runs,
      redis: { ms: Number(median(rTimes).toFixed(3)), ...rOut.result },
      postgres: { ms: Number(median(pTimes).toFixed(3)), ...pOut.result },
      agree,
      speedup: Number((median(pTimes) / median(rTimes)).toFixed(1)),
    });
  } catch (err) {
    console.error('score failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/velocity?customer=<id>&windowMinutes=60&runs=N
//
// The raw primitive in isolation: how many of this customer's own real
// transactions fall in a trailing window as of their own most recent one.
// Redis: ZCOUNT, one range check over the Sorted Set. Postgres: COUNT(*) using
// the (customer_id, occurred_at) index range scan.
app.get('/api/velocity', async (req, res) => {
  const customerId = /^C\d{9}$/.test(req.query.customer || '') ? req.query.customer : null;
  const windowMinutes = Math.min(Math.max(Number(req.query.windowMinutes) || 60, 1), 10080);
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);

  try {
    const id = customerId || randomCustomerId();
    const last = await redis.lastTransaction(id);
    if (!last) return res.status(404).json({ error: `no such customer: ${id}` });
    const windowStart = last.ts - windowMinutes * 60000;

    const rTimes = [];
    const pTimes = [];
    let rCount;
    let pCount;
    for (let i = 0; i < runs; i += 1) {
      const doRedis = async () => {
        const t0 = nowMs();
        const c = await redis.velocityCount(id, windowStart, last.ts + 1);
        return { ms: nowMs() - t0, c };
      };
      const doPg = async () => {
        const t0 = nowMs();
        const c = await pg.velocityCount(id, new Date(windowStart), new Date(last.ts + 1));
        return { ms: nowMs() - t0, c };
      };
      let r; let p;
      if (i % 2 === 0) { r = await doRedis(); p = await doPg(); } else { p = await doPg(); r = await doRedis(); }
      rTimes.push(r.ms); pTimes.push(p.ms); rCount = r.c; pCount = p.c;
    }

    res.json({
      customer: id,
      windowMinutes,
      asOf: last.ts,
      runs,
      redis: { ms: Number(median(rTimes).toFixed(3)), count: rCount, query: `ZCOUNT cust:${id}:txns ${windowStart} (${last.ts + 1}` },
      postgres: {
        ms: Number(median(pTimes).toFixed(3)), count: pCount,
        query: `SELECT COUNT(*) FROM transactions WHERE customer_id='${id}' AND occurred_at >= ... AND occurred_at < ...`,
      },
      countsMatch: rCount === pCount,
      speedup: Number((median(pTimes) / median(rTimes)).toFixed(1)),
    });
  } catch (err) {
    console.error('velocity failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/breakdown — portfolio-wide count and totals by category and
// decision. Redis reads a maintained counter Hash (O(1) regardless of
// portfolio size); Postgres runs GROUP BY over the full transaction table.
// Deliberately different computational strategies — see METHODOLOGY.
app.get('/api/breakdown', async (req, res) => {
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 11);
  try {
    const rTimes = [];
    const pTimes = [];
    let rRows;
    let pRows;
    for (let i = 0; i < runs; i += 1) {
      const doRedis = async () => { const t0 = nowMs(); const rows = await redis.breakdown(); return { ms: nowMs() - t0, rows }; };
      const doPg = async () => { const t0 = nowMs(); const rows = await pg.breakdown(); return { ms: nowMs() - t0, rows }; };
      let r; let p;
      if (i % 2 === 0) { r = await doRedis(); p = await doPg(); } else { p = await doPg(); r = await doRedis(); }
      rTimes.push(r.ms); pTimes.push(p.ms); rRows = r.rows; pRows = p.rows;
    }

    const key = (row) => `${row.category}|${row.decision}`;
    const pMap = new Map(pRows.map((r) => [key(r), r.count]));
    const mismatches = rRows.filter((r) => pMap.get(key(r)) !== r.count);

    res.json({
      runs,
      redis: { ms: Number(median(rTimes).toFixed(3)), rows: rRows, query: 'HGETALL breakdown:by_category' },
      postgres: {
        ms: Number(median(pTimes).toFixed(3)), rows: pRows,
        query: 'SELECT category, outcome, COUNT(*) FROM transactions GROUP BY category, outcome',
      },
      totalsMatch: mismatches.length === 0,
      speedup: Number((median(pTimes) / median(rTimes)).toFixed(1)),
    });
  } catch (err) {
    console.error('breakdown failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/writepath — append one new (approved) transaction to a customer's
// history and update their rolling score, timed on both engines. Redis:
// MULTI/EXEC across two keys. Postgres: an explicit transaction across two
// statements, with no trimming — the ledger keeps growing.
app.post('/api/writepath', async (req, res) => {
  const customerId = /^C\d{9}$/.test(req.body.customer || '') ? req.body.customer : null;
  try {
    const id = customerId || randomCustomerId();
    const setup = await redis.getCustomerAndHistory(id);
    if (!setup) return res.status(404).json({ error: `no such customer: ${id}` });
    const { candidate } = buildScenario('typical', setup.customer, setup.history);
    const result = scoreTransaction(setup.customer, setup.history, candidate);
    const txn = { ...candidate, out: result.decision === 'DECLINE' ? 'DECLINE' : 'ALLOW' };

    const t0 = nowMs();
    await redis.appendTransaction(id, txn, result.risk, result.decision, setup.customer.txn_count || 0);
    const redisMs = nowMs() - t0;

    const t1 = nowMs();
    await pg.appendTransaction(id, txn, result.risk, result.decision);
    const pgMs = nowMs() - t1;

    res.json({
      customer: id,
      transaction: txn,
      decision: result.decision,
      risk: result.risk,
      redis: { ms: Number(redisMs.toFixed(3)), command: 'MULTI: ZADD + ZREMRANGEBYRANK + HSET + HINCRBY ×2 → EXEC' },
      postgres: { ms: Number(pgMs.toFixed(3)), command: 'BEGIN; INSERT transactions; UPDATE customers; COMMIT' },
      speedup: Number((pgMs / redisMs).toFixed(1)),
    });
  } catch (err) {
    console.error('writepath failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/live-batch?engine=redis&n=4
//
// Powers the Live Feed tab: a small batch of NEW candidate checkouts, built
// against real customers and scored for real against the requested engine —
// not a canned animation. Each item's `ms` is that one customer's actual
// wait: the time to fetch their last-50-transaction history from this engine
// and run the same scoreTransaction() everything else in this demo uses.
// The UI runs several of these loops concurrently per engine to show
// sustained rate, not just one-off latency.
app.get('/api/live-batch', async (req, res) => {
  const engine = req.query.engine === 'postgres' ? 'postgres' : 'redis';
  const n = Math.min(Math.max(Number(req.query.n) || 4, 1), 20);
  const store = engine === 'redis' ? redis : pg;

  try {
    const results = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomCustomerId();
      const t0 = nowMs();
      const data = await store.getCustomerAndHistory(id);
      if (!data) continue;
      const scenarioKey = pickLiveScenario();
      const { candidate, injectedHistory } = buildScenario(scenarioKey, data.customer, data.history);
      const history = injectedHistory
        ? [...data.history.slice(0, TXNS_PER_CUSTOMER - injectedHistory.length), ...injectedHistory]
        : data.history;
      const result = scoreTransaction(data.customer, history, candidate);
      const ms = nowMs() - t0;
      results.push({
        id, city: data.customer.city, state: data.customer.state,
        amt: candidate.amt, cat: candidate.cat,
        decision: result.decision, risk: result.risk,
        ms: Number(ms.toFixed(3)),
      });
    }
    res.json({ engine, results });
  } catch (err) {
    console.error('live-batch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/architecture — what actually got built on each side, read live.
app.get('/api/architecture', async (req, res) => {
  try {
    const dbSize = await redis.client.dbSize();
    const sampleKeys = { hash: 'cust:<id>', zset: 'cust:<id>:txns', counters: redis.BREAKDOWN_KEY };

    const cols = await pg.query(`
      select column_name, data_type, character_maximum_length as len
        from information_schema.columns
       where table_name = 'transactions' order by ordinal_position`);
    const idx = await pg.query(`
      select indexname, indexdef from pg_indexes where tablename in ('transactions','customers')`);
    const custCount = await pg.tableCount('customers');
    const txnCount = await pg.tableCount('transactions');
    const sizes = await pg.query(`
      select pg_size_pretty(pg_total_relation_size('transactions')) as txn_size,
             pg_size_pretty(pg_total_relation_size('customers')) as cust_size`);

    res.json({
      redis: {
        keys: dbSize,
        layout: sampleKeys,
        note: 'Sorted Set per customer capped at 50 members — the operational window, not a ledger.',
      },
      postgres: {
        columns: cols.map((c) => ({ name: c.column_name, type: c.data_type + (c.len ? `(${c.len})` : '') })),
        indexes: idx.map((i) => ({ name: i.indexname, def: i.indexdef })),
        customers: custCount,
        transactions: txnCount,
        sizeOnDisk: sizes[0],
      },
    });
  } catch (err) {
    console.error('architecture failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/environment — versions and harness facts, read live from both
// engines rather than hardcoded.
app.get('/api/environment', async (req, res) => {
  try {
    const redisInfo = await redis.client.info('server');
    const line = (key) => {
      const m = new RegExp(`^${key}:(.*)$`, 'm').exec(redisInfo);
      return m ? m[1].trim() : null;
    };
    const pgVer = await pg.query('show server_version');
    const dbSize = await redis.client.dbSize();
    const custCount = await pg.tableCount('customers').catch(() => null);
    const txnCount = await pg.tableCount('transactions').catch(() => null);

    res.json({
      corpus: { customers: COUNT, txnsPerCustomer: TXNS_PER_CUSTOMER, totalTxns: COUNT * TXNS_PER_CUSTOMER },
      redis: {
        version: line('redis_version'), mode: line('redis_mode'), os: line('os'),
        keys: dbSize, port: 6382,
      },
      postgres: {
        version: pgVer[0].server_version, customers: custCount, transactions: txnCount, port: 5433,
      },
      host: { node: process.version, platform: `${process.platform} ${process.arch}`, cores: require('os').cpus().length },
    });
  } catch (err) {
    console.error('environment failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bench-results — the last `npm run bench` sweep, read from disk.
// Not measured live: generating load and serving this page from the same
// process would have the load generator competing with what's being timed.
app.get('/api/bench-results', (req, res) => {
  const file = path.join(__dirname, '..', 'data', 'bench-results.json');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'no bench results yet — run: npm run bench' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — corpus counts on both sides, so the UI can prove they match.
app.get('/api/stats', async (req, res) => {
  try {
    const redisKeys = await redis.client.dbSize();
    const pgCustomers = await pg.tableCount('customers');
    const pgTransactions = await pg.tableCount('transactions');
    res.json({
      redis: { customers: Math.floor((redisKeys - 1) / 2) },
      postgres: { customers: pgCustomers, transactions: pgTransactions },
    });
  } catch (err) {
    console.error('stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await redis.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);

  pg.init({ max: 16 });
  const pgCount = await pg.tableCount('customers').catch(() => {
    throw new Error('Postgres tables not found — run: npm run seed');
  });
  console.log(`Connected to Postgres — ${pgCount.toLocaleString()} customers`);

  const redisKeys = await redis.client.dbSize();
  const redisCustomers = Math.floor((redisKeys - 1) / 2);
  console.log(`Redis: ${redisCustomers.toLocaleString()} customers`);
  if (redisCustomers !== pgCount) {
    console.warn('WARNING: customer counts differ between engines — re-run `npm run seed`');
  }

  const server = app.listen(PORT, () => {
    console.log(`\nDemo running at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Try: PORT=${Number(PORT) + 1} npm start`);
    } else {
      console.error(`Could not listen on ${PORT}: ${err.message || err.code || err}`);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message || err.code || err);
  process.exit(1);
});
