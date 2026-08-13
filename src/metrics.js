'use strict';








class Histogram {
  constructor(cap = 2048) {
    this.cap = cap;
    this.samples = [];
    this.count = 0;
    this.sum = 0;
  }

  observe(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.count++;
    this.sum += ms;
    if (this.samples.length < this.cap) {
      this.samples.push(ms);
    } else {
      
      
      const idx = Math.floor(Math.random() * this.count);
      if (idx < this.cap) this.samples[idx] = ms;
    }
  }

  percentile(p) {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }

  get mean() {
    return this.count ? this.sum / this.count : null;
  }

  summary() {
    if (!this.count) return null;
    const r = (v) => (v == null ? null : Math.round(v));
    return {
      n: this.count,
      mean: r(this.mean),
      p50: r(this.percentile(50)),
      p95: r(this.percentile(95)),
      p99: r(this.percentile(99)),
      max: r(Math.max(...this.samples)),
    };
  }
}

const counters = new Map();
const histograms = new Map();
const startedAt = Date.now();

function inc(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}


function set(name, value) {
  counters.set(name, value);
}

function get(name) {
  return counters.get(name) || 0;
}

function observe(name, ms) {
  let h = histograms.get(name);
  if (!h) {
    h = new Histogram();
    histograms.set(name, h);
  }
  h.observe(ms);
}


async function timed(name, fn) {
  const t0 = performance.now();
  try {
    const out = await fn();
    observe(name, performance.now() - t0);
    return out;
  } catch (err) {
    observe(`${name}.error`, performance.now() - t0);
    throw err;
  }
}

function hist(name) {
  return histograms.get(name) || null;
}


const OUTCOMES = [
  'purchased',
  'quantity_exhausted',
  'insufficient_funds',
  'price_mismatch',
  'already_owned',
  'invalid_arguments',
  'rate_limited',
  'error',
  'dry_run',
];

function recordOutcome(outcome) {
  const key = OUTCOMES.includes(outcome) ? outcome : 'error';
  inc(`outcome.${key}`);
  return key;
}

function outcomeBreakdown() {
  const out = {};
  for (const o of OUTCOMES) {
    const v = get(`outcome.${o}`);
    if (v) out[o] = v;
  }
  return out;
}

function uptimeSec() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function snapshot() {
  const hists = {};
  for (const [name, h] of histograms) {
    const s = h.summary();
    if (s) hists[name] = s;
  }
  return {
    uptimeSec: uptimeSec(),
    counters: Object.fromEntries(counters),
    latency: hists,
    outcomes: outcomeBreakdown(),
  };
}

module.exports = {
  Histogram,
  inc,
  set,
  get,
  observe,
  timed,
  hist,
  recordOutcome,
  outcomeBreakdown,
  uptimeSec,
  snapshot,
  OUTCOMES,
};
