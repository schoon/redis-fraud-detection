'use strict';

// Loads the generated customers and their transaction histories into Redis.
//
// Note the bulk-load path here is deliberately NOT "5,000,000 calls to
// appendTransaction()". That function exists to demonstrate the live
// write-path (one MULTI/EXEC per incoming transaction, atomic, with the
// breakdown counter incremented as it happens) — running it 5,000,000 times
// during a bulk seed would mean 5,000,000 round trips to build a dataset that
// COPY-equivalent bulk operations can build in a few seconds. So the seed path
// here does the analogous thing to Postgres's COPY: one ZADD per customer
// carrying all 50 score/member pairs at once, and the breakdown counters are
// computed as a single aggregate over the whole file rather than incremented
// 5,000,000 times. The end state is identical either way — what differs is
// how many round trips it took to get there, and that distinction is exactly
// what the write-path demo tab is for.

const fs = require('fs');
const readline = require('readline');
const { DATA_FILE } = require('./config');
const { createStore, serializeTxn } = require('./redis-store');
const { scoreTransaction } = require('./scoring');

const BATCH = 500; // customers per pipelined batch

function baselineScore(rec) {
  const history = rec.transactions.slice(0, -1);
  const candidate = rec.transactions[rec.transactions.length - 1];
  return scoreTransaction(rec, history, candidate);
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`${DATA_FILE} not found — run: npm run generate`);
  }

  const store = createStore();
  await store.connect();
  console.log('Connected to Redis');

  // FLUSHALL — this container is dedicated to the demo, so a clean slate each
  // run keeps the comparison honest.
  await store.client.flushAll();

  const loadStarted = Date.now();
  let custCount = 0;
  let txnCount = 0;
  const breakdownTotals = new Map(); // "<category>|<decision>" -> count

  let batch = [];
  const flush = async () => {
    await Promise.all(batch);
    batch = [];
  };

  const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const rec = JSON.parse(line);
    custCount += 1;

    const baseline = baselineScore(rec);

    batch.push(
      store.client.hSet(store.custKey(rec.id), {
        city: rec.city,
        state: rec.state,
        home_lat: String(rec.home_lat),
        home_lon: String(rec.home_lon),
        credit_score: String(rec.credit_score),
        signup_at: String(rec.signup_at),
        preferred_categories: rec.preferred_categories.join(','),
        current_score: String(baseline.risk),
        current_decision: baseline.decision,
        txn_count: String(rec.transactions.length),
      })
    );

    // One ZADD carrying all 50 score/member pairs — the bulk-load equivalent
    // of COPY, not 50 separate calls.
    const members = rec.transactions.map((t, i) => ({ score: t.ts, value: serializeTxn(t, i) }));
    batch.push(store.client.zAdd(store.txnsKey(rec.id), members));

    for (const t of rec.transactions) {
      txnCount += 1;
      const key = `${t.cat}|${t.out}`;
      breakdownTotals.set(key, (breakdownTotals.get(key) || 0) + 1);
    }

    if (batch.length >= BATCH * 2) {
      await flush();
      if (custCount % 20000 === 0) console.log(`  ${custCount.toLocaleString()} customers loaded...`);
    }
  }
  if (batch.length) await flush();

  // Breakdown counters, seeded as one aggregate write rather than 5,000,000
  // incremental ones — see the note at the top of this file.
  if (breakdownTotals.size) {
    const fields = {};
    for (const [key, count] of breakdownTotals) fields[key] = String(count);
    await store.client.hSet(store.BREAKDOWN_KEY, fields);
  }

  const loadMs = Date.now() - loadStarted;
  console.log(`\nLoaded ${custCount.toLocaleString()} customers and ${txnCount.toLocaleString()} transactions in ${loadMs} ms`);
  console.log(`  rate: ${Math.round(txnCount / (loadMs / 1000)).toLocaleString()} rows/sec`);

  const finalCustCount = await store.client.dbSize();
  console.log(`\n  keys in Redis: ${finalCustCount.toLocaleString()} (2 per customer + 1 breakdown Hash)`);
  const expectedKeys = custCount * 2 + 1;
  if (finalCustCount !== expectedKeys) {
    console.error(`  MISMATCH: expected ${expectedKeys.toLocaleString()} keys`);
    process.exitCode = 1;
  }

  console.log('\nWarming Redis (this is mostly a formality — Redis has no cold cache)...');
  const sampleIds = [];
  {
    const rl2 = readline.createInterface({ input: fs.createReadStream(DATA_FILE), crlfDelay: Infinity });
    for await (const line of rl2) {
      if (!line) break;
      sampleIds.push(JSON.parse(line).id);
      break;
    }
  }
  for (const id of sampleIds) await store.getCustomerAndHistory(id);
  console.log('Warm-up complete');

  await store.close();
}

main().catch(async (err) => {
  console.error('Seeding Redis failed:', err.message);
  process.exit(1);
});
