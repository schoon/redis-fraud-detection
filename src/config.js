'use strict';

const path = require('path');

module.exports = {
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6382',
  PG: {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5433),
    user: process.env.PG_USER || 'fraud',
    password: process.env.PG_PASSWORD || 'demopassword',
    database: process.env.PG_DATABASE || 'frauddb',
  },
  PORT: process.env.PORT || 3030,

  COUNT: Number(process.env.COUNT || 100000),
  TXNS_PER_CUSTOMER: 50,
  DATA_FILE: path.join(__dirname, '..', 'data', 'customers.jsonl'),

  // Fixed seed so every run produces byte-identical data — both stores load the
  // same file, which is what makes the latency comparison meaningful.
  SEED: 20260901,
};
