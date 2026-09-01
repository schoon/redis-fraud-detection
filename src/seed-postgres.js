'use strict';

// Loads the generated customers and their transaction histories into Postgres.
//
// Fairness matters here exactly as much as it did in the sibling demos. This
// gets:
//   - a normalised schema (customers + transactions), not one wide table
//   - the index a competent DBA would create first: (customer_id, occurred_at
//     DESC), which is what makes "last 50 transactions" a range scan instead
//     of a sequential scan over 5,000,000 rows
//   - a second index on (category, outcome) supporting the breakdown query
//   - COPY for the bulk load, which is the fast path Postgres itself
//     recommends for loading data — a loop of individual INSERTs would be
//     testing Node's round-trip overhead, not Postgres
//   - ANALYZE before any timing is taken, so the planner has real statistics

const fs = require('fs');
const readline = require('readline');
const { from: copyFrom } = require('pg-copy-streams');
const { DATA_FILE } = require('./config');
const pg = require('./postgres-store');
const { scoreTransaction } = require('./scoring');

// "The customer already has a score based on the last 50 transactions" is
// literal here: the stored baseline is the customer's own most recent
// transaction, scored by the same function used for live decisions, against
// the 49 that preceded it. Real, varied per customer — not a placeholder
// written identically for all 100,000 rows.
function baselineScore(rec) {
  const history = rec.transactions.slice(0, -1);
  const candidate = rec.transactions[rec.transactions.length - 1];
  return scoreTransaction(rec, history, candidate);
}

async function dropAll(pool) {
  await pool.query('drop table if exists transactions');
  await pool.query('drop table if exists customers');
}

async function createSchema(pool) {
  await pool.query(`
    create table customers (
      customer_id           varchar(12) primary key,
      city                  varchar(60),
      state                 varchar(4),
      home_lat              numeric(8,4),
      home_lon              numeric(8,4),
      credit_score          smallint,
      signup_at             timestamptz,
      preferred_categories  varchar(200),
      current_score         numeric(5,1),
      current_decision      varchar(10),
      txn_count             integer default 0
    )
  `);
  await pool.query(`
    create table transactions (
      id            bigserial primary key,
      customer_id   varchar(12) not null references customers(customer_id),
      amount        numeric(10,2) not null,
      category      varchar(30) not null,
      lat           numeric(8,4) not null,
      lon           numeric(8,4) not null,
      occurred_at   timestamptz not null,
      outcome       varchar(10) not null
    )
  `);
}

