'use strict';











const http = require('./http');
const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');

const SEARCH_URL = 'https://catalog.roblox.com/v1/search/items';
const DETAILS_URL = 'https://catalog.roblox.com/v1/catalog/items/details';


const DEFAULT_TAXONOMY = 'tZsUsd2BqGViQrJ9Vs3Wah';


const ALLOWED_LIMITS = [10, 28, 30, 50, 60, 100, 120];

function snapLimit(n) {
  let best = ALLOWED_LIMITS[0];
  for (const v of ALLOWED_LIMITS) {
    if (v <= n) best = v;
  }
  return best;
}



const details = new Map();

function cacheSize() {
  return details.size;
}

function getCached(assetId) {
  return details.get(assetId) || null;
}

function prune(max = config.maxCacheSize) {
  if (details.size <= max) return 0;
  const target = details.size - Math.floor(max * 0.8);
  let n = 0;
  for (const key of details.keys()) {
    if (n++ >= target) break;
    details.delete(key);
  }
  return n;
}



function normalize(d) {
  if (!d?.id) return null;

  const collectibleItemId = d.collectibleItemId || null;
  const restrictions = Array.isArray(d.itemRestrictions) ? d.itemRestrictions : [];

  const item = {
    assetId: d.id,
    name: d.name || String(d.id),
    productId: d.productId ?? null,
    collectibleItemId,

    
    
    
    
    protocol: collectibleItemId ? 'collectible' : 'legacy',

    isLimited: restrictions.includes('Limited') || restrictions.includes('LimitedUnique'),
    isCollectible: restrictions.includes('Collectible'),
    restrictions,

    lowestPrice: d.lowestResalePrice ?? d.lowestPrice ?? null,
    price: d.price ?? null,
    priceStatus: d.priceStatus ?? null,
    hasResellers: d.hasResellers !== false,
    totalQuantity: d.totalQuantity ?? null,
    unitsAvailable: d.unitsAvailableForConsumption ?? null,

    creatorName: d.creatorName || null,
    creatorTargetId: d.creatorTargetId ?? null,
    creatorType: d.creatorType || null,

    fetchedAt: Date.now(),
  };

  details.set(item.assetId, item);
  return item;
}

async function search({ cursor = '', limit = config.catalogLimit, maxPrice = null } = {}) {
  const params = new URLSearchParams({
    salesTypeFilter: '2',       
    sortType: '3',              
    limit: String(snapLimit(limit)),
  });
  params.set('taxonomy', DEFAULT_TAXONOMY);
  if (config.catalogCreator) params.set('CreatorName', config.catalogCreator);
  if (maxPrice != null) params.set('maxPrice', String(maxPrice));
  if (cursor) params.set('cursor', cursor);

  const res = await http.get(`${SEARCH_URL}?${params}`, { label: 'catalog.search' });
  metrics.inc('catalog.search');
  return {
    items: res.data?.data || [],
    nextCursor: res.data?.nextPageCursor || '',
  };
}



async function batchDetails(assetIds, { priority = false } = {}) {
  const ids = Array.from(new Set(assetIds.filter(Boolean).map(Number)));
  if (!ids.length) return [];

  const chunkSize = Math.min(config.detailsBatch, 120);
  const out = [];

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const body = { items: chunk.map((id) => ({ id, itemType: 'Asset' })) };

    let res;
    try {
      res = await http.post(DETAILS_URL, body, {
        xsrf: true,
        priority,
        label: 'catalog.details',
      });
    } catch (err) {
      if (err.status === 403 && err.csrfToken) {
        
        
        const xsrf = require('./xsrf');
        xsrf.capture(err);
        await xsrf.refresh();
        res = await http.post(DETAILS_URL, body, { xsrf: true, priority, label: 'catalog.details' });
      } else {
        throw err;
      }
    }

    metrics.inc('catalog.details.requests');
    for (const d of res.data?.data || []) {
      const item = normalize(d);
      if (item) out.push(item);
    }
  }

  metrics.inc('catalog.details.items', out.length);
  prune();
  return out;
}


async function resolve(assetId, { maxAgeMs = 3600000, priority = false } = {}) {
  const cached = details.get(assetId);
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return cached;
  const [item] = await batchDetails([assetId], { priority });
  return item || null;
}


async function resolveMany(assetIds, { maxAgeMs = 3600000, priority = false } = {}) {
  const now = Date.now();
  const fresh = [];
  const stale = [];

  for (const id of assetIds) {
    const c = details.get(id);
    if (c && now - c.fetchedAt < maxAgeMs) fresh.push(c);
    else stale.push(id);
  }

  if (stale.length) {
    const fetched = await batchDetails(stale, { priority });
    fresh.push(...fetched);
  }
  return fresh;
}

module.exports = {
  search,
  batchDetails,
  resolve,
  resolveMany,
  normalize,
  getCached,
  cacheSize,
  prune,
  details,
  DEFAULT_TAXONOMY,
};
