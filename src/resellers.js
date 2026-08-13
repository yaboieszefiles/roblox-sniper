'use strict';




















const http = require('./http');
const metrics = require('./metrics');
const log = require('./log');



function normalizeCollectible(entry, item) {
  if (!entry || entry.price == null) return null;
  return {
    protocol: 'collectible',
    assetId: item.assetId,
    name: item.name,
    price: Number(entry.price),
    sellerId: entry.seller?.sellerId ?? null,
    sellerType: entry.seller?.sellerType || 'User',
    sellerName: entry.seller?.name || null,
    serialNumber: entry.serialNumber ?? null,

    collectibleItemId: item.collectibleItemId,
    collectibleProductId: entry.collectibleProductId ?? null,
    collectibleItemInstanceId: entry.collectibleItemInstanceId ?? null,

    userAssetId: null,
    productId: item.productId ?? null,
  };
}

function normalizeLegacy(entry, item) {
  if (!entry || entry.price == null) return null;
  return {
    protocol: 'legacy',
    assetId: item.assetId,
    name: item.name,
    price: Number(entry.price),
    sellerId: entry.seller?.id ?? entry.seller?.sellerId ?? null,
    sellerType: 'User',
    sellerName: entry.seller?.name || null,
    serialNumber: entry.serialNumber ?? null,

    collectibleItemId: null,
    collectibleProductId: null,
    collectibleItemInstanceId: null,

    userAssetId: entry.userAssetId ?? null,
    productId: item.productId ?? null,
  };
}





async function fetch(item, { limit = 10, priority = false, preAuthorized = false } = {}) {
  if (!item) return [];

  if (item.protocol === 'collectible') {
    if (!item.collectibleItemId) return [];
    const url =
      `https://apis.roblox.com/marketplace-sales/v1/item/${item.collectibleItemId}/resellers?limit=${limit}`;
    const res = await http.get(url, { priority, preAuthorized, label: 'resellers.collectible' });
    metrics.inc('resellers.collectible');
    const rows = res.data?.data || [];
    return rows
      .map((e) => normalizeCollectible(e, item))
      .filter(Boolean)
      .sort((a, b) => a.price - b.price);
  }

  const url = `https://economy.roblox.com/v1/assets/${item.assetId}/resellers?limit=${limit}&cursor=`;
  try {
    const res = await http.get(url, { priority, preAuthorized, label: 'resellers.legacy' });
    metrics.inc('resellers.legacy');
    const rows = res.data?.data || [];
    return rows
      .map((e) => normalizeLegacy(e, item))
      .filter(Boolean)
      .sort((a, b) => a.price - b.price);
  } catch (err) {
    
    
    if (err.status === 410 || err.status === 404) {
      metrics.inc('resellers.legacy.gone');
      log.debug(`Legacy resellers gone for ${item.assetId} — item is collectible-only`);
      return [];
    }
    throw err;
  }
}


async function cheapest(item, maxPrice, opts) {
  const listings = await fetch(item, opts);
  if (!listings.length) return null;
  const best = listings[0];
  if (maxPrice != null && best.price > maxPrice) return null;
  return best;
}

module.exports = { fetch, cheapest, normalizeCollectible, normalizeLegacy };
