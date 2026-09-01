'use strict';

// The fraud/credit risk scoring function — used IDENTICALLY by both the Redis
// path and the Postgres path. This is the fairness cornerstone of the whole
// demo: whichever store answers faster, both feed the exact same function with
// the exact same shape of data, so a latency difference is a data-access
// difference, never a scoring difference.
//
// Given a customer's profile, their transaction history (oldest first, as both
// stores return it), and a candidate transaction being evaluated right now,
// returns a 0-100 risk score, a decision, and the individual factors that
// produced it — the kind of explanation a real fraud analyst dashboard shows,
// not just a number.
//
// Five factors, each capped so no single one can dominate the decision:
//
//   credit      lower FICO-style score raises baseline risk      up to 20
//   velocity    too many transactions in a short window          up to 25
//   amount      how far the candidate deviates from the          up to 25
//               customer's own mean/stdev (a z-score)
//   geography   implied travel speed since the customer's        up to 30
//               last transaction — the classic "impossible
//               travel" signal
//   category    a merchant category this customer has never      up to 15
//               used, weighted higher for easily-resold goods
//
// Thresholds: <25 ALLOW, 25-60 REVIEW, >60 DECLINE. Chosen and then checked
// against the generated corpus (see docs/METHODOLOGY.md) rather than assumed —
// a threshold that flags half of all ordinary transactions would be useless
// regardless of how principled the math looks.

const HIGH_RISK_CATEGORIES = new Set([
  'electronics', 'jewelry', 'gaming', 'luxury_goods', 'gift_cards',
]);

const VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const EARTH_RADIUS_MILES = 3958.8;
const IMPOSSIBLE_TRAVEL_MPH = 500; // faster than a commercial flight, gate to gate

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs, avg) {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - avg) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// history: array of { amt, cat, lat, lon, ts, out }, oldest first, at most the
// last 50 for this customer. candidate: { amt, cat, lat, lon, ts }.
function scoreTransaction(customer, history, candidate) {
  const factors = [];
  let risk = 0;

  // ---- credit ------------------------------------------------------------
  // FICO-style scale is 300-850; 680 is roughly the population mean in the
  // generated corpus. Below that, risk climbs linearly, capped at 20.
  const creditRisk = Math.max(0, Math.min(20, ((680 - customer.credit_score) / 380) * 20));
  if (creditRisk > 0.5) {
    factors.push({
      factor: 'credit_score', points: Math.round(creditRisk * 10) / 10,
      detail: `credit score ${customer.credit_score} is below the portfolio average`,
    });
  }
  risk += creditRisk;

  // ---- velocity ------------------------------------------------------------
  const windowStart = candidate.ts - VELOCITY_WINDOW_MS;
  const recentCount = history.filter((t) => t.ts >= windowStart && t.ts < candidate.ts).length;
  let velocityRisk = 0;
  if (recentCount >= 4) velocityRisk = 25;
  else if (recentCount >= 2) velocityRisk = 12;
  else if (recentCount >= 1) velocityRisk = 4;
  if (velocityRisk > 0) {
    factors.push({
      factor: 'velocity', points: velocityRisk,
      detail: `${recentCount} other transaction${recentCount === 1 ? '' : 's'} in the last hour`,
    });
  }
  risk += velocityRisk;

  // ---- amount deviation ----------------------------------------------------
  const amounts = history.map((t) => t.amt);
  const avgAmt = amounts.length ? mean(amounts) : candidate.amt;
  const sdAmt = amounts.length ? stdev(amounts, avgAmt) : 0;
  // A near-zero stdev (a customer whose spend barely varies) would make any
  // deviation register as an enormous z-score. Floor it at 15% of the mean so
  // "consistent" doesn't get mistaken for "infinitely sensitive".
  const floor = Math.max(sdAmt, avgAmt * 0.15, 1);
  const zAmount = (candidate.amt - avgAmt) / floor;
  let amountRisk = 0;
  if (zAmount > 5) amountRisk = 25;
  else if (zAmount > 3) amountRisk = 15;
  else if (zAmount > 2) amountRisk = 6;
  if (amountRisk > 0) {
    factors.push({
      factor: 'amount', points: amountRisk,
      detail: `$${candidate.amt.toFixed(2)} is ${zAmount.toFixed(1)}σ above this customer's average of $${avgAmt.toFixed(2)}`,
    });
  }
  risk += amountRisk;

  // ---- geography / impossible travel ---------------------------------------
  // Compared against the customer's single most recent PRIOR transaction, not
  // home address — a real fraud signal is "this account just did something in
  // Lagos eleven minutes after Charlotte", not "this account is away from
  // home", which happens to everyone who travels.
  let geoRisk = 0;
  let geoDetail = null;
  if (history.length > 0) {
    const prior = history[history.length - 1];
    const distanceMiles = haversineMiles(prior.lat, prior.lon, candidate.lat, candidate.lon);
    const elapsedHours = Math.max((candidate.ts - prior.ts) / 3600000, 1 / 60); // floor 1 minute
    const impliedMph = distanceMiles / elapsedHours;
    if (distanceMiles > 50) {
      if (impliedMph > IMPOSSIBLE_TRAVEL_MPH) {
        geoRisk = 30;
        geoDetail = `${Math.round(distanceMiles).toLocaleString()} miles from the last transaction in `
          + `${elapsedHours < 1 ? Math.round(elapsedHours * 60) + ' min' : elapsedHours.toFixed(1) + ' h'} `
          + `— physically impossible travel`;
      } else if (distanceMiles > 500 && elapsedHours < 6) {
        geoRisk = 14;
        geoDetail = `${Math.round(distanceMiles).toLocaleString()} miles from the last transaction in `
          + `${elapsedHours.toFixed(1)} h — plausible but unusual`;
      }
    }
    if (geoRisk > 0) factors.push({ factor: 'geography', points: geoRisk, detail: geoDetail });
  }
  risk += geoRisk;

  // ---- merchant category ---------------------------------------------------
  const seenCategories = new Set(history.map((t) => t.cat));
  let categoryRisk = 0;
  if (!seenCategories.has(candidate.cat)) {
    categoryRisk = HIGH_RISK_CATEGORIES.has(candidate.cat) ? 15 : 6;
    factors.push({
      factor: 'category', points: categoryRisk,
      detail: `first-ever ${candidate.cat.replace(/_/g, ' ')} purchase for this customer`
        + (HIGH_RISK_CATEGORIES.has(candidate.cat) ? ' (high-resale-value category)' : ''),
    });
  }
  risk += categoryRisk;

  risk = Math.round(Math.min(100, risk) * 10) / 10;
  const decision = risk >= 60 ? 'DECLINE' : risk >= 25 ? 'REVIEW' : 'ALLOW';

  return {
    risk,
    decision,
    factors: factors.sort((a, b) => b.points - a.points),
    context: {
      avgAmount: Math.round(avgAmt * 100) / 100,
      recentCount,
    },
  };
}

module.exports = { scoreTransaction, haversineMiles, HIGH_RISK_CATEGORIES, VELOCITY_WINDOW_MS };
