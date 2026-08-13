'use strict';












const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const catalog = require('./catalog');
const valuation = require('./valuation');
const engine = require('./engine');
const rl = require('./ratelimit');
const { state } = require('./state');

let pagesScanned = 0;
let itemsSeen = 0;
let cursor = '';


async function sweep() {
  const { items, nextCursor } = await catalog.search({
    limit: config.catalogLimit,
    cursor,
    
    
    maxPrice: config.discoveryMaxPrice > 0 ? config.discoveryMaxPrice : null,
  });

  cursor = nextCursor || '';
  pagesScanned++;

  const ids = items.map((i) => i.id).filter(Boolean);
  if (!ids.length) return 0;

  const details = await catalog.batchDetails(ids);
  itemsSeen += details.length;
  metrics.inc('discovery.items', details.length);

  
  
  const candidates = details.filter((item) => {
    if (state.attempted.has(item.assetId)) return false;
    if (state.rejected.has(item.assetId)) return false;
    if (item.hasResellers === false) return false;

    const low = item.lowestPrice ?? item.price;
    if (low == null || low <= 0) return false;

    
    
    const ceiling = Math.max(config.maxPrice, config.alertMaxPrice || 0);
    if (ceiling > 0 && low > ceiling) return false;

    const meta = valuation.get(item.assetId);
    if (config.skipProjected && meta?.projected) return false;

    
    
    if (meta?.worth) {
      const discount = (1 - low / meta.worth) * 100;
      const minSignal = Math.min(config.alertDiscountPct, config.minProfitPct / 2);
      if (discount < minSignal) return false;
      return true;
    }

    
    return low <= Math.min(10, ceiling || 10);
  });

  if (!candidates.length) return 0;

  log.debug(`Discovery: ${candidates.length}/${details.length} candidates on page ${pagesScanned}`);
  metrics.inc('discovery.candidates', candidates.length);

  
  candidates.sort((a, b) => (a.lowestPrice ?? a.price ?? 0) - (b.lowestPrice ?? b.price ?? 0));

  const batch = candidates.slice(0, config.discoveryBatch);
  await Promise.allSettled(
    batch.map((item) => engine.consider(item, { priority: false, source: 'discovery' }))
  );

  return batch.length;
}

async function loop(signal) {
  if (!config.discoveryEnabled) {
    log.info('Discovery lane disabled');
    return;
  }

  while (!signal?.aborted) {
    try {
      const n = await sweep();
      if (!cursor) {
        
        metrics.inc('discovery.wraps');
        log.debug(`Discovery wrapped after ${pagesScanned} pages`);
      }
      if (n === 0) await rl.sleep(config.discoveryIdleMs);
    } catch (err) {
      if (err.status === 429) {
        metrics.inc('discovery.throttled');
        await rl.sleep(config.discoveryIdleMs * 2);
      } else {
        log.warn(`Discovery sweep failed: ${err.message}`);
        await rl.sleep(config.discoveryIdleMs);
      }
    }
    await rl.sleep(config.discoveryIntervalMs);
  }
}

function status() {
  return { pagesScanned, itemsSeen, cursor: cursor ? 'active' : 'wrapped' };
}

module.exports = { sweep, loop, status };
