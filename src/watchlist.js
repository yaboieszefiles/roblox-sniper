'use strict';





















const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const catalog = require('./catalog');
const valuation = require('./valuation');
const engine = require('./engine');
const rl = require('./ratelimit');


const watched = new Map();

let sweeps = 0;
let triggers = 0;

async function build() {
  const pinned = config.watchIds;
  const wanted = new Map();
  for (const id of pinned) wanted.set(id, true);

  const budget = config.maxPrice;
  for (const item of valuation.topCandidates(config.watchlistSize, { budget })) {
    if (!wanted.has(item.assetId)) wanted.set(item.assetId, false);
  }

  const ids = Array.from(wanted.keys());
  if (!ids.length) {
    log.warn('Watchlist empty — no Rolimons data and no WATCH_IDS set');
    return 0;
  }

  const resolved = await catalog.resolveMany(ids, { maxAgeMs: 6 * 3600000 });

  watched.clear();
  let collectible = 0;
  let unsellable = 0;

  for (const item of resolved) {
    if (item.protocol === 'collectible' && !item.collectibleItemId) { unsellable++; continue; }
    if (item.protocol === 'legacy' && !item.productId) { unsellable++; continue; }

    watched.set(item.assetId, {
      ...item,
      pinned: wanted.get(item.assetId) === true,
      worth: valuation.worthOf(item.assetId),
      lastSeenPrice: item.lowestPrice ?? null,
      triggers: 0,
    });
    if (item.protocol === 'collectible') collectible++;
  }

  log.info(
    `Watchlist: ${watched.size} items (${collectible} collectible, `
    + `${unsellable} unsellable skipped, ${pinned.length} pinned)`
  );
  metrics.set('watchlist.size', watched.size);
  return watched.size;
}




function worthChecking(entry, lowestPrice) {
  if (lowestPrice == null || lowestPrice <= 0) return false;

  
  if (lowestPrice <= config.maxPrice) return true;

  
  const worth = entry.worth || valuation.worthOf(entry.assetId);
  if (!worth) return false;
  const discount = (1 - lowestPrice / worth) * 100;
  return discount >= config.alertDiscountPct;
}



async function tick() {
  if (!watched.size) return 0;

  const ids = Array.from(watched.keys());
  const fresh = await catalog.batchDetails(ids);
  sweeps++;
  metrics.inc('watchlist.sweeps');
  metrics.inc('watchlist.prices_checked', fresh.length);

  const hits = [];
  for (const item of fresh) {
    const entry = watched.get(item.assetId);
    if (!entry) continue;

    const price = item.lowestPrice ?? null;
    const previous = entry.lastSeenPrice;
    entry.lastSeenPrice = price;
    entry.name = item.name || entry.name;
    
    
    entry.collectibleItemId = item.collectibleItemId || entry.collectibleItemId;
    entry.protocol = item.protocol;
    entry.hasResellers = item.hasResellers;

    if (!item.hasResellers) continue;
    if (!worthChecking(entry, price)) continue;

    
    const dropped = previous != null && price != null && price < previous;
    hits.push({ entry, price, dropped });
  }

  if (!hits.length) return 0;

  
  hits.sort((a, b) => (b.dropped - a.dropped) || (a.price - b.price));

  const batch = hits.slice(0, config.watchlistFollowUps);
  triggers += batch.length;
  metrics.inc('watchlist.triggers', batch.length);

  for (const hit of batch) {
    log.debug(
      `watchlist trigger: ${hit.entry.name} @${hit.price}R$`
      + `${hit.dropped ? ' (price dropped)' : ''}`
    );
  }

  await Promise.allSettled(
    batch.map((hit) => engine.consider(hit.entry, { priority: false, source: 'watchlist' }))
  );

  return batch.length;
}

async function loop(signal) {
  if (!config.watchlistEnabled) {
    log.info('Watchlist lane disabled');
    return;
  }

  await build();
  let lastBuild = Date.now();

  while (!signal?.aborted) {
    try {
      await tick();
    } catch (err) {
      if (err.status === 429) {
        metrics.inc('watchlist.throttled');
      } else {
        log.warn(`Watchlist sweep failed: ${err.message}`);
      }
    }

    if (Date.now() - lastBuild > config.watchlistRebuildMs) {
      try {
        await build();
        lastBuild = Date.now();
      } catch (err) {
        log.warn(`Watchlist rebuild failed: ${err.message}`);
      }
    }

    await rl.sleep(config.watchlistIntervalMs);
  }
}

function status() {
  return {
    size: watched.size,
    sweeps,
    triggers,
    collectible: Array.from(watched.values()).filter((i) => i.protocol === 'collectible').length,
  };
}

module.exports = { build, tick, loop, status, worthChecking, watched };
