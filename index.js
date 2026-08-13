'use strict';









const config = require('./src/config');
const log = require('./src/log');
const metrics = require('./src/metrics');
const rl = require('./src/ratelimit');
const state = require('./src/state');

const C = log.colors;

function banner() {
  const s = config.safeSummary();
  const line = (k, v) => `║ ${String(k).padEnd(20)} ${String(v).padEnd(31)}║`;
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗`);
  console.log(`║           ROBLOX LIMITED SNIPER  v3.0                ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(line('Mode', s.dryRun ? 'DRY RUN (buys nothing)' : 'ARMED — will buy'));
  console.log(line('Max price', `${s.maxPrice}R$`));
  console.log(line('Min profit', `${s.minProfitPct}%`));
  console.log(line('Daily cap', s.dailySpendCap));
  console.log(line('Watchlist', `${s.watchlistSize} items @ ${config.watchlistIntervalMs}ms`));  console.log(line('Discovery', `${config.discoveryIntervalMs}ms, batch ${s.detailsBatch}`));
  console.log(line('Creator filter', s.catalogCreator));
  console.log(line('Concurrency', s.maxConcurrentSnipes));
  console.log(line('Valuation', s.rolimons ? 'Rolimons bulk feed' : 'live RAP only'));
  console.log(line('Alerts', s.alerts));
  console.log(line('Proxies', s.proxies || 'direct'));
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);
}


async function supervise(name, fn, signal) {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await fn(signal);
      if (signal.aborted) return;
      
      log.debug(`${name} loop finished`);
      return;
    } catch (err) {
      if (signal.aborted) return;
      failures++;
      metrics.inc(`supervisor.restart.${name}`);
      const wait = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      log.error(`${name} crashed (${err.message}) — restarting in ${wait / 1000}s`);
      await rl.sleep(wait);
    }
  }
}

async function statsLoop(signal) {
  const watchlist = require('./src/watchlist');
  const discovery = require('./src/discovery');
  const catalog = require('./src/catalog');
  const valuation = require('./src/valuation');
  const engine = require('./src/engine');
  const auth = require('./src/auth');

  while (!signal.aborted) {
    await rl.sleep(30000);
    if (signal.aborted) break;

    const w = watchlist.status();
    const d = discovery.status();
    const v = valuation.status();
    const outcomes = metrics.outcomeBreakdown();
    const buyLat = metrics.hist('pipeline.detect_to_buy')?.summary();

    const outStr = Object.entries(outcomes).map(([k, n]) => `${k}=${n}`).join(' ') || 'none yet';

    log.info(
      `${C.bold}[${metrics.uptimeSec()}s]${C.reset} `
      + `sniped=${C.green}${state.state.totals.sniped}${C.reset} `
      + `failed=${state.state.totals.failed} alerts=${state.state.totals.alerts} | `
      + `watch=${w.size}(${w.sweeps}sw/${w.triggers}tr) disc=${d.pagesScanned}pg/${d.itemsSeen}it | `
      + `active=${engine.semaphore.inUse}/${config.maxConcurrentSnipes} | `
      + `bal=${auth.cachedBalance()}R$ spent24h=${state.spentLast24h()}R$ | `
      + `rolimons=${v.items} cache=${catalog.cacheSize()}`
    );
    log.info(`  outcomes: ${outStr}${buyLat ? ` | detect→buy p50=${buyLat.p50}ms p95=${buyLat.p95}ms` : ''}`);

    
    const buckets = rl.snapshotAll();
    const hot = Object.entries(buckets)
      .filter(([, b]) => b.throttled > 0 || b.queued > 0)
      .map(([n, b]) => `${n}:rps=${b.rps}${b.queued ? ` q=${b.queued}` : ''}${b.throttled ? ` 429s=${b.throttled}` : ''}`);
    if (hot.length) log.info(`  limits: ${hot.join(' | ')}`);

    metrics.set('state.attempted', state.state.attempted.size);
    state.pruneAll();
    catalog.prune();
  }
}

