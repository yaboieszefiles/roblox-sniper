'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);

const { normalizeCollectible, normalizeLegacy } = require('../src/resellers');
const { classify, isSuccess } = require('../src/purchase');
const { normalize } = require('../src/catalog');



test('catalog details routes collectible items by collectibleItemId', () => {
  const item = normalize({
    id: 4771632715,
    name: 'Eggmunition',
    productId: 123,
    collectibleItemId: 'de8c9733-9f5b-42a9-b9f3-b75f581e2fbd',
    itemRestrictions: ['Collectible'],
    lowestResalePrice: 284,
    hasResellers: true,
  });
  assert.strictEqual(item.protocol, 'collectible');
  assert.strictEqual(item.isCollectible, true);
  assert.strictEqual(item.lowestPrice, 284);
});

test('catalog details routes items without collectibleItemId as legacy', () => {
  const item = normalize({
    id: 1028606,
    name: 'Red Baseball Cap',
    productId: 456,
    collectibleItemId: null,
    itemRestrictions: ['Limited'],
    lowestPrice: 1400,
    hasResellers: true,
  });
  assert.strictEqual(item.protocol, 'legacy');
  assert.strictEqual(item.isLimited, true);
});

test('collectible reseller entry carries per-listing product id', () => {
  const item = { assetId: 4771632715, name: 'Eggmunition', collectibleItemId: 'de8c9733', productId: 1 };
  const listing = normalizeCollectible({
    collectibleProductId: '8dad3864-5820-4dff-bb2b-19b275891907',
    collectibleItemInstanceId: 'e36790be-c00b-447c-82c6-f2423817ecc6',
    seller: { hasVerifiedBadge: false, sellerId: 540730749, sellerType: 'User', name: 'fr_idj' },
    price: 284,
    serialNumber: null,
    errorMessage: null,
  }, item);

  assert.strictEqual(listing.protocol, 'collectible');
  assert.strictEqual(listing.price, 284);
  assert.strictEqual(listing.sellerId, 540730749);
  assert.strictEqual(listing.collectibleProductId, '8dad3864-5820-4dff-bb2b-19b275891907');
  
  
  assert.ok(listing.collectibleProductId, 'collectibleProductId must survive normalisation');
});

test('legacy reseller entry carries userAssetId', () => {
  const item = { assetId: 1028606, name: 'Red Baseball Cap', productId: 456 };
  const listing = normalizeLegacy({
    userAssetId: 99887766,
    seller: { id: 12345, name: 'someone' },
    price: 1400,
    serialNumber: 42,
  }, item);

  assert.strictEqual(listing.protocol, 'legacy');
  assert.strictEqual(listing.userAssetId, 99887766);
  assert.strictEqual(listing.sellerId, 12345);
  assert.strictEqual(listing.collectibleProductId, null);
});

test('reseller normalisation rejects entries with no price', () => {
  assert.strictEqual(normalizeCollectible({ seller: {} }, { assetId: 1 }), null);
  assert.strictEqual(normalizeLegacy({ seller: {} }, { assetId: 1 }), null);
  assert.strictEqual(normalizeCollectible(null, { assetId: 1 }), null);
});

test('purchase classify marks sold-out and funds errors terminal', () => {
  const exhausted = classify({ errorMessage: 'QuantityExhausted' }, 400);
  assert.strictEqual(exhausted.code, 'QuantityExhausted');
  assert.strictEqual(exhausted.terminal, true);

  const funds = classify({ errors: [{ message: 'InsufficientFunds' }] }, 400);
  assert.strictEqual(funds.terminal, true);

  const invalid = classify({ errorMessage: 'InvalidArguments' }, 400);
  assert.strictEqual(invalid.code, 'InvalidArguments');
  assert.strictEqual(invalid.terminal, true);
});

test('purchase classify keeps transient errors retryable', () => {
  assert.strictEqual(classify({}, 429).terminal, false);
  assert.strictEqual(classify({}, 429).code, 'RateLimited');
  assert.strictEqual(classify({}, 503).terminal, false);
});

test('isSuccess reads both response shapes', () => {
  assert.strictEqual(isSuccess(200, { purchased: true }), true);
  assert.strictEqual(isSuccess(200, { purchaseResult: 'Success' }), true);
  assert.strictEqual(isSuccess(200, { purchased: false }), false);
  assert.strictEqual(isSuccess(400, { purchased: true }), false);
});
