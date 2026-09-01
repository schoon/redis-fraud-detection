'use strict';

// Redis access, in one place — the operational, real-time side of the demo.
//
// Layout:
//   cust:<id>            Hash    profile + the maintained rolling score
//   cust:<id>:txns        Sorted Set   score = transaction timestamp (ms);
//                                      this SET IS the last-50 window — it is
//                                      trimmed to 50 members on every write, so
//                                      there is no separate "top 50" query, the
//                                      structure only ever holds 50
//   breakdown:by_category Hash    field "<category>|<decision>" -> count,
//                                  maintained with HINCRBY as transactions
//                                  land, so the portfolio-breakdown tab reads
//                                  one Hash instead of scanning anything
//
// Note what `cust:<id>:txns` deliberately is NOT: a full transaction ledger.
// Capping it at 50 means Redis here models the operational hot-path store for
// real-time decisioning, not the system of record — see the README section on
// what this demo does not claim. A real deployment would pair this with a
// durable ledger (which is exactly Postgres's role in this comparison).

const { createClient } = require('redis');
const { REDIS_URL } = require('./config');

function custKey(id) { return `cust:${id}`; }
function txnsKey(id) { return `cust:${id}:txns`; }
const BREAKDOWN_KEY = 'breakdown:by_category';

function serializeTxn(t, seq) {
  return JSON.stringify({ i: seq, amt: t.amt, cat: t.cat, lat: t.lat, lon: t.lon, ts: t.ts, out: t.out });
}

function parseTxn(raw) {
  const o = JSON.parse(raw);
  return { amt: o.amt, cat: o.cat, lat: o.lat, lon: o.lon, ts: o.ts, out: o.out };
}

function parseCustomer(id, hash) {
  if (!hash || !hash.credit_score) return null;
  return {
    id,
    city: hash.city,
    state: hash.state,
    home_lat: Number(hash.home_lat),
    home_lon: Number(hash.home_lon),
    credit_score: Number(hash.credit_score),
    signup_at: Number(hash.signup_at),
    preferred_categories: hash.preferred_categories ? hash.preferred_categories.split(',') : [],
    current_score: hash.current_score !== undefined ? Number(hash.current_score) : null,
    current_decision: hash.current_decision || null,
    txn_count: hash.txn_count !== undefined ? Number(hash.txn_count) : null,
  };
}

function createStore() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('Redis error:', err.message || err.code || err));

  async function connect() { await client.connect(); }
  async function close() { await client.quit(); }

  // Everything a candidate-transaction decision needs, in one round trip: the
  // customer's Hash and the full (already-capped-at-50) history Sorted Set,
  // pipelined together rather than issued as two sequential awaits.
  async function getCustomerAndHistory(id) {
    const multi = client.multi();
    multi.hGetAll(custKey(id));
    // ZRANGE cust:<id>:txns 0 49 REV — newest first, since that is the cheap
    // direction to read a Sorted Set from; reversed in JS to oldest-first,
    // which is the shape scoring.js expects. Postgres does the same thing
    // (ORDER BY occurred_at DESC LIMIT 50, then reverse) so neither engine is
    // asked to do more sorting work than the other.
    multi.zRange(txnsKey(id), 0, 49, { REV: true });
    const [hash, rawTxns] = await multi.exec();
    const customer = parseCustomer(id, hash);
    if (!customer) return null;
    const history = rawTxns.map(parseTxn).reverse();
    return { customer, history };
  }

  // ZCOUNT cust:<id>:txns <windowStart> (<beforeTs — a single O(log N) range
  // count over the Sorted Set. "(" makes the upper bound exclusive, matching
  // the candidate transaction itself never counting toward its own velocity.
  async function velocityCount(id, windowStart, beforeTs) {
    return client.zCount(txnsKey(id), windowStart, `(${beforeTs}`);
  }

  // The single most recent transaction, for the geography/impossible-travel
  // primitive in isolation — ZRANGE ... REV LIMIT 1 rather than fetching all 50
  // when only the last one is needed.
  async function lastTransaction(id) {
    const raw = await client.zRange(txnsKey(id), 0, 0, { REV: true });
    return raw.length ? parseTxn(raw[0]) : null;
  }

  // HGETALL breakdown:by_category — one Hash read regardless of portfolio
  // size, because the counts were maintained at write time rather than
  // computed at read time. That is the whole point of this scenario.
  async function breakdown() {
    const hash = await client.hGetAll(BREAKDOWN_KEY);
    const rows = [];
    for (const [field, count] of Object.entries(hash)) {
      const [category, decision] = field.split('|');
      rows.push({ category, decision, count: Number(count) });
    }
    return rows;
  }

  // The write path: append the new transaction, trim the window back to 50,
  // update the maintained rolling score, and bump the breakdown counter — all
  // in one MULTI/EXEC. This is the scenario MULTI/EXEC exists to demonstrate:
  // four structural changes across two keys, atomic, one round trip.
  async function appendTransaction(id, txn, newScore, newDecision, seq) {
    const multi = client.multi();
    // ZADD cust:<id>:txns <ts> <json>
    multi.zAdd(txnsKey(id), { score: txn.ts, value: serializeTxn(txn, seq) });
    // ZREMRANGEBYRANK cust:<id>:txns 0 -51 — ranks are 0-based ascending by
    // score, so 0..-51 is "everything except the top 50", which keeps the set
    // at exactly 50 members after every write regardless of how many it had.
    multi.zRemRangeByRank(txnsKey(id), 0, -51);
    multi.hSet(custKey(id), {
      current_score: String(newScore),
      current_decision: newDecision,
    });
    multi.hIncrBy(custKey(id), 'txn_count', 1);
    multi.hIncrBy(BREAKDOWN_KEY, `${txn.cat}|${newDecision}`, 1);
    await multi.exec();
  }

  return {
    client, connect, close,
    getCustomerAndHistory, velocityCount, lastTransaction, breakdown, appendTransaction,
    custKey, txnsKey, BREAKDOWN_KEY,
  };
}

module.exports = { createStore, serializeTxn, parseTxn, parseCustomer };
