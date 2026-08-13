'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);
process.env.MAX_PRICE = '22';
process.env.ALERT_DISCOUNT_PCT = '40';

const { worthChecking } = require('../src/watchlist');
const valuation = require('../src/valuation');






function entry(worth) {
  return { assetId: 555, name: 'Test', worth };
}

test('anything within the buy cap is always checked', () => {
  assert.strictEqual(worthChecking(entry(0), 22), true, 'at the cap');
  assert.strictEqual(worthChecking(entry(0), 5), true, 'under the cap');
  assert.strictEqual(worthChecking(entry(100000), 1), true, 'cheap and valuable');
});

test('prices over the cap need a real discount to be worth a lookup', () => {
  
  
  assert.strictEqual(worthChecking(entry(5000), 1000), true);

  
  assert.strictEqual(worthChecking(entry(5000), 4000), false);
});

test('no valuation means no lookup above the cap', () => {
  valuation.items.clear();
  assert.strictEqual(worthChecking(entry(0), 500), false);
});

test('missing or zero prices are never checked', () => {
  assert.strictEqual(worthChecking(entry(5000), null), false);
  assert.strictEqual(worthChecking(entry(5000), 0), false);
  assert.strictEqual(worthChecking(entry(5000), undefined), false);
});

test('falls back to the valuation table when the entry has no worth', () => {
  valuation.items.clear();
  valuation.items.set(555, {
    assetId: 555, name: 'Test', worth: 10000, projected: false, demand: 3,
  });

  
  assert.strictEqual(worthChecking({ assetId: 555, name: 'Test' }, 1000), true);
  valuation.items.clear();
});