async function createIndexes(pool) {
  const t0 = Date.now();
  // THE index for this demo: everything the score & decision, velocity and
  // geography scenarios do reads through this one.
  await pool.query('create index transactions_customer_time_idx on transactions (customer_id, occurred_at desc)');
  // Supports the breakdown GROUP BY — an index-only scan candidate once the
  // table has been vacuumed, since the query needs no columns outside it.
  await pool.query('create index transactions_category_outcome_idx on transactions (category, outcome)');
  console.log(`  indexes: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Runs one COPY, streaming rows from `writeRows(stream)`, and releases the
// pool connection only once the server has actually acknowledged completion.
//
// The first version of this released the connection in a `finally` block that
// ran immediately after the stream was created — before `stream.end()` had
// even been reached, let alone before the server confirmed the copy was done.
// That returned a still-busy connection to the pool mid-copy, and the failure
// it produced ("Connection terminated") surfaced two steps later, on whatever
// next tried to use that connection — nowhere near the actual bug.
async function copyInto(pool, sql, writeRows) {
  const conn = await pool.connect();
  return new Promise((resolve, reject) => {
    const stream = conn.query(copyFrom(sql));
    const done = () => { conn.release(); resolve(); };
    const failed = (err) => { conn.release(); reject(err); };
    stream.on('finish', done);
    stream.on('error', failed);
    writeRows(stream).then(() => stream.end()).catch(failed);
  });
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`${DATA_FILE} not found — run: npm run generate`);
  }

  const pool = pg.init({ max: 8 });
  console.log('Connected to Postgres');

  await dropAll(pool);
  await createSchema(pool);
  console.log('Created customers + transactions tables');

  // COPY is the bulk-load path Postgres documents as the fast one. Two COPY
  // streams — customers first (transactions FK-reference them), then
  // transactions — fed by piping the same JSONL file through twice rather
  // than holding 5,000,000 rows in memory to build one giant payload.
  const loadStarted = Date.now();
  let custCount = 0;
  let txnCount = 0;

  await copyInto(
    pool,
    `copy customers (customer_id, city, state, home_lat, home_lon, credit_score,
       signup_at, preferred_categories, current_score, current_decision, txn_count)
     from stdin with (format csv)`,
    async (stream) => {
      const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        const rec = JSON.parse(line);
        custCount += 1;
        const baseline = baselineScore(rec);
        const row = [
          rec.id, csv(rec.city), rec.state, rec.home_lat, rec.home_lon, rec.credit_score,
          new Date(rec.signup_at).toISOString(), csv(rec.preferred_categories.join(',')),
          baseline.risk, baseline.decision, rec.transactions.length,
        ];
        if (!stream.write(`${row.join(',')}\n`)) {
          await new Promise((r) => stream.once('drain', r));
        }
      }
    }
  );
  console.log(`  ${custCount.toLocaleString()} customers loaded`);

  await copyInto(
    pool,
    `copy transactions (customer_id, amount, category, lat, lon, occurred_at, outcome)
     from stdin with (format csv)`,
    async (stream) => {
      const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        const rec = JSON.parse(line);
        for (const t of rec.transactions) {
          txnCount += 1;
          const row = [rec.id, t.amt, t.cat, t.lat, t.lon, new Date(t.ts).toISOString(), t.out];
          if (!stream.write(`${row.join(',')}\n`)) {
            await new Promise((r) => stream.once('drain', r));
          }
        }
        if (txnCount % 1000000 === 0) console.log(`  ${txnCount.toLocaleString()} transactions copied...`);
      }
    }
  );

  const loadMs = Date.now() - loadStarted;
  console.log(`\nLoaded ${custCount.toLocaleString()} customers and ${txnCount.toLocaleString()} transactions in ${loadMs} ms`);
  console.log(`  rate: ${Math.round(txnCount / (loadMs / 1000)).toLocaleString()} rows/sec`);

  console.log('\nBuilding indexes...');
  await createIndexes(pool);

  const analyzeStart = Date.now();
  await pool.query('analyze customers, transactions');
  console.log(`  ANALYZE: ${((Date.now() - analyzeStart) / 1000).toFixed(1)}s`);

  const finalCustCount = await pg.tableCount('customers');
  const finalTxnCount = await pg.tableCount('transactions');
  console.log(`\n  customers: ${finalCustCount.toLocaleString()}  transactions: ${finalTxnCount.toLocaleString()}`);
  if (finalCustCount !== custCount || finalTxnCount !== txnCount) {
    console.error('  MISMATCH between rows written and rows counted');
    process.exitCode = 1;
  }

  console.log('\nWarming Postgres (buffer cache, planner)...');
  const sample = await pg.query('select customer_id from customers limit 20');
  for (let pass = 0; pass < 3; pass += 1) {
    for (const row of sample) {
      await pg.getCustomerAndHistory(row.customer_id);
    }
  }
  await pg.breakdown();
  console.log('Warm-up complete');

  await pg.close();
}

// CSV escaping for the two free-text-ish fields (city names, comma-joined
// category lists) — quote and double any embedded quotes, per the CSV format
// COPY expects.
function csv(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main().catch(async (err) => {
  console.error('Seeding Postgres failed:', err.message);
  try { await pg.close(); } catch { /* already down */ }
  process.exit(1);
});
