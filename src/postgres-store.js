'use strict';

// Postgres access, in one place — the system-of-record side of the demo.
//
// Two tables:
//   customers     one row per customer, including the maintained rolling score
//   transactions  every transaction ever, indexed for the access patterns this
//                 demo actually uses. Unlike Redis's capped Sorted Set,
//                 nothing is ever trimmed here — Postgres keeps the full
//                 ledger, which is the honest and realistic role for it.
//
// Bind variables throughout: string-interpolated SQL would force a hard parse
// on every call and would make Postgres look slower than it is.

const { Pool } = require('pg');
const { PG } = require('./config');

let pool = null;

function init({ max = 16 } = {}) {
  if (pool) return pool;
  pool = new Pool({ ...PG, max });
  return pool;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function tryExec(sql) {
  try {
    await pool.query(sql);
    return true;
  } catch {
    return false;
  }
}

// Same query the Redis path answers from one Sorted Set read: the customer row
// plus their last 50 transactions. Two statements rather than a join, because
// a join would return the customer's fixed columns 50 times over — wasted
// bytes neither engine should be charged for.
async function getCustomerAndHistory(id) {
  const [custRows, txnRows] = await Promise.all([
    pool.query('select * from customers where customer_id = $1', [id]),
    // ORDER BY ... DESC LIMIT 50 uses the (customer_id, occurred_at) index
    // directly. Reversed in JS to oldest-first below, matching the Redis path
    // exactly — neither engine is asked to sort more than the other.
    pool.query(
      `select amount, category, lat, lon, occurred_at, outcome
         from transactions
        where customer_id = $1
        order by occurred_at desc
        limit 50`,
      [id]
    ),
  ]);
  if (!custRows.rows.length) return null;
  const c = custRows.rows[0];
  const customer = {
    id: c.customer_id,
    city: c.city,
    state: c.state,
    home_lat: Number(c.home_lat),
    home_lon: Number(c.home_lon),
    credit_score: Number(c.credit_score),
    signup_at: Number(c.signup_at),
    preferred_categories: c.preferred_categories ? c.preferred_categories.split(',') : [],
    current_score: c.current_score !== null ? Number(c.current_score) : null,
    current_decision: c.current_decision,
    txn_count: c.txn_count !== null ? Number(c.txn_count) : null,
  };
  const history = txnRows.rows
    .map((r) => ({
      amt: Number(r.amount), cat: r.category,
      lat: Number(r.lat), lon: Number(r.lon),
      ts: Number(r.occurred_at), out: r.outcome,
    }))
    .reverse();
  return { customer, history };
}

// COUNT(*) with a time-range predicate — an index range scan on
// (customer_id, occurred_at), the direct equivalent of Redis's ZCOUNT.
async function velocityCount(id, windowStart, beforeTs) {
  const rows = await pool.query(
    `select count(*) as n from transactions
      where customer_id = $1 and occurred_at >= $2 and occurred_at < $3`,
    [id, windowStart, beforeTs]
  );
  return Number(rows.rows[0].n);
}

async function lastTransaction(id) {
  const rows = await pool.query(
    `select amount, category, lat, lon, occurred_at, outcome
       from transactions
      where customer_id = $1
      order by occurred_at desc
      limit 1`,
    [id]
  );
  if (!rows.rows.length) return null;
  const r = rows.rows[0];
  return { amt: Number(r.amount), cat: r.category, lat: Number(r.lat), lon: Number(r.lon), ts: Number(r.occurred_at), out: r.outcome };
}

// Plain GROUP BY over the full transaction table — no maintained counters, no
// special structure. This is read-time aggregation, the opposite computational
// strategy to Redis's write-time HINCRBY, and the two are compared explicitly
// as different strategies rather than the same query answered two ways — see
// docs/METHODOLOGY.md.
async function breakdown() {
  const rows = await pool.query(
    'select category, outcome as decision, count(*) as count from transactions group by category, outcome'
  );
  return rows.rows.map((r) => ({ category: r.category, decision: r.decision, count: Number(r.count) }));
}

// The write path: one transaction, two statements. No trimming — the ledger
// keeps growing, which is the point of using Postgres as the system of record.
async function appendTransaction(id, txn, newScore, newDecision) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `insert into transactions (customer_id, amount, category, lat, lon, occurred_at, outcome)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      // occurred_at is timestamptz, not a bare integer column — a raw ms-epoch
      // number bound to it either errors or is misread, so it's wrapped in a
      // Date, which the driver serialises correctly. On the read side, pg
      // hands timestamptz columns back as Date objects, and Number(aDate)
      // correctly yields ms-since-epoch via its valueOf(), which is why the
      // read path above can convert with a plain Number() and no extra parsing.
      [id, txn.amt, txn.cat, txn.lat, txn.lon, new Date(txn.ts), newDecision]
    );
    await client.query(
      `update customers
          set current_score = $2, current_decision = $3, txn_count = txn_count + 1
        where customer_id = $1`,
      [id, newScore, newDecision]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function tableCount(table) {
  const rows = await pool.query(`select count(*) as n from ${table}`);
  return Number(rows.rows[0].n);
}

module.exports = {
  init, close, query, tryExec,
  getCustomerAndHistory, velocityCount, lastTransaction, breakdown, appendTransaction,
  tableCount,
  getPool: () => pool,
};
