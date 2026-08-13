'use strict';


















const http = require('./http');
const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const rl = require('./ratelimit');

const FEED_URL = 'https://www.rolimons.com/itemapi/itemdetails';

const DEMAND = ['Terrible', 'Low', 'Normal', 'High', 'Amazing'];
const TREND = ['Lowering', 'Unstable', 'Stable', 'Raising', 'Fluctuating'];

const items = new Map();
let lastFetch = 0;
let lastError = null;
let inFlight = null;

function nz(v) {
  
  return typeof v === 'number' && v >= 0 ? v : null;
}

function parseFeed(payload) {
  const raw = payload?.items;
  if (!raw || typeof raw !== 'object') {
    throw new Error('feed missing `items` object');
  }

  const parsed = new Map();
  for (const [id, arr] of Object.entries(raw)) {
    if (!Array.isArray(arr) || arr.length < 3) continue;
    const assetId = Number(id);
    if (!Number.isFinite(assetId)) continue;

    const rap = nz(arr[2]);
    const value = nz(arr[3]);

    parsed.set(assetId, {
      assetId,
      name: typeof arr[0] === 'string' ? arr[0] : String(assetId),
      acronym: arr[1] || null,
      rap,
      value,
      defaultValue: nz(arr[4]),
      demand: nz(arr[5]),
      demandLabel: DEMAND[arr[5]] || null,
      trend: nz(arr[6]),
      trendLabel: TREND[arr[6]] || null,
      
      projected: arr[7] === 1,
      hyped: arr[8] === 1,
      rare: arr[9] === 1,
      
      worth: value ?? rap ?? 0,
    });
  }

  if (parsed.size === 0) throw new Error('feed parsed to zero items');
  return parsed;
}

async function fetchFeed() {
  const res = await http.get(FEED_URL, {
    auth: false,          
    retries: 1,
    timeoutMs: 15000,
    label: 'rolimons.feed',
  });
  const parsed = parseFeed(res.data);
  items.clear();
  for (const [k, v] of parsed) items.set(k, v);
  lastFetch = Date.now();
  lastError = null;
  metrics.inc('rolimons.refresh');
  return items.size;
}

function refresh() {
  if (inFlight) return inFlight;
  inFlight = fetchFeed()
    .then((n) => {
      log.info(`Rolimons: ${n} limiteds loaded`);
      return n;
    })
    .catch((err) => {
      lastError = err.message;
      metrics.inc('rolimons.error');
      log.warn(`Rolimons refresh failed: ${err.message}`);
      return items.size;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function get(assetId) {
  return items.get(Number(assetId)) || null;
}



function worthOf(assetId) {
  const v = get(assetId);
  return v ? v.worth : 0;
}


function profitPct(assetId, price) {
  if (!price || price <= 0) return 0;
  const worth = worthOf(assetId);
  if (!worth) return 0;
  return ((worth - price) / price) * 100;
}


function discountPct(assetId, price) {
  const worth = worthOf(assetId);
  if (!worth || price >= worth) return 0;
  return Math.round((1 - price / worth) * 100);
}










function topCandidates(limit, {
  minValue = config.minItemValue,
  skipProjected = config.skipProjected,
  budget = config.maxPrice,
} = {}) {
  const out = [];
  for (const item of items.values()) {
    if (item.worth < minValue) continue;
    if (skipProjected && item.projected) continue;
    out.push(item);
  }

  
  
  
  
  
  
  
  
  
  
  const IDEAL_RATIO = 20;   
  const SIGMA = 1.0;        

  const score = (it) => {
    const demandWeight = (it.demand ?? 2) + 1;
    const ratio = budget > 0 ? it.worth / budget : it.worth;
    const z = Math.log(Math.max(ratio, 0.01) / IDEAL_RATIO) / SIGMA;
    const reach = Math.exp(-(z * z) / 2);
    return it.worth * demandWeight * reach;
  };

  out.sort((a, b) => score(b) - score(a));
  return out.slice(0, limit);
}



const rapCache = new Map();
async function liveRap(assetId, ttlMs = 1800000) {
  const cached = rapCache.get(assetId);
  if (cached && Date.now() - cached.at < ttlMs) return cached.rap;

  let rap = 0;
  try {
    const res = await http.get(
      `https://economy.roblox.com/v1/assets/${assetId}/resale-data`,
      { label: 'economy.resaledata' }
    );
    rap = Number(res.data?.recentAveragePrice) || 0;
  } catch (err) {
    if (err.status !== 400 && err.status !== 404 && err.status !== 410) throw err;
  }
  rapCache.set(assetId, { rap, at: Date.now() });
  return rap;
}

async function loop(signal) {
  if (!config.rolimonsEnabled) {
    log.warn('Rolimons disabled — valuation falls back to live RAP lookups');
    return;
  }
  await refresh();
  while (!signal?.aborted) {
    await rl.sleep(config.rolimonsRefreshMs);
    if (signal?.aborted) break;
    await refresh();
  }
}

function status() {
  return {
    items: items.size,
    ageMs: lastFetch ? Date.now() - lastFetch : null,
    error: lastError,
  };
}

module.exports = {
  refresh,
  loop,
  get,
  worthOf,
  profitPct,
  discountPct,
  topCandidates,
  liveRap,
  parseFeed,
  status,
  items,
};