async function main() {
  banner();

  if (config.problems.length) {
    for (const p of config.problems) console.error(`${C.red}CONFIG ERROR: ${p}${C.reset}`);
    process.exit(1);
  }
  if (config.fallbacks.length) {
    log.debug(`Using defaults for ${config.fallbacks.length} unset keys`);
  }

  
  rl.register('catalog', config.rps.catalog);
  rl.register('economy', config.rps.economy);
  rl.register('marketplace', config.rps.marketplace);
  rl.register('rolimons', 0.5, { ceiling: 1 });
  rl.register('other', 5);

  const http = require('./src/http');
  const xsrf = require('./src/xsrf');
  const auth = require('./src/auth');
  const valuation = require('./src/valuation');
  const watchlist = require('./src/watchlist');
  const discovery = require('./src/discovery');
  const alerts = require('./src/alerts');
  const proxyAuto = require('./src/proxyAuto');

  state.load();

  if (config.autoProxies) {
    try {
      const found = await proxyAuto.findWorkingProxies(config.autoProxiesLimit);
      if (found.length > 0) {
        http.setProxies(found);
      } else {
        log.warn('No working proxies found. Proceeding with direct connection.');
      }
    } catch (err) {
      log.warn(`Failed to auto-discover proxies: ${err.message}. Proceeding with direct connection.`);
    }
  }

  await http.prewarm();

  log.info('Fetching XSRF token...');
  await xsrf.refresh();
  if (!xsrf.current()) {
    console.error(`${C.red}FATAL: could not get XSRF token — check your cookie in .env${C.reset}`);
    process.exit(1);
  }

  try {
    const me = await auth.whoami();
    const bal = await auth.balance({ force: true });
    log.info(
      `Logged in as ${C.bold}${C.green}${me.displayName} (@${me.username})${C.reset} `
      + `[${me.userId}] — ${bal}R$`
    );
    if (bal < config.maxPrice) {
      log.warn(`Balance ${bal}R$ is below MAX_PRICE ${config.maxPrice}R$ — few or no buys possible`);
    }
  } catch (err) {
    console.error(`${C.red}FATAL: auth failed — ${err.message}${C.reset}`);
    process.exit(1);
  }

  if (config.rolimonsEnabled) {
    log.info('Loading Rolimons valuations...');
    await valuation.refresh();
  }

  const controller = new AbortController();
  const { signal } = controller;

  http.startKeepAlive();

  const lanes = [
    supervise('xsrf', xsrf.loop, signal),
    supervise('health', (s) => auth.healthLoop(s, () => shutdown('cookie-dead')), signal),
    supervise('balance', auth.balanceLoop, signal),
    supervise('valuation', valuation.loop, signal),
    supervise('watchlist', watchlist.loop, signal),
    supervise('discovery', discovery.loop, signal),
    supervise('proxy-refresher', proxyAuto.loop, signal),
    supervise('stats', statsLoop, signal),
  ];

  log.info(
    `${C.bold}Running${C.reset} — ${config.dryRun ? 'DRY RUN, nothing will be bought' : 'ARMED'}`
  );
  if (config.webhookUrl) {
    alerts.notice(
      'Sniper started',
      `Mode: ${config.dryRun ? 'dry run' : 'armed'}\nMax price: ${config.maxPrice}R$\n`
      + `Watchlist: ${config.watchlistSize}`,
      config.dryRun ? 0x64748b : 0x22c55e
    );
  }

  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${reason})...`);
    controller.abort();

    state.saveSync();

    const snap = metrics.snapshot();
    log.info(
      `Final: sniped=${state.state.totals.sniped} failed=${state.state.totals.failed} `
      + `alerts=${state.state.totals.alerts} spent24h=${state.spentLast24h()}R$`
    );
    log.audit({ evt: 'shutdown', reason, metrics: snap });
    log.flushSync();

    
    setTimeout(() => process.exit(0), 400).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught: ${err.message}\n${err.stack}`);
    metrics.inc('uncaught');
  });
  process.on('unhandledRejection', (err) => {
    log.error(`Unhandled rejection: ${err?.message || err}`);
    metrics.inc('unhandled_rejection');
  });

  await Promise.allSettled(lanes);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}\n${err.stack}`);
  state.saveSync();
  log.flushSync();
  process.exit(1);
});
