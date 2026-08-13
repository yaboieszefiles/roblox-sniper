'use strict';


















const { randomUUID } = require('crypto');
const http = require('./http');
const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const auth = require('./auth');
const xsrf = require('./xsrf');


const TERMINAL = new Set([
  'AlreadyOwned',
  'InsufficientFunds',
  'InsufficientRobux',
  'ItemNotFound',
  'ProductNotFound',
  'QuantityExhausted',
  'SoldOut',
  'PriceChanged',
  'NotForSale',
  'InvalidArguments',
]);

function classify(body, status) {
  const raw =
    body?.errors?.[0]?.message
    || body?.errorMessage
    || body?.purchaseResult
    || body?.message
    || '';
  const text = String(raw);

  for (const code of TERMINAL) {
    if (text.toLowerCase().includes(code.toLowerCase())) return { code, terminal: true, text };
  }
  if (status === 429) return { code: 'RateLimited', terminal: false, text };
  if (status >= 500) return { code: 'ServerError', terminal: false, text };
  return { code: text || `HTTP ${status}`, terminal: false, text };
}

function isSuccess(status, body) {
  if (status < 200 || status >= 300) return false;
  if (body?.purchased === true) return true;
  if (body?.purchaseResult === 'Success') return true;
  
  if (body?.purchased === undefined && body?.receipt) return true;
  return false;
}

async function buyCollectible(listing, idempotencyKey) {
  const url =
    `https://apis.roblox.com/marketplace-sales/v1/item/${listing.collectibleItemId}/purchase-item`;
  const body = {
    collectibleItemId: listing.collectibleItemId,
    collectibleProductId: listing.collectibleProductId,
    expectedPrice: listing.price,
    expectedCurrency: 1,
    expectedPurchaserId: String(auth.identity.userId),
    expectedPurchaserType: 'User',
    expectedSellerId: String(listing.sellerId),
    expectedSellerType: listing.sellerType || 'User',
    idempotencyKey,
  };
  return http.post(url, body, {
    xsrf: true,
    priority: true,     
    retries: 0,         
    timeoutMs: 6000,
    label: 'purchase.collectible',
  });
}

async function buyLegacy(listing, idempotencyKey) {
  const url = `https://economy.roblox.com/v1/purchases/products/${listing.productId}`;
  const body = {
    expectedCurrency: 1,
    expectedPrice: listing.price,
    expectedSellerId: listing.sellerId,
    userAssetId: listing.userAssetId,
    idempotencyKey,
  };
  return http.post(url, body, {
    xsrf: true,
    priority: true,
    retries: 0,
    timeoutMs: 6000,
    label: 'purchase.legacy',
  });
}





async function attempt(listing, { dryRun = config.dryRun } = {}) {
  if (!listing) return { ok: false, code: 'NoListing' };

  
  if (listing.price > config.maxPrice) {
    return { ok: false, code: 'OverMaxPrice', price: listing.price, listing };
  }
  if (listing.protocol === 'collectible' && !listing.collectibleProductId) {
    return { ok: false, code: 'MissingProductId', price: listing.price, listing };
  }
  if (listing.protocol === 'legacy' && !listing.userAssetId) {
    return { ok: false, code: 'MissingUserAssetId', price: listing.price, listing };
  }
  if (listing.sellerId && auth.identity.userId
      && String(listing.sellerId) === String(auth.identity.userId)) {
    return { ok: false, code: 'OwnListing', price: listing.price, listing };
  }

  const bal = auth.cachedBalance();
  if (bal > 0 && listing.price > bal) {
    return { ok: false, code: 'InsufficientFunds', price: listing.price, listing };
  }

  if (dryRun) {
    log.snipe(
      `[DRY RUN] would buy "${listing.name}" (${listing.assetId}) @ ${listing.price}R$ `
      + `from ${listing.sellerName || listing.sellerId} via ${listing.protocol}`
    );
    metrics.inc('purchase.dryrun');
    return { ok: false, code: 'DryRun', price: listing.price, listing, dryRun: true };
  }

  await xsrf.ensure();

  const idempotencyKey = randomUUID();
  const t0 = performance.now();
  let lastCode = 'Unknown';

  for (let attemptNo = 0; attemptNo <= config.buyRetries; attemptNo++) {
    try {
      const res = listing.protocol === 'collectible'
        ? await buyCollectible(listing, idempotencyKey)
        : await buyLegacy(listing, idempotencyKey);

      const elapsed = performance.now() - t0;

      if (isSuccess(res.status, res.data)) {
        metrics.inc('purchase.success');
        metrics.observe('purchase.latency', elapsed);
        auth.debit(listing.price);
        auth.invalidateBalance();
        return { ok: true, code: 'Success', elapsed, price: listing.price, listing };
      }

      const cls = classify(res.data, res.status);
      lastCode = cls.code;
      metrics.inc(`purchase.fail.${cls.code}`);
      if (cls.terminal) {
        return { ok: false, code: cls.code, elapsed, price: listing.price, listing };
      }
    } catch (err) {
      const cls = classify(err.body, err.status || 0);
      lastCode = cls.code;
      metrics.inc(`purchase.fail.${cls.code}`);

      
      if (err.status === 403 && err.csrfToken) {
        xsrf.capture(err);
        await xsrf.refresh();
        continue;
      }
      if (cls.terminal) {
        return {
          ok: false,
          code: cls.code,
          elapsed: performance.now() - t0,
          price: listing.price,
          listing,
        };
      }
    }
  }

  return {
    ok: false,
    code: lastCode,
    elapsed: performance.now() - t0,
    price: listing.price,
    listing,
  };
}

module.exports = { attempt, classify, isSuccess, TERMINAL };
