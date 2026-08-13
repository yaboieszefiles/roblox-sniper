'use strict';

require('dotenv').config();

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ==================== CONFIG ====================
const COOKIE = (process.env.ROBLOSECURITY || '').trim();
const MAX_PRICE = numEnv('MAX_PRICE', 22);
const MIN_AVG_GAP = numEnv('MIN_AVG_GAP', 1000);
const POLL_MS = numEnv('POLL_MS', 650);
const CATALOG_LIMIT = numEnv('CATALOG_LIMIT', 30);
const MAX_QUEUE_PER_PAGE = numEnv('MAX_QUEUE_PER_PAGE', 10);
const MAX_CONCURRENT_SNIPES = numEnv('MAX_CONCURRENT_SNIPES', 3);
const SNIPE_START_GAP_MS = numEnv('SNIPE_START_GAP_MS', 80);
const CATALOG_TAXONOMY = process.env.CATALOG_TAXONOMY || 'tZsUsd2BqGViQrJ9Vs3Wah';
const CATALOG_CREATOR = process.env.CATALOG_CREATOR || 'roblox';
const XSRF_MS = numEnv('XSRF_MS', 25000);
const STATE_FILE = process.env.STATE_FILE || 'sniper_state.json';
const LOG_FILE = process.env.LOG_FILE || 'sniper.log';
const MAX_CACHE_SIZE = numEnv('MAX_CACHE_SIZE', 5000);
const CACHE_CLEANUP_INTERVAL = numEnv('CACHE_CLEANUP_INTERVAL', 1800000);
const ATTEMPTED_TTL = numEnv('ATTEMPTED_TTL', 86400000);
const SKIP_TTL = numEnv('SKIP_TTL', 90000);
const REJECT_TTL = numEnv('REJECT_TTL', 600000);
const RATE_LIMIT_COOLDOWN_MS = numEnv('RATE_LIMIT_COOLDOWN_MS', 8000);
const DEEP_PAGE_EVERY = numEnv('DEEP_PAGE_EVERY', 8);
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').trim();
const DETAILS_BATCH = 30;

// Deal alerts — independent of the buy pipeline. Scans without the MAX_PRICE
// cap so expensive limiteds still get reported even though we can't buy them.
const ALERT_ENABLED = process.env.ALERT_ENABLED !== 'false';
const ALERT_DISCOUNT_PCT = numEnv('ALERT_DISCOUNT_PCT', 10);
const ALERT_MAX_PRICE = numEnv('ALERT_MAX_PRICE', 0); // 0 = no cap
const ALERT_MIN_AVG = numEnv('ALERT_MIN_AVG', 50);
const ALERT_POLL_MS = numEnv('ALERT_POLL_MS', 4000);
const ALERT_PAGES = numEnv('ALERT_PAGES', 3);
const ALERT_TTL = numEnv('ALERT_TTL', 21600000);
const ALERT_LOOKUPS_PER_CYCLE = numEnv('ALERT_LOOKUPS_PER_CYCLE', 8);
const ALERT_RAP_GAP_MS = numEnv('ALERT_RAP_GAP_MS', 150);
const RAP_TTL = numEnv('RAP_TTL', 1800000);
const WEBHOOK_MIN_GAP_MS = numEnv('WEBHOOK_MIN_GAP_MS', 400);

function numEnv(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

// ==================== COLORS ====================
const R = '\x1b[0m', G = '\x1b[32m', RD = '\x1b[31m',
      Y = '\x1b[33m', CY = '\x1b[36m', B = '\x1b[1m';

const log = {
  snipe: (m) => logMessage(`${B}${G}[SNIPE]${R} ${m}`, 'SNIPE'),
  fail:  (m) => logMessage(`${RD}[FAIL]  ${m}${R}`, 'FAIL'),
  info:  (m) => logMessage(`${CY}[INFO]  ${m}${R}`, 'INFO'),
  warn:  (m) => logMessage(`${Y}[WARN]  ${m}${R}`, 'WARN'),
  found: (m) => logMessage(`${B}${Y}[FOUND] ${m}${R}`, 'FOUND'),
  error: (m) => logMessage(`${RD}[ERROR] ${m}${R}`, 'ERROR'),
};

const logQueue = [];
let logFlushing = false;

function logMessage(msg, level) {
  const timestamp = new Date().toISOString();
  const plainMsg = msg.replace(/\x1b\[[0-9;]*m/g, '');
  console.log(msg);
  logQueue.push(`[${timestamp}] ${level}: ${plainMsg}\n`);
  flushLogs();
}

function flushLogs() {
  if (logFlushing || logQueue.length === 0) return;
  logFlushing = true;
  const chunk = logQueue.splice(0, logQueue.length).join('');
  fs.appendFile(LOG_FILE, chunk, () => {
    logFlushing = false;
    if (logQueue.length) flushLogs();
  });
}

// ==================== HTTP CLIENT ====================
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 32,
  maxFreeSockets: 12,
  scheduling: 'lifo',
  timeout: 8000,
});

