'use strict';




const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const auth = require('./auth');
const valuation = require('./valuation');
const resellers = require('./resellers');
const purchase = require('./purchase');
const alerts = require('./alerts');
const rl = require('./ratelimit');
const { state, save, recordSpend, spentLast24h } = require('./state');





class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.current < this.max && this.waiters.length === 0) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();            
      return;
    }
    if (this.current > 0) this.current--;
  }

  get inUse() {
    return this.current;
  }
}

const semaphore = new Semaphore(config.maxConcurrentSnipes);


const inFlight = new Set();

function claim(assetId) {
  if (inFlight.has(assetId)) return false;
  if (state.attempted.has(assetId)) return false;
  if (state.rejected.has(assetId)) return false;
  inFlight.add(assetId);
  return true;
}

function release(assetId) {
  inFlight.delete(assetId);
}




function evaluate(listing, { worth = null, now = Date.now(), item = null } = {}) {
  if (!listing) return { buy: false, reason: 'no-listing' };

  if (config.buyRobloxOnly) {
    if (!item) {
      return { buy: false, reason: 'no-item-metadata' };
    }
    const isRoblox =
      item.creatorTargetId === 1 ||
      (item.creatorName && String(item.creatorName).toLowerCase() === 'roblox');
    if (!isRoblox) {
      return { buy: false, reason: `non-roblox-creator(${item.creatorName || 'unknown'})` };
    }
  }

  const price = listing.price;
  if (price == null || price <= 0) return { buy: false, reason: 'no-price' };
  if (price > config.maxPrice) {
    return { buy: false, reason: `over-cap(${price}>${config.maxPrice})` };
  }

  const itemWorth = worth ?? valuation.worthOf(listing.assetId);

  if (config.buyMinWorth > 0) {
    if (itemWorth < config.buyMinWorth) {
      return { buy: false, reason: `worth-below-min(${itemWorth}<${config.buyMinWorth})`, worth: itemWorth };
    }
  }

  if (!itemWorth) {
    
    
    if (price <= Math.min(5, config.maxPrice)) {
      return { buy: true, reason: 'unknown-but-cheap', worth: 0, profitPct: 0 };
    }
    return { buy: false, reason: 'no-valuation' };
  }

  const meta = valuation.get(listing.assetId);
  if (config.skipProjected && meta?.projected) {
    return { buy: false, reason: 'projected', worth: itemWorth };
  }

  const profitPct = ((itemWorth - price) / price) * 100;
  if (profitPct < config.minProfitPct) {
    return {
      buy: false,
      reason: `thin-margin(${profitPct.toFixed(0)}%<${config.minProfitPct}%)`,
      worth: itemWorth,
      profitPct,
    };
  }

  
  if (config.dailySpendCap > 0) {
    const spent = spentLast24h(now);
    if (spent + price > config.dailySpendCap) {
      return {
        buy: false,
        reason: `daily-cap(${spent}+${price}>${config.dailySpendCap})`,
        worth: itemWorth,
        profitPct,
      };
    }
  }

  return { buy: true, reason: 'ok', worth: itemWorth, profitPct };
}











async function consider(item, { priority = false, source = 'unknown' } = {}) {
  if (!item) return null;
  if (!claim(item.assetId)) return null;

  const t0 = performance.now();

  
  
  const bucketName = item.protocol === 'collectible' ? 'marketplace' : 'economy';
  try {
    await rl.bucket(bucketName).acquire({ priority, timeoutMs: 15000 });
  } catch (err) {
    
    release(item.assetId);
    metrics.inc('engine.token_timeout');
    return null;
  }

  await semaphore.acquire();

  try {
    const listings = await resellers.fetch(item, {
      limit: 10,
      priority,
      
      preAuthorized: true,
    });

    if (!listings.length) {
      state.skipped.set(item.assetId);
      return null;
    }

    const best = listings[0];
    const meta = valuation.get(item.assetId);
    const worth = meta?.worth || 0;

    
    
    alerts.maybeAlert({
      assetId: item.assetId,
      name: item.name,
      price: best.price,
      worth,
      demandLabel: meta?.demandLabel,
      protocol: item.protocol,
    });

    const decision = evaluate(best, { worth, item });
    if (!decision.buy) {
      if (decision.reason.startsWith('over-cap') || decision.reason === 'thin-margin') {
        state.skipped.set(item.assetId);
      } else {
        state.rejected.set(item.assetId);
      }
      log.debug(`skip ${item.name} @${best.price}R$ — ${decision.reason}`);
      metrics.inc(`decision.skip`);
      return null;
    }

    const detectMs = performance.now() - t0;
    log.found(
      `${item.name} — ${best.price}R$ (worth ${worth.toLocaleString()}R$, `
      + `+${decision.profitPct.toFixed(0)}%) via ${item.protocol} [${source}]`,
      { assetId: item.assetId, price: best.price, worth, source }
    );

    const result = await purchase.attempt(best);
    const totalMs = performance.now() - t0;
    metrics.observe('pipeline.detect_to_buy', totalMs);

    state.attempted.set(item.assetId);

    if (result.ok) {
      state.totals.sniped++;
      recordSpend(best.price);
      metrics.recordOutcome('purchased');
      log.snipe(
        `BOUGHT ${item.name} for ${best.price}R$ `
        + `(worth ${worth.toLocaleString()}R$) in ${Math.round(totalMs)}ms — total ${state.totals.sniped}`,
        { assetId: item.assetId, price: best.price, worth, ms: Math.round(totalMs) }
      );
      alerts.sniped({
        assetId: item.assetId,
        name: item.name,
        price: best.price,
        worth,
        protocol: item.protocol,
        elapsedMs: totalMs,
        username: auth.identity.username,
      });
    } else if (result.dryRun) {
      metrics.recordOutcome('dry_run');
      metrics.observe('pipeline.detect_to_decision', totalMs);
    } else {
      state.totals.failed++;
      metrics.recordOutcome(mapOutcome(result.code));
      log.fail(
        `${item.name} @${best.price}R$ — ${result.code} (${Math.round(totalMs)}ms)`,
        { assetId: item.assetId, price: best.price, code: result.code }
      );
    }

    save();
    return result;
  } catch (err) {
    if (err.status === 429) {
      state.skipped.set(item.assetId);
      metrics.recordOutcome('rate_limited');
      return null;
    }
    log.warn(`consider(${item.assetId}) failed: ${err.message}`);
    metrics.inc('engine.error');
    return null;
  } finally {
    semaphore.release();
    release(item.assetId);
  }
}

function mapOutcome(code) {
  const c = String(code).toLowerCase();
  if (c.includes('quantityexhausted') || c.includes('soldout')) return 'quantity_exhausted';
  if (c.includes('insufficient')) return 'insufficient_funds';
  if (c.includes('price')) return 'price_mismatch';
  if (c.includes('alreadyowned')) return 'already_owned';
  if (c.includes('invalidarguments')) return 'invalid_arguments';
  if (c.includes('ratelimited')) return 'rate_limited';
  return 'error';
}

module.exports = {
  Semaphore,
  semaphore,
  evaluate,
  consider,
  claim,
  release,
  inFlight,
  mapOutcome,
};
