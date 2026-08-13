'use strict';





require('dotenv').config();

const fallbacks = [];

function num(key, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    fallbacks.push(key);
    return def;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new ConfigError(`${key}="${raw}" is not a number`);
  }
  if (v < min || v > max) {
    throw new ConfigError(`${key}=${v} is outside allowed range ${min}..${max}`);
  }
  return v;
}

function bool(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    fallbacks.push(key);
    return def;
  }
  const s = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new ConfigError(`${key}="${raw}" is not a boolean`);
}

function str(key, def) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (def !== '') fallbacks.push(key);
    return def;
  }
  return String(raw).trim();
}

function list(key) {
  const raw = str(key, '');
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const cliDryRun = process.argv.includes('--dry-run');

const config = {
  cookie: str('ROBLOSECURITY', ''),
  webhookUrl: str('WEBHOOK_URL', ''),

  dryRun: cliDryRun || bool('DRY_RUN', false),

  
  maxPrice: num('MAX_PRICE', 22, { min: 1 }),
  minProfitPct: num('MIN_PROFIT_PCT', 15, { min: 0, max: 100000 }),
  dailySpendCap: num('DAILY_SPEND_CAP', 0, { min: 0 }),
  skipProjected: bool('SKIP_PROJECTED', true),
  minItemValue: num('MIN_ITEM_VALUE', 100, { min: 0 }),
  buyRobloxOnly: bool('BUY_ROBLOX_ONLY', false),
  buyMinWorth: num('BUY_MIN_WORTH', 0, { min: 0 }),

  
  
  
  
  
  
  
  
  
  watchlistEnabled: bool('WATCHLIST_ENABLED', true),
  watchlistSize: num('WATCHLIST_SIZE', 240, { min: 1, max: 5000 }),
  watchlistIntervalMs: num('WATCHLIST_INTERVAL_MS', 1500, { min: 250 }),
  watchlistRebuildMs: num('WATCHLIST_REBUILD_MS', 1800000, { min: 60000 }),
  
  
  watchlistFollowUps: num('WATCHLIST_FOLLOW_UPS', 3, { min: 1, max: 50 }),
  watchIds: list('WATCH_IDS').map(Number).filter(Number.isFinite),

  
  discoveryEnabled: bool('DISCOVERY_ENABLED', true),
  discoveryIntervalMs: num('DISCOVERY_INTERVAL_MS', 2500, { min: 250 }),
  discoveryIdleMs: num('DISCOVERY_IDLE_MS', 4000, { min: 250 }),
  discoveryBatch: num('DISCOVERY_BATCH', 6, { min: 1, max: 100 }),
  discoveryMaxPrice: num('DISCOVERY_MAX_PRICE', 0, { min: 0 }),
  catalogLimit: num('CATALOG_LIMIT', 120, { min: 10, max: 120 }),
  detailsBatch: num('DETAILS_BATCH', 120, { min: 1, max: 120 }),
  catalogCreator: str('CATALOG_CREATOR', ''),

  maxConcurrentSnipes: num('MAX_CONCURRENT_SNIPES', 4, { min: 1, max: 32 }),

  
  
  buyRetries: num('BUY_RETRIES', 1, { min: 0, max: 5 }),

  
  alertEnabled: bool('ALERT_ENABLED', true),
  alertDiscountPct: num('ALERT_DISCOUNT_PCT', 40, { min: 1, max: 99 }),
  alertMaxPrice: num('ALERT_MAX_PRICE', 0, { min: 0 }),
  alertMinValue: num('ALERT_MIN_VALUE', 50, { min: 0 }),
  alertTtl: num('ALERT_TTL', 21600000, { min: 1000 }),

  
  rolimonsEnabled: bool('ROLIMONS_ENABLED', true),
  rolimonsRefreshMs: num('ROLIMONS_REFRESH_MS', 300000, { min: 60000 }),

  
  
  
  
  
  
  
  rps: {
    catalog: num('RPS_CATALOG', 2.5, { min: 0.1, max: 100 }),
    economy: num('RPS_ECONOMY', 6, { min: 0.1, max: 100 }),
    marketplace: num('RPS_MARKETPLACE', 3.5, { min: 0.1, max: 100 }),
  },

  
  stateFile: str('STATE_FILE', 'sniper_state.json'),
  logFile: str('LOG_FILE', 'sniper.log'),
  jsonlFile: str('JSONL_FILE', 'sniper.jsonl'),
  logLevel: str('LOG_LEVEL', 'info'),

  proxies: list('PROXY_LIST'),
  autoProxies: bool('AUTO_PROXIES', true),
  autoProxiesRefreshMs: num('AUTO_PROXIES_REFRESH_MS', 600000, { min: 60000 }),
  autoProxiesLimit: num('AUTO_PROXIES_LIMIT', 10, { min: 1, max: 100 }),

  
  attemptedTtl: num('ATTEMPTED_TTL', 86400000, { min: 1000 }),
  skipTtl: num('SKIP_TTL', 90000, { min: 1000 }),
  rejectTtl: num('REJECT_TTL', 600000, { min: 1000 }),
  xsrfMs: num('XSRF_MS', 300000, { min: 10000 }),
  maxCacheSize: num('MAX_CACHE_SIZE', 20000, { min: 100 }),
};


const problems = [];

if (!config.cookie) {
  problems.push('ROBLOSECURITY is empty — paste your .ROBLOSECURITY cookie value into .env');
} else if (config.cookie.length < 80) {
  problems.push(
    `ROBLOSECURITY looks too short (${config.cookie.length} chars) — did you paste the whole value?`
  );
} else if (/ILAGAY|YOUR_|PASTE/i.test(config.cookie)) {
  problems.push('ROBLOSECURITY still contains placeholder text');
}

if (config.alertEnabled && !config.webhookUrl) {
  
  fallbacks.push('WEBHOOK_URL (alerts will be logged only)');
}

if (config.dailySpendCap > 0 && config.dailySpendCap < config.maxPrice) {
  problems.push(
    `DAILY_SPEND_CAP=${config.dailySpendCap} is below MAX_PRICE=${config.maxPrice} — nothing could ever be bought`
  );
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
if (!LOG_LEVELS.includes(config.logLevel)) {
  problems.push(`LOG_LEVEL="${config.logLevel}" must be one of ${LOG_LEVELS.join(', ')}`);
}

config.problems = problems;
config.fallbacks = fallbacks;
config.ConfigError = ConfigError;


config.safeSummary = function safeSummary() {
  return {
    dryRun: config.dryRun,
    maxPrice: config.maxPrice,
    minProfitPct: config.minProfitPct,
    dailySpendCap: config.dailySpendCap || 'none',
    watchlistSize: config.watchlistSize,
    watchlistPollMs: config.watchlistPollMs,
    discoveryPollMs: config.discoveryPollMs,
    detailsBatch: config.detailsBatch,
    catalogCreator: config.catalogCreator || '(all creators)',
    maxConcurrentSnipes: config.maxConcurrentSnipes,
    skipProjected: config.skipProjected,
    minItemValue: config.minItemValue,
    buyRobloxOnly: config.buyRobloxOnly,
    buyMinWorth: config.buyMinWorth,
    autoProxies: config.autoProxies,
    autoProxiesLimit: config.autoProxiesLimit,
    rolimons: config.rolimonsEnabled,
    alerts: config.alertEnabled && config.webhookUrl ? `>=${config.alertDiscountPct}% off` : 'off',
    proxies: config.proxies.length,
    cookie: config.cookie ? `set (${config.cookie.length} chars)` : 'MISSING',
  };
};

module.exports = config;