const client = axios.create({
  httpsAgent: agent,
  timeout: 4500,
  transitional: { clarifyTimeoutError: true },
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: 'https://www.roblox.com/',
    Origin: 'https://www.roblox.com',
  },
  validateStatus: (s) => s >= 200 && s < 300,
});

client.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err?.response?.status;
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.response);
      const host = hostBucket(err.config?.url);
      triggerRateLimit(host, retryAfter);
    }
    return Promise.reject(err);
  }
);

function parseRetryAfter(res) {
  const h = res?.headers?.['retry-after'];
  if (!h) return RATE_LIMIT_COOLDOWN_MS;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(Math.max(n * 1000, 1000), 60000);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), 60000);
  return RATE_LIMIT_COOLDOWN_MS;
}

function hostBucket(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('catalog')) return 'catalog';
    if (h.includes('economy') || h.includes('marketplace')) return 'economy';
    return 'other';
  } catch {
    return 'other';
  }
}

// ==================== STATE ====================
let xsrfToken = null;
let attemptedWithTime = new Map();
let skippedWithTime = new Map();
let rejectedWithTime = new Map();
let alertedWithTime = new Map();
const inFlight = new Set();
let totalSniped = 0;
let totalFailed = 0;
let totalAlerts = 0;
let loggedInUsername = 'unknown';
let userId = null;

const productCache = new Map();
const rapCache = new Map();
const itemStats = new Map();
const snipeQueue = [];
const queuedIds = new Set();

const rateLimits = {
  catalog: 0,
  economy: 0,
  other: 0,
};
let rateLimitLogAt = 0;

const waiters = [];
const semaphore = { current: 0, max: MAX_CONCURRENT_SNIPES };

// ==================== SEMAPHORE ====================
function acquireSnipe() {
  if (semaphore.current < semaphore.max) {
    semaphore.current++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve)).then(() => {
    semaphore.current++;
  });
}

function releaseSnipe() {
  if (semaphore.current > 0) semaphore.current--;
  const next = waiters.shift();
  if (next) next();
}

function triggerRateLimit(bucket = 'other', ms = RATE_LIMIT_COOLDOWN_MS) {
  const until = Date.now() + ms;
  rateLimits[bucket] = Math.max(rateLimits[bucket] || 0, until);
}

async function waitIfRateLimited(bucket) {
  const until = bucket ? rateLimits[bucket] || 0 : Math.max(...Object.values(rateLimits));
  const wait = until - Date.now();
  if (wait > 0) await sleep(wait);
}

function logRateLimitOnce(msg) {
  const now = Date.now();
  if (now - rateLimitLogAt < 4000) return;
  rateLimitLogAt = now;
  log.warn(msg);
}

// ==================== CACHE MANAGEMENT ====================
function pruneMap(map, max) {
  if (map.size <= max) return;
  const toDelete = map.size - Math.floor(max * 0.8);
  let count = 0;
  for (const key of map.keys()) {
    if (count++ >= toDelete) break;
    map.delete(key);
  }
}

function pruneProductCache() {
  pruneMap(productCache, MAX_CACHE_SIZE);
}

function pruneTimedMaps() {
  const now = Date.now();
  let deleted = 0;
  for (const [id, time] of attemptedWithTime) {
    if (now - time > ATTEMPTED_TTL) {
      attemptedWithTime.delete(id);
      deleted++;
    }
  }
  for (const [id, time] of skippedWithTime) {
    if (now - time > SKIP_TTL) skippedWithTime.delete(id);
  }
  for (const [id, time] of rejectedWithTime) {
    if (now - time > REJECT_TTL) rejectedWithTime.delete(id);
  }
  for (const [id, time] of alertedWithTime) {
    if (now - time > ALERT_TTL) alertedWithTime.delete(id);
  }
  for (const [id, entry] of rapCache) {
    if (now - entry.ts > RAP_TTL) rapCache.delete(id);
  }
  if (deleted > 0) {
    log.info(`Cleaned ${deleted} expired attempts, ${attemptedWithTime.size} remaining`);
  }
}

setInterval(() => {
  pruneProductCache();
  pruneTimedMaps();
}, CACHE_CLEANUP_INTERVAL).unref();

// ==================== STATS ====================
function recordSnipe(assetId, name, price, success) {
  if (!itemStats.has(assetId)) {
    itemStats.set(assetId, { name, attempts: 0, bought: 0, avgPrice: 0 });
  }
  const stat = itemStats.get(assetId);
  stat.attempts++;
  if (success) {
    stat.bought++;
    stat.avgPrice = (stat.avgPrice * (stat.bought - 1) + price) / stat.bought;
  }
}

