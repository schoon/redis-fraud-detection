'use strict';

// Generates 100,000 synthetic customers, each with a 50-transaction purchase
// history, to data/customers.jsonl — one JSON line per customer with an
// embedded, time-ordered array of transactions.
//
// "Typical" behaviour is the whole point: each customer gets a home location, a
// spend level and a small set of preferred merchant categories, and their 50
// transactions cluster around that profile — mostly near home, mostly in their
// usual categories, amounts scaled to their spend level. That's what makes the
// scoring demo mean anything: a candidate transaction can be evaluated against
// a customer's *actual* pattern instead of a population average, and the rare
// deliberate outliers below are what the anomaly scenarios detect.
//
// Every customer also gets a handful of history transactions seeded as genuine
// outliers on purpose (one far-from-home trip, one off-pattern splurge) so the
// scoring functions have real anomalies to find during validation — not just
// candidates constructed for the demo, but *history* that looks like a real
// portfolio, some of it already unusual.

const fs = require('fs');
const path = require('path');
const { COUNT, TXNS_PER_CUSTOMER, DATA_FILE, SEED } = require('./config');

function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller, for amounts and score noise. Deterministic given `random`.
function gaussian(random) {
  const u1 = Math.max(random(), 1e-9);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// US-weighted, since FICO-style scoring is a US concept, with enough spread
// that geographic anomalies (a purchase suddenly originating on the other side
// of the country, or the world) are meaningful distances.
const CITIES = [
  ['New York', 'NY', 40.7128, -74.0060], ['Los Angeles', 'CA', 34.0522, -118.2437],
  ['Chicago', 'IL', 41.8781, -87.6298], ['Houston', 'TX', 29.7604, -95.3698],
  ['Phoenix', 'AZ', 33.4484, -112.0740], ['Philadelphia', 'PA', 39.9526, -75.1652],
  ['San Antonio', 'TX', 29.4241, -98.4936], ['San Diego', 'CA', 32.7157, -117.1611],
  ['Dallas', 'TX', 32.7767, -96.7970], ['Austin', 'TX', 30.2672, -97.7431],
  ['Seattle', 'WA', 47.6062, -122.3321], ['Denver', 'CO', 39.7392, -104.9903],
  ['Boston', 'MA', 42.3601, -71.0589], ['Atlanta', 'GA', 33.7490, -84.3880],
  ['Miami', 'FL', 25.7617, -80.1918], ['Minneapolis', 'MN', 44.9778, -93.2650],
  ['Detroit', 'MI', 42.3314, -83.0458], ['Portland', 'OR', 45.5152, -122.6784],
  ['Charlotte', 'NC', 35.2271, -80.8431], ['Nashville', 'TN', 36.1627, -86.7816],
  ['Columbus', 'OH', 39.9612, -82.9988], ['Indianapolis', 'IN', 39.7684, -86.1581],
  ['San Francisco', 'CA', 37.7749, -122.4194], ['Las Vegas', 'NV', 36.1699, -115.1398],
  ['Kansas City', 'MO', 39.0997, -94.5786],
];

// Rare far-flung origins, for the deliberate outliers below — the kind of
// place a card-not-present transaction originates from when something is
// genuinely wrong, whether that's travel or a proxied fraud attempt.
const FAR_LOCATIONS = [
  ['Lagos', 'NG', 6.5244, 3.3792], ['Bucharest', 'RO', 44.4268, 26.1025],
  ['Manila', 'PH', 14.5995, 120.9842], ['Jakarta', 'ID', -6.2088, 106.8456],
  ['Ho Chi Minh City', 'VN', 10.8231, 106.6297], ['Karachi', 'PK', 24.8607, 67.0011],
  ['London', 'GB', 51.5072, -0.1276], ['Dubai', 'AE', 25.2048, 55.2708],
];

// [category, typicalMin, typicalMax, isHighRisk]. High-risk categories are the
// ones a fraud analyst watches more closely for a new-to-customer occurrence —
// easily resold or hard to reverse.
const CATEGORIES = [
  ['grocery', 15, 160, false],
  ['restaurant', 10, 120, false],
  ['fuel', 20, 90, false],
  ['pharmacy', 8, 80, false],
  ['clothing', 20, 250, false],
  ['home_improvement', 25, 400, false],
  ['subscription', 5, 60, false],
  ['entertainment', 10, 150, false],
  ['electronics', 50, 2200, true],
  ['travel', 100, 1800, false],
  ['jewelry', 100, 6000, true],
  ['online_marketplace', 15, 600, false],
  ['gaming', 10, 500, true],
  ['luxury_goods', 200, 9000, true],
  ['gift_cards', 25, 1000, true],
];

const HIGH_RISK = new Set(CATEGORIES.filter((c) => c[3]).map((c) => c[0]));

const NOW = Date.parse('2026-09-01T00:00:00Z');
const HISTORY_SPAN_MS = 180 * 24 * 3600 * 1000; // last 180 days

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function main() {
  const random = makeRandom(SEED);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const pickWeighted = (arr, weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = random() * total;
    for (let i = 0; i < arr.length; i += 1) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  };

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const out = fs.createWriteStream(DATA_FILE);
  const started = Date.now();

  let totalTxns = 0;

  for (let c = 0; c < COUNT; c += 1) {
    const custId = `C${String(c).padStart(9, '0')}`;
    const [city, state, homeLat, homeLon] = pick(CITIES);

    // FICO-style score, 300-850, skewed toward the mid-upper range the way
    // real credit-score populations are (most people are fair-to-good, a long
    // thin tail runs low).
    const creditScore = Math.max(300, Math.min(850, Math.round(680 + gaussian(random) * 75)));

    // Each customer's spend level: most transactions scale off this multiplier
    // rather than off the category's raw range, which is what makes "$40 at
    // the grocery store" typical for one customer and low for another. Clamped
    // — the lognormal tail was otherwise long enough to put a "$170,000
    // jewelry purchase" into a portfolio of ordinary customers, which is the
    // kind of absurd outlier that undermines the demo's credibility rather
    // than illustrating a real one.
    const spendLevel = Math.min(3, Math.exp(gaussian(random) * 0.4)); // ~0.45x - 3x

    // 2-4 preferred categories drive most of this customer's history. A
    // purchase outside that set later reads as a real behavioural change, not
    // just "a category we haven't seen in 50 rows" for every customer equally.
    const prefCount = 2 + Math.floor(random() * 3);
    const preferred = [];
    const pool = [...CATEGORIES];
    for (let i = 0; i < prefCount && pool.length; i += 1) {
      const idx = Math.floor(random() * pool.length);
      preferred.push(pool.splice(idx, 1)[0]);
    }

    const signupAt = NOW - Math.floor(random() * 3 * 365 * 24 * 3600 * 1000);

    // Transaction timestamps: 50 draws over the last 180 days, sorted
    // ascending, with realistic clustering (more recent activity is denser)
    // rather than perfectly uniform spacing.
    const timestamps = [];
    for (let i = 0; i < TXNS_PER_CUSTOMER; i += 1) {
      const t = NOW - Math.pow(random(), 1.6) * HISTORY_SPAN_MS;
      timestamps.push(Math.round(t));
    }
    timestamps.sort((a, b) => a - b);

    // Two genuine outliers seeded into the HISTORY itself (not the candidate
    // used for a live demo query) — one geographic, one a category/amount
    // splurge — so a portfolio scan finds real anomalies, not only staged
    // ones. Both land in the middle of the history, never as the very last
    // transaction, so they don't get double-counted as "the customer's most
    // recent location" for every velocity/geo check.
    const geoOutlierIdx = 10 + Math.floor(random() * 25);
    const splurgeOutlierIdx = 10 + Math.floor(random() * 25);

    const transactions = [];
    let lastLat = homeLat;
    let lastLon = homeLon;

    for (let i = 0; i < TXNS_PER_CUSTOMER; i += 1) {
      const isGeoOutlier = i === geoOutlierIdx;
      const isSplurge = i === splurgeOutlierIdx && i !== geoOutlierIdx;

      // Category: usually from the preferred set, occasionally a random one.
      const useOther = random() < 0.12 || preferred.length === 0;
      const [cat, catMin, catMax] = useOther ? pick(CATEGORIES) : pick(preferred);

      let amount = catMin + random() * (catMax - catMin);
      amount *= spendLevel;
      if (isSplurge) amount *= 2 + random() * 2; // 2x-4x spike
      // Soft ceiling above $6,000 rather than a hard clamp. A flat Math.min
      // cap put 1,919 transactions at exactly $15,000.00 out of one million
      // sampled — a pile-up any real dataset would never produce, and the
      // first thing anyone inspecting the data would notice. This compresses
      // the tail smoothly instead: amounts below the threshold are untouched,
      // and everything above it approaches (but never quite reaches) roughly
      // double the threshold, so extreme category/spend combinations stay
      // large without ever colliding on one repeated value.
      if (amount > 6000) amount = 6000 + 6000 * (1 - Math.exp(-(amount - 6000) / 6000));
      amount = Math.round(amount * 100) / 100;

      let lat = homeLat + (random() - 0.5) * 0.6; // ~±25 miles jitter
      let lon = homeLon + (random() - 0.5) * 0.6;
      if (isGeoOutlier) {
        const [, , flat, flon] = random() < 0.5 ? pick(FAR_LOCATIONS) : pick(CITIES);
        lat = flat + (random() - 0.5) * 0.3;
        lon = flon + (random() - 0.5) * 0.3;
      }

      // Historical outcome: the overwhelming majority of real transactions are
      // legitimate. A small tail of the seeded outliers were themselves
      // declined at the time, which is realistic and gives the write-path and
      // breakdown scenarios a non-trivial decline rate to show.
      const outcome = (isGeoOutlier && random() < 0.4) || (isSplurge && random() < 0.15)
        ? 'DECLINE' : 'ALLOW';

      transactions.push({
        amt: amount,
        cat,
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        ts: timestamps[i],
        out: outcome,
      });

      lastLat = lat;
      lastLon = lon;
      totalTxns += 1;
    }

    const record = {
      id: custId,
      city, state,
      home_lat: Math.round(homeLat * 10000) / 10000,
      home_lon: Math.round(homeLon * 10000) / 10000,
      credit_score: creditScore,
      signup_at: signupAt,
      preferred_categories: preferred.map((p) => p[0]),
      transactions,
    };

    out.write(`${JSON.stringify(record)}\n`);
  }

  out.end(() => {
    const bytes = fs.statSync(DATA_FILE).size;
    console.log(`Generated ${COUNT.toLocaleString()} customers × ${TXNS_PER_CUSTOMER} transactions`);
    console.log(`  file:  ${DATA_FILE}`);
    console.log(`  size:  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  txns:  ${totalTxns.toLocaleString()}`);
    console.log(`  took:  ${Date.now() - started} ms`);
    console.log(`  seed:  ${SEED} (fixed — reruns produce identical data)`);
  });
}

main();
