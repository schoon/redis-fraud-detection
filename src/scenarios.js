'use strict';

// Builds a candidate transaction for a named scenario, given a customer's REAL
// fetched history — so every preset reliably demonstrates its intended factor
// regardless of which of the 100,000 customers is selected, the same way the
// query pools in the sibling demos were checked against real data rather than
// assumed to work.
//
// This is setup, not the timed comparison: building a scenario means peeking
// at one engine's copy of the history (it doesn't matter which — both hold
// identical data, verified in seed-time cross-checks) to pick, for instance, a
// merchant category this specific customer has genuinely never used. The
// actual side-by-side timing in server.js re-fetches from both engines
// afterwards using the resulting candidate.

// A handful of places far enough from anywhere in the corpus's US-weighted
// city list that "minutes later, thousands of miles away" is unambiguous.
const FAR_POINTS = [
  ['Lagos, NG', 6.5244, 3.3792],
  ['London, GB', 51.5072, -0.1276],
  ['Manila, PH', 14.5995, 120.9842],
  ['Dubai, AE', 25.2048, 55.2708],
];

function pick(arr, random = Math.random) {
  return arr[Math.floor(random() * arr.length)];
}

function meanOf(history, field) {
  return history.reduce((a, t) => a + t[field], 0) / history.length;
}

const SCENARIOS = {
  typical: {
    label: 'Typical purchase',
    description: "Same category and a similar amount to this customer's own recent spending, a few days later, near home.",
    build(customer, history) {
      const last = history[history.length - 1];
      return {
        amt: Math.round(last.amt * (0.85 + Math.random() * 0.3) * 100) / 100,
        cat: last.cat,
        lat: last.lat + (Math.random() - 0.5) * 0.15,
        lon: last.lon + (Math.random() - 0.5) * 0.15,
        ts: last.ts + 3 * 24 * 3600 * 1000,
      };
    },
  },

  impossible_travel: {
    label: 'Impossible travel',
    description: "A purchase originating thousands of miles from this customer's last transaction, minutes later — the classic account-takeover signal.",
    build(customer, history) {
      const last = history[history.length - 1];
      const [, flat, flon] = pick(FAR_POINTS);
      return {
        amt: Math.round((30 + Math.random() * 80) * 100) / 100,
        cat: last.cat,
        lat: flat + (Math.random() - 0.5) * 0.2,
        lon: flon + (Math.random() - 0.5) * 0.2,
        ts: last.ts + (5 + Math.random() * 10) * 60 * 1000,
      };
    },
  },

  velocity_spike: {
    label: 'Velocity spike',
    // The customer's real 50-transaction history spans months, so multiple
    // genuine transactions within one hour of each other essentially never
    // occur by chance. This scenario is the one exception in the set: it
    // temporarily augments the fetched history with clearly-synthetic recent
    // activity (never written to either store) so the velocity factor has
    // something real to detect. Both engines are handed the identical
    // augmented history, so the comparison stays symmetric.
    description: 'Four purchases in the last twenty minutes (simulated), then a fifth right now.',
    simulated: true,
    build(customer, history) {
      const last = history[history.length - 1];
      const injected = [1, 5, 10, 15].map((min) => ({
        amt: Math.round((20 + Math.random() * 60) * 100) / 100,
        cat: last.cat, lat: last.lat, lon: last.lon,
        ts: last.ts + min * 60 * 1000, out: 'ALLOW',
      }));
      return {
        amt: Math.round((20 + Math.random() * 60) * 100) / 100,
        cat: last.cat, lat: last.lat, lon: last.lon,
        ts: last.ts + 20 * 60 * 1000,
        _injectHistory: injected,
      };
    },
  },

  large_unfamiliar_purchase: {
    label: 'Large, unfamiliar purchase',
    description: "A high-value purchase in a merchant category this specific customer has never used — picked fresh for whichever customer is selected.",
    build(customer, history) {
      const seen = new Set(history.map((t) => t.cat));
      const ALL_CATEGORIES = ['grocery', 'restaurant', 'fuel', 'pharmacy', 'clothing',
        'home_improvement', 'subscription', 'entertainment', 'electronics', 'travel',
        'jewelry', 'online_marketplace', 'gaming', 'luxury_goods', 'gift_cards'];
      const HIGH_RISK = ['electronics', 'jewelry', 'gaming', 'luxury_goods', 'gift_cards'];
      const unseenHighRisk = HIGH_RISK.filter((c) => !seen.has(c));
      const unseenAny = ALL_CATEGORIES.filter((c) => !seen.has(c));
      const cat = unseenHighRisk.length ? pick(unseenHighRisk) : pick(unseenAny.length ? unseenAny : ALL_CATEGORIES);
      const avg = meanOf(history, 'amt');
      const last = history[history.length - 1];
      return {
        amt: Math.round(Math.max(avg * 5, 800) * 100) / 100,
        cat,
        lat: last.lat + (Math.random() - 0.5) * 0.15,
        lon: last.lon + (Math.random() - 0.5) * 0.15,
        ts: last.ts + 2 * 24 * 3600 * 1000,
      };
    },
  },

  everything_at_once: {
    label: 'Everything at once',
    description: 'Far away, an unfamiliar high-risk category, and well above this customer\'s typical spend — minutes after their last transaction.',
    build(customer, history) {
      const seen = new Set(history.map((t) => t.cat));
      const HIGH_RISK = ['electronics', 'jewelry', 'gaming', 'luxury_goods', 'gift_cards'];
      const unseen = HIGH_RISK.filter((c) => !seen.has(c));
      const cat = unseen.length ? pick(unseen) : pick(HIGH_RISK);
      const avg = meanOf(history, 'amt');
      const last = history[history.length - 1];
      const [, flat, flon] = pick(FAR_POINTS);
      return {
        amt: Math.round(Math.max(avg * 8, 2000) * 100) / 100,
        cat,
        lat: flat + (Math.random() - 0.5) * 0.2,
        lon: flon + (Math.random() - 0.5) * 0.2,
        ts: last.ts + (5 + Math.random() * 8) * 60 * 1000,
      };
    },
  },
};

function buildScenario(name, customer, history) {
  const scenario = SCENARIOS[name] || SCENARIOS.typical;
  const candidate = scenario.build(customer, history);
  const injected = candidate._injectHistory || null;
  delete candidate._injectHistory;
  return { candidate, injectedHistory: injected, label: scenario.label, description: scenario.description, simulated: Boolean(scenario.simulated) };
}

module.exports = { SCENARIOS, buildScenario };