async function statsLoop() {
  const start = Date.now();
  while (true) {
    await sleep(30000);
    const s = Math.floor((Date.now() - start) / 1000);
    const top = Array.from(itemStats.values())
      .sort((a, b) => b.bought - a.bought)
      .slice(0, 5);
    const topStr = top.length
      ? ' | Top: ' + top.map((st) => `${st.name}(${st.bought})`).join(', ')
      : '';
    log.info(
      `Uptime ${s}s | Sniped: ${B}${G}${totalSniped}${R} | Failed: ${totalFailed} | `
        + `Alerts: ${totalAlerts} | Active: ${semaphore.current}/${semaphore.max} | `
        + `Queued: ${snipeQueue.length} | Attempted: ${attemptedWithTime.size} | `
        + `Skip: ${skippedWithTime.size} | Reject: ${rejectedWithTime.size} | `
        + `Cache: ${productCache.size} | RAP: ${rapCache.size}${topStr}`
    );
  }
}

// ==================== PERSISTENCE ====================
let saveQueued = false;

function saveState() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    try {
      const state = {
        attempted: Array.from(attemptedWithTime.entries()),
        rejected: Array.from(rejectedWithTime.entries()),
        alerted: Array.from(alertedWithTime.entries()),
        totalSniped,
        totalFailed,
        totalAlerts,
        ts: new Date().toISOString(),
      };
      fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
    } catch (e) {
      log.warn(`Failed to save state: ${e.message}`);
    }
  });
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    attemptedWithTime = new Map(data.attempted || []);
    rejectedWithTime = new Map(data.rejected || []);
    alertedWithTime = new Map(data.alerted || []);
    totalSniped = data.totalSniped || 0;
    totalFailed = data.totalFailed || 0;
    totalAlerts = data.totalAlerts || 0;
    log.info(
      `Restored state: ${attemptedWithTime.size} seen, ${rejectedWithTime.size} rejected, `
        + `${alertedWithTime.size} alerted, ${totalSniped} sniped, ${totalFailed} failed`
    );
    return true;
  } catch (e) {
    log.warn(`Failed to load state: ${e.message}`);
    return false;
  }
}

// ==================== TRACKING ====================
function markAttempted(assetId) {
  attemptedWithTime.set(assetId, Date.now());
  skippedWithTime.delete(assetId);
}

function markSkipped(assetId) {
  skippedWithTime.set(assetId, Date.now());
}

function markRejected(assetId) {
  rejectedWithTime.set(assetId, Date.now());
  skippedWithTime.delete(assetId);
}

function isTimedOut(map, assetId, ttl) {
  if (!map.has(assetId)) return false;
  const age = Date.now() - map.get(assetId);
  if (age > ttl) {
    map.delete(assetId);
    return false;
  }
  return true;
}

function isAttempted(assetId) {
  return isTimedOut(attemptedWithTime, assetId, ATTEMPTED_TTL);
}

function isSkipped(assetId) {
  return isTimedOut(skippedWithTime, assetId, SKIP_TTL);
}

function isRejected(assetId) {
  return isTimedOut(rejectedWithTime, assetId, REJECT_TTL);
}

function isAlerted(assetId) {
  return isTimedOut(alertedWithTime, assetId, ALERT_TTL);
}

function markAlerted(assetId) {
  alertedWithTime.set(assetId, Date.now());
}

function tryClaim(assetId) {
  if (inFlight.has(assetId)) return false;
  if (isAttempted(assetId) || isSkipped(assetId) || isRejected(assetId)) return false;
  inFlight.add(assetId);
  return true;
}

function releaseClaim(assetId) {
  inFlight.delete(assetId);
}

// ==================== XSRF ====================
function captureXsrf(errOrRes) {
  const headers = errOrRes?.response?.headers || errOrRes?.headers;
  const t = headers?.['x-csrf-token'];
  if (t) {
    xsrfToken = t;
    return true;
  }
  return false;
}

async function refreshXSRF() {
  try {
    await client.post('https://auth.roblox.com/v2/logout', {});
  } catch (e) {
    if (captureXsrf(e)) return true;
  }

  try {
    const res = await client.post(
      'https://economy.roblox.com/v1/purchases/products/0',
      {},
      {
        validateStatus: () => true,
        headers: xsrfToken ? { 'X-CSRF-TOKEN': xsrfToken } : {},
      }
    );
    if (captureXsrf(res)) return true;
  } catch (e) {
    if (captureXsrf(e)) return true;
  }
  return Boolean(xsrfToken);
}

async function xsrfLoop() {
  while (true) {
    await refreshXSRF();
    await sleep(XSRF_MS);
  }
}

// ==================== AUTH / BALANCE ====================
async function healthCheck() {
  while (true) {
    try {
      await client.get('https://users.roblox.com/v1/users/authenticated');
      await sleep(300000);
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.errors?.[0]?.message || e.message;
      if (status === 401 || status === 403) {
        log.error(`Auth failed (${status}): ${msg} — cookie is dead`);
        saveState();
        log.info(`State saved. Refresh ROBLOSECURITY in .env and restart.`);
        process.exit(1);
      }
      if (status === 429) {
        log.warn('Health check rate limited, retry in 10s');
        await sleep(10000);
        continue;
      }
      log.warn(`Health check error: ${msg}, retry in 30s`);
      await sleep(30000);
    }
  }
}

async function robuxCheck() {
  while (true) {
    try {
      if (!userId) {
        const res = await client.get('https://users.roblox.com/v1/users/authenticated');
        userId = res.data?.id;
        loggedInUsername = res.data?.name || loggedInUsername;
      }
      if (userId) {
        const balRes = await client.get(`https://economy.roblox.com/v1/users/${userId}/currency`);
        const robux = balRes.data?.robux ?? 0;
        if (robux < MAX_PRICE) {
          log.warn(`Low Robux: ${robux}R$ (need >= ${MAX_PRICE}). Sniper may not buy.`);
        } else {
          log.info(`Balance: ${robux}R$`);
        }
      }
    } catch (_) {}
    await sleep(600000);
  }
}

// ==================== DISCORD ====================
const webhookQueue = [];
let webhookDraining = false;

function queueWebhook(payload) {
  if (!WEBHOOK_URL) return;
  webhookQueue.push(payload);
  drainWebhookQueue();
}

// Discord allows ~5 requests / 2s per webhook, so serialize and space them out.
async function drainWebhookQueue() {
  if (webhookDraining) return;
  webhookDraining = true;
  try {
    while (webhookQueue.length) {
      const payload = webhookQueue.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await axios.post(WEBHOOK_URL, payload, { timeout: 5000 });
          break;
        } catch (e) {
          if (e?.response?.status === 429) {
            await sleep(parseDiscordRetry(e.response));
            continue;
          }
          log.warn(`Webhook failed: ${e.message}`);
          break;
        }
      }
      await sleep(WEBHOOK_MIN_GAP_MS);
    }
  } finally {
    webhookDraining = false;
  }
}

// retry_after is seconds on the v10 API but was milliseconds historically.
function parseDiscordRetry(res) {
  const raw = Number(res?.data?.retry_after);
  if (!Number.isFinite(raw) || raw <= 0) return 1000;
  const ms = raw < 100 ? raw * 1000 : raw;
  return Math.min(Math.max(ms, 500), 15000);
}

function thumbnailUrl(assetId) {
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${assetId}&width=420&height=420&format=png`;
}

function sendDiscordWebhook(name, assetId, price, username) {
  queueWebhook({
    embeds: [
      {
        title: 'Limited Sniped',
        url: `https://www.roblox.com/catalog/${assetId}`,
        color: 0x22c55e,
        fields: [
          { name: 'Item', value: name, inline: true },
          { name: 'Price', value: `${price}R$`, inline: true },
          { name: 'Account', value: `@${username}`, inline: true },
          { name: 'Asset ID', value: String(assetId), inline: true },
        ],
        thumbnail: { url: thumbnailUrl(assetId) },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

function sendDealAlert({ assetId, name, price, rap, discount }) {
  const buyable =
    price <= MAX_PRICE ? 'Yes — within buy cap' : `No — over ${MAX_PRICE}R$ cap`;
  queueWebhook({
    embeds: [
      {
        title: `${discount}% off — ${name}`,
        url: `https://www.roblox.com/catalog/${assetId}`,
        color: discount >= 80 ? 0xef4444 : 0xf59e0b,
        fields: [
          { name: 'Price', value: `${price}R$`, inline: true },
          { name: 'RAP', value: `${rap}R$`, inline: true },
          { name: 'Discount', value: `${discount}%`, inline: true },
          { name: 'Gap', value: `${rap - price}R$`, inline: true },
          { name: 'Auto-buy', value: buyable, inline: true },
          { name: 'Asset ID', value: String(assetId), inline: true },
        ],
        thumbnail: { url: thumbnailUrl(assetId) },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// ==================== CATALOG ====================
async function pollCatalog(cursor) {
  await waitIfRateLimited('catalog');
  const res = await client.get(
    'https://catalog.roblox.com/v1/search/items'
      + `?taxonomy=${CATALOG_TAXONOMY}&CreatorName=${encodeURIComponent(CATALOG_CREATOR)}`
      + `&limit=${CATALOG_LIMIT}&maxPrice=${MAX_PRICE}`
      + `&salesTypeFilter=2&sortType=4`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    { timeout: 3500 }
  );
  return res.data;
}

// Same search as pollCatalog but without the MAX_PRICE cap, so expensive
// limiteds still surface for alerts even when we can't afford them.
async function pollCatalogForAlerts(cursor) {
  await waitIfRateLimited('catalog');
  const res = await client.get(
    'https://catalog.roblox.com/v1/search/items'
      + `?taxonomy=${CATALOG_TAXONOMY}&CreatorName=${encodeURIComponent(CATALOG_CREATOR)}`
      + `&limit=${CATALOG_LIMIT}&salesTypeFilter=2&sortType=4`
      + (ALERT_MAX_PRICE > 0 ? `&maxPrice=${ALERT_MAX_PRICE}` : '')
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
    { timeout: 3500 }
  );
  return res.data;
}

async function batchCatalogDetails(assetIds) {
  if (!assetIds.length) return [];
  await waitIfRateLimited('catalog');
  if (!xsrfToken) await refreshXSRF();

  const res = await client.post(
    'https://catalog.roblox.com/v1/catalog/items/details',
    {
      items: assetIds.map((id) => ({ id: Number(id), itemType: 'Asset' })),
    },
    {
      timeout: 4500,
      headers: xsrfToken ? { 'X-CSRF-TOKEN': xsrfToken } : {},
      validateStatus: (s) => (s >= 200 && s < 300) || s === 403,
    }
  );

  if (res.status === 403) {
    await refreshXSRF();
    const retry = await client.post(
      'https://catalog.roblox.com/v1/catalog/items/details',
      {
        items: assetIds.map((id) => ({ id: Number(id), itemType: 'Asset' })),
      },
      {
        timeout: 4500,
        headers: xsrfToken ? { 'X-CSRF-TOKEN': xsrfToken } : {},
      }
    );
    return retry.data?.data || [];
  }

  return res.data?.data || [];
}

// ==================== RESELLER / DETAILS ====================
async function getReseller(assetId) {
  await waitIfRateLimited('economy');
  const res = await client.get(
    `https://economy.roblox.com/v1/assets/${assetId}/resellers?limit=10&cursor=`,
    { timeout: 3500 }
  );
  const listings = res.data?.data || [];
  let best = null;
  for (const r of listings) {
    if (r.price == null || r.price > MAX_PRICE) continue;
    if (!best || r.price < best.price) {
      best = {
        price: r.price,
        userAssetId: r.userAssetId,
        sellerId: r.seller?.id,
      };
    }
  }
  return best;
}

async function getAssetDetails(assetId) {
  if (productCache.has(assetId)) return productCache.get(assetId);

  await waitIfRateLimited('economy');
  const res = await client.get(
    `https://economy.roblox.com/v2/assets/${assetId}/details`,
    { timeout: 3500 }
  );
  const details = {
    productId: res.data?.ProductId || null,
    averagePrice: res.data?.AveragePrice || 0,
    name: res.data?.Name || String(assetId),
  };
  if (details.productId) {
    productCache.set(assetId, details);
    pruneProductCache();
  }
  return details;
}

// Collectibles have no AveragePrice on economy/v2 details — resale-data's
// recentAveragePrice is the real RAP source.
async function getRAP(assetId) {
  const cached = rapCache.get(assetId);
  if (cached && Date.now() - cached.ts < RAP_TTL) return cached.rap;

  await waitIfRateLimited('economy');
  let rap = 0;
  try {
    const res = await client.get(
      `https://economy.roblox.com/v1/assets/${assetId}/resale-data`,
      { timeout: 3500 }
    );
    rap = Number(res.data?.recentAveragePrice) || 0;
  } catch (err) {
    const status = err?.response?.status;
    // Newer collectibles have no legacy resale-data (400 code 5) — cache the
    // miss so the scanner stops re-requesting them every cycle.
    if (status !== 400 && status !== 404) throw err;
  }
  rapCache.set(assetId, { rap, ts: Date.now() });
  pruneMap(rapCache, MAX_CACHE_SIZE);
  return rap;
}

function seedCacheFromCatalog(item) {
  const assetId = item.id;
  if (!assetId || productCache.has(assetId)) return;
  const productId = item.productId;
  if (!productId) return;
  const lowest = item.lowestResalePrice ?? item.lowestPrice ?? null;
  productCache.set(assetId, {
    productId,
    averagePrice: 0,
    name: item.name || String(assetId),
    lowestResalePrice: lowest,
    hasResellers: item.hasResellers !== false,
    fromCatalog: true,
  });
}

// ==================== BUY ====================
async function buyItem(productId, price, userAssetId, sellerId) {
  if (!xsrfToken) throw new Error('No XSRF token');
  await waitIfRateLimited('economy');
  const res = await client.post(
    `https://economy.roblox.com/v1/purchases/products/${productId}`,
    {
      expectedCurrency: 1,
      expectedPrice: price,
      expectedSellerId: sellerId,
      userAssetId,
    },
    { headers: { 'X-CSRF-TOKEN': xsrfToken }, timeout: 4500 }
  );
  return res.data;
}

async function buyWithXSRFRetry(productId, price, userAssetId, sellerId) {
  try {
    return await buyItem(productId, price, userAssetId, sellerId);
  } catch (err) {
    if (err?.response?.status === 403) {
      captureXsrf(err);
      await refreshXSRF();
      return buyItem(productId, price, userAssetId, sellerId);
    }
    throw err;
  }
}

// ==================== SNIPE PIPELINE ====================
async function snipeAsset(assetId, name) {
  await waitIfRateLimited('economy');
  await acquireSnipe();

  try {
    const cached = productCache.get(assetId);

    // Skip early if catalog already said too expensive / no resellers
    if (cached?.fromCatalog) {
      if (cached.hasResellers === false) {
        markRejected(assetId);
        return;
      }
      if (cached.lowestResalePrice != null && cached.lowestResalePrice > MAX_PRICE) {
        markRejected(assetId);
        return;
      }
    }

    // Parallel: reseller + economy details (avg/productId)
    const [reseller, details] = await Promise.all([
      getReseller(assetId),
      cached?.productId && cached.averagePrice > 0
        ? Promise.resolve(cached)
        : getAssetDetails(assetId),
    ]);

    if (!reseller || reseller.price > MAX_PRICE) {
      markSkipped(assetId);
      return;
    }

    const productId = details?.productId || cached?.productId;
    if (!productId) {
      markSkipped(assetId);
      return;
    }

    const averagePrice = details?.averagePrice || 0;
    if (averagePrice > 0) {
      const avgGap = averagePrice - reseller.price;
      if (avgGap < MIN_AVG_GAP) {
        markRejected(assetId);
        saveState();
        return;
      }
      productCache.set(assetId, {
        productId,
        averagePrice,
        name: details?.name || name,
      });
    }

    const displayName = details?.name || cached?.name || name;
    const gapStr =
      averagePrice > 0
        ? ` (avg ${averagePrice}R$, gap +${averagePrice - reseller.price})`
        : '';
    log.found(
      `${displayName} — ${reseller.price}R$${gapStr} [ua:${reseller.userAssetId}]`
    );

    const result = await buyWithXSRFRetry(
      productId,
      reseller.price,
      reseller.userAssetId,
      reseller.sellerId
    );

    markAttempted(assetId);
    saveState();

    if (result?.purchased) {
      totalSniped++;
      recordSnipe(assetId, displayName, reseller.price, true);
      log.snipe(`${B}BOUGHT${R} ${displayName} for ${reseller.price}R$ — total: ${totalSniped}`);
      sendDiscordWebhook(displayName, assetId, reseller.price, loggedInUsername);
    } else {
      totalFailed++;
      recordSnipe(assetId, displayName, reseller.price, false);
      const reason = result?.reason || JSON.stringify(result);
      log.fail(`${displayName} — not purchased: ${reason}`);
    }
  } catch (err) {
    const status = err?.response?.status;
    const errCode = err?.response?.data?.errors?.[0]?.code;
    const errMsg = err?.response?.data?.errors?.[0]?.message || err.message;

    if (status === 429) {
      markSkipped(assetId);
      logRateLimitOnce(`Rate limited — pausing economy ~${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
      return;
    }
    if (status === 410 || status === 404) {
      markAttempted(assetId);
      saveState();
      return;
    }
    if (errCode === 2) {
      markAttempted(assetId);
      saveState();
      return;
    }
    if (errCode === 4) {
      log.fail(`Insufficient Robux for ${name} (${errMsg})`);
      markAttempted(assetId);
      saveState();
      return;
    }
    if (errCode === 7) {
      log.warn(`Price mismatch on ${name} — will retry`);
      return;
    }
    log.fail(`${name} [${assetId}] — HTTP ${status}: ${errMsg}`);
  } finally {
    releaseSnipe();
    releaseClaim(assetId);
  }
}

function enqueueSnipe(assetId, name) {
  if (isAttempted(assetId) || isSkipped(assetId) || isRejected(assetId)) return;
  if (queuedIds.has(assetId) || inFlight.has(assetId)) return;
  queuedIds.add(assetId);
  snipeQueue.push({ assetId, name: name || String(assetId) });
}

async function snipeQueueWorker() {
  log.info('Snipe queue worker started');
  while (true) {
    await waitIfRateLimited('economy');

    if (snipeQueue.length === 0) {
      await sleep(25);
      continue;
    }

    // Launch as many as semaphore allows (no artificial pile-up)
    while (snipeQueue.length > 0 && semaphore.current < semaphore.max) {
      await waitIfRateLimited('economy');
      const item = snipeQueue.shift();
      queuedIds.delete(item.assetId);
      if (!tryClaim(item.assetId)) continue;

      snipeAsset(item.assetId, item.name).catch(() => {
        releaseClaim(item.assetId);
      });

      if (SNIPE_START_GAP_MS > 0) await sleep(SNIPE_START_GAP_MS);
    }

    await sleep(15);
  }
}

// ==================== CATALOG POLLER ====================
async function processCatalogPage(items) {
  const fresh = [];
  for (const item of items) {
    const id = item.id;
    if (!id) continue;
    if (isAttempted(id) || isRejected(id) || isSkipped(id)) continue;
    if (queuedIds.has(id) || inFlight.has(id)) continue;
    fresh.push(id);
  }
  if (!fresh.length) return 0;

  const batchIds = fresh.slice(0, DETAILS_BATCH);
  let details = [];
  try {
    details = await batchCatalogDetails(batchIds);
  } catch (err) {
    if (err?.response?.status === 429) {
      logRateLimitOnce('Catalog details rate limited');
      return 0;
    }
    // Fallback: enqueue raw ids without batch filter
    let queued = 0;
    for (const id of batchIds) {
      if (queued >= MAX_QUEUE_PER_PAGE) break;
      enqueueSnipe(id, String(id));
      queued++;
    }
    return queued;
  }

  const byId = new Map(details.map((d) => [d.id, d]));
  let queued = 0;

  for (const id of batchIds) {
    if (queued >= MAX_QUEUE_PER_PAGE) break;
    const d = byId.get(id);
    if (!d) {
      enqueueSnipe(id, String(id));
      queued++;
      continue;
    }

    seedCacheFromCatalog(d);

    if (d.hasResellers === false) {
      markRejected(id);
      continue;
    }

    const lowest = d.lowestResalePrice ?? d.lowestPrice;
    if (lowest != null && lowest > MAX_PRICE) {
      markRejected(id);
      continue;
    }

    enqueueSnipe(id, d.name || String(id));
    queued++;
  }

  return queued;
}

async function catalogPoller() {
  log.info('Catalog poller started (page1 priority + batch details)');
  let deepCursor = '';
  let cycle = 0;
  let backoff = 2000;

  while (true) {
    try {
      await waitIfRateLimited('catalog');

      // Always hit page 1 (newest / relevant) — fastest snipes live here
      const page1 = await pollCatalog('');
      const queued1 = await processCatalogPage(page1?.data || []);

      cycle++;
      // Occasionally walk deeper pages for leftovers
      if (cycle % DEEP_PAGE_EVERY === 0) {
        await waitIfRateLimited('catalog');
        const deep = await pollCatalog(deepCursor);
        await processCatalogPage(deep?.data || []);
        deepCursor = deep?.nextPageCursor || '';
      }

      backoff = 2000;
      const jitter = Math.floor(Math.random() * 80);
      await sleep(POLL_MS + jitter);

      if (queued1 > 0) {
        // Slightly faster when the market is hot
        await sleep(Math.max(0, 40 - queued1 * 4));
      }
    } catch (err) {
      if (err?.response?.status === 429) {
        const wait = Math.max(rateLimits.catalog - Date.now(), backoff);
        logRateLimitOnce(`Catalog rate limited — sleep ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, 25000);
      } else {
        log.warn(`Catalog error: ${err.message}`);
        await sleep(1000);
        backoff = 2000;
      }
    }
  }
}

// ==================== DEAL ALERT SCANNER ====================
// Read-only pass: finds listings well under RAP and reports them. Runs beside
// the buy pipeline and never enqueues snipes, so it can ignore MAX_PRICE.
function hasFreshRAP(assetId) {
  const cached = rapCache.get(assetId);
  return Boolean(cached) && Date.now() - cached.ts < RAP_TTL;
}

async function checkDeal(assetId, name, lowestPrice) {
  if (isAlerted(assetId)) return false;
  if (ALERT_MAX_PRICE > 0 && lowestPrice > ALERT_MAX_PRICE) return false;

  let rap;
  try {
    rap = await getRAP(assetId);
  } catch (err) {
    if (err?.response?.status === 429) triggerRateLimit('economy');
    return false;
  }

  if (rap < ALERT_MIN_AVG) return false;

  const discount = Math.round((1 - lowestPrice / rap) * 100);
  if (discount < ALERT_DISCOUNT_PCT) return false;

  markAlerted(assetId);
  totalAlerts++;
  saveState();
  log.found(
    `DEAL ${name} — ${lowestPrice}R$ vs RAP ${rap}R$ (${discount}% off)`
  );
  sendDealAlert({ assetId, name, price: lowestPrice, rap, discount });
  return true;
}

async function alertScanner() {
  if (!ALERT_ENABLED) return;
  if (!WEBHOOK_URL) {
    log.warn('Deal alerts enabled but WEBHOOK_URL is empty — scanner disabled');
    return;
  }
  log.info(
    `Deal scanner started — >=${ALERT_DISCOUNT_PCT}% off RAP, min RAP ${ALERT_MIN_AVG}R$`
      + `${ALERT_MAX_PRICE > 0 ? `, max ${ALERT_MAX_PRICE}R$` : ', no price cap'}`
  );

  let cursor = '';
  let page = 0;
  let backoff = 4000;

  while (true) {
    try {
      await waitIfRateLimited('catalog');
      const res = await pollCatalogForAlerts(cursor);
      const ids = (res?.data || [])
        .map((item) => item?.id)
        .filter((id) => id && !isAlerted(id));

      // Search returns only {id, itemType} — prices and names come from the
      // details batch.
      const details = ids.length ? await batchCatalogDetails(ids) : [];

      const candidates = [];
      for (const d of details) {
        if (!d?.id || isAlerted(d.id)) continue;
        if (d.hasResellers === false) continue;
        const lowest = d.lowestResalePrice ?? d.lowestPrice;
        if (lowest == null || lowest <= 0) continue;
        candidates.push({ id: d.id, name: d.name || String(d.id), lowest });
      }

      // Sequential + budgeted on purpose: RAP lookups share the economy
      // rate-limit bucket with the buy pipeline, which has priority.
      let spent = 0;
      let deferred = 0;
      for (const c of candidates) {
        const cached = hasFreshRAP(c.id);
        if (!cached && spent >= ALERT_LOOKUPS_PER_CYCLE) {
          deferred++;
          continue;
        }
        if (!cached) spent++;
        await checkDeal(c.id, c.name, c.lowest);
        if (!cached && ALERT_RAP_GAP_MS > 0) await sleep(ALERT_RAP_GAP_MS);
      }
      if (deferred > 0) {
        log.info(`Deal scanner: ${deferred} item(s) deferred (lookup budget) — retried on cursor wrap`);
      }

      cursor = res?.nextPageCursor || '';
      page = cursor ? page + 1 : 0;
      if (page >= ALERT_PAGES) {
        cursor = '';
        page = 0;
      }

      backoff = 4000;
      await sleep(ALERT_POLL_MS + Math.floor(Math.random() * 250));
    } catch (err) {
      if (err?.response?.status === 429) {
        const wait = Math.max(rateLimits.catalog - Date.now(), backoff);
        logRateLimitOnce(`Deal scanner rate limited — sleep ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, 60000);
      } else {
        log.warn(`Deal scanner error: ${err.message}`);
        await sleep(3000);
      }
      cursor = '';
      page = 0;
    }
  }
}

// ==================== SHUTDOWN ====================
function shutdown() {
  saveState();
  flushLogs();
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ==================== UTIL ====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== MAIN ====================
async function main() {
  console.log(`\n${B}${CY}╔══════════════════════════════════════╗`);
  console.log(`║   ROBLOX LIMITED SNIPER 2026         ║`);
  console.log(`║   Max Price       : ${String(MAX_PRICE).padEnd(18)}║`);
  console.log(`║   Min Avg Gap     : ${String(MIN_AVG_GAP).padEnd(18)}║`);
  console.log(`║   Max Concurrent  : ${String(MAX_CONCURRENT_SNIPES).padEnd(18)}║`);
  console.log(`║   Poll Interval   : ${`${POLL_MS}ms`.padEnd(18)}║`);
  console.log(`║   Queue/Page      : ${String(MAX_QUEUE_PER_PAGE).padEnd(18)}║`);
  console.log(
    `║   Deal Alerts     : ${(ALERT_ENABLED && WEBHOOK_URL
      ? `>=${ALERT_DISCOUNT_PCT}% off RAP`
      : 'off'
    ).padEnd(18)}║`
  );
  console.log(`╚══════════════════════════════════════╝${R}\n`);

  if (!COOKIE || COOKIE.includes('ILAGAY') || COOKIE.length < 80) {
    console.error(
      `${RD}ERROR: Walang cookie. Ilagay ang .ROBLOSECURITY sa .env (ROBLOSECURITY=...).${R}`
    );
    process.exit(1);
  }

  loadState();

  log.info('Getting XSRF token...');
  if (!(await refreshXSRF()) || !xsrfToken) {
    console.error(`${RD}ERROR: Hindi makuha ang XSRF token. Check mo cookie sa .env.${R}`);
    process.exit(1);
  }
  log.info(`XSRF: ${xsrfToken.slice(0, 10)}...`);

  try {
    const res = await client.get('https://users.roblox.com/v1/users/authenticated');
    const user = res.data;
    loggedInUsername = user.name;
    userId = user.id;
    log.info(
      `Logged in as: ${B}${G}${user.displayName} (@${user.name})${R} [ID: ${user.id}]`
    );
  } catch (e) {
    log.error(`Failed to get user info: ${e.message}`);
  }

  log.info(
    `Ready — resellers <= ${MAX_PRICE}R$ with avg gap >= ${MIN_AVG_GAP}R$ | cwd=${path.resolve('.')}\n`
  );

  xsrfLoop().catch((err) => log.error(`XSRF loop crashed: ${err.message}`));
  healthCheck().catch((err) => log.error(`Health check crashed: ${err.message}`));
  robuxCheck().catch((err) => log.error(`Robux check crashed: ${err.message}`));
  statsLoop().catch((err) => log.error(`Stats loop crashed: ${err.message}`));
  catalogPoller().catch((err) => log.error(`Catalog poller crashed: ${err.message}`));
  snipeQueueWorker().catch((err) => log.error(`Snipe queue worker crashed: ${err.message}`));
  alertScanner().catch((err) => log.error(`Deal scanner crashed: ${err.message}`));

  await new Promise(() => {});
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  saveState();
  process.exit(1);
});
