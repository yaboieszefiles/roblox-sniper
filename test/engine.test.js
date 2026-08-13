'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);
process.env.MAX_PRICE = '22';
process.env.MIN_PROFIT_PCT = '15';
process.env.BUY_ROBLOX_ONLY = 'false';
process.env.BUY_MIN_WORTH = '0';

const config = require('../src/config');
const { evaluate, Semaphore } = require('../src/engine');
const valuation = require('../src/valuation');

function listing(price, extra = {}) {
  return {
    protocol: 'collectible',
    assetId: 111,
    name: 'Test Item',
    price,
    sellerId: 999,
    collectibleItemId: 'cid',
    collectibleProductId: 'pid',
    ...extra,
  };
}

test('evaluate buys a clear-margin listing', () => {
  const d = evaluate(listing(10), { worth: 1000 });
  assert.strictEqual(d.buy, true);
  assert.strictEqual(d.reason, 'ok');
});

test('evaluate rejects above the price cap', () => {
  const d = evaluate(listing(50), { worth: 100000 });
  assert.strictEqual(d.buy, false);
  assert.match(d.reason, /over-cap/);
});

test('evaluate rejects thin margins', () => {
  
  const d = evaluate(listing(20), { worth: 21 });
  assert.strictEqual(d.buy, false);
  assert.match(d.reason, /thin-margin/);
});

test('evaluate buys cheap unknowns but not pricey ones', () => {
  valuation.items.clear();
  const cheap = evaluate(listing(3), { worth: 0 });
  assert.strictEqual(cheap.buy, true);
  assert.strictEqual(cheap.reason, 'unknown-but-cheap');

  const pricey = evaluate(listing(20), { worth: 0 });
  assert.strictEqual(pricey.buy, false);
  assert.strictEqual(pricey.reason, 'no-valuation');
});

test('evaluate rejects listings with no usable price', () => {
  assert.strictEqual(evaluate(listing(0), { worth: 1000 }).buy, false);
  assert.strictEqual(evaluate(null).buy, false);
  assert.strictEqual(evaluate(listing(null), { worth: 1000 }).buy, false);
});

test('evaluate skips projected items', () => {
  valuation.items.clear();
  valuation.items.set(111, {
    assetId: 111, name: 'Test Item', worth: 5000, projected: true, demand: 3,
  });
  const d = evaluate(listing(10), { worth: 5000 });
  assert.strictEqual(d.buy, false);
  assert.strictEqual(d.reason, 'projected');
  valuation.items.clear();
});

test('daily spend cap blocks a buy that would exceed it', () => {
  const original = config.dailySpendCap;
  config.dailySpendCap = 20;

  const state = require('../src/state');
  state.state.spendLedger = [[Date.now(), 15]];

  const d = evaluate(listing(10), { worth: 10000 });
  assert.strictEqual(d.buy, false, '15 spent + 10 more exceeds the 20 cap');
  assert.match(d.reason, /daily-cap/);

  state.state.spendLedger = [];
  config.dailySpendCap = original;
});

test('daily spend cap allows a buy that fits', () => {
  const original = config.dailySpendCap;
  config.dailySpendCap = 100;

  const state = require('../src/state');
  state.state.spendLedger = [[Date.now(), 15]];

  const d = evaluate(listing(10), { worth: 10000 });
  assert.strictEqual(d.buy, true);

  state.state.spendLedger = [];
  config.dailySpendCap = original;
});

test('spend ledger ignores entries older than 24h', () => {
  const state = require('../src/state');
  state.state.spendLedger = [
    [Date.now() - 90000000, 500],  
    [Date.now(), 10],
  ];
  assert.strictEqual(state.spentLast24h(), 10);
  state.state.spendLedger = [];
});

test('semaphore does not let newcomers jump queued waiters', async () => {
  const sem = new Semaphore(1);
  const order = [];

  await sem.acquire();                       

  const first = sem.acquire().then(() => order.push('first'));
  await new Promise((r) => setImmediate(r)); 
  const second = sem.acquire().then(() => order.push('second'));

  sem.release();
  await first;
  sem.release();
  await second;

  assert.deepStrictEqual(order, ['first', 'second'], 'FIFO order held');
});

test('semaphore caps concurrency', async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();
  assert.strictEqual(sem.inUse, 2);

  let third = false;
  sem.acquire().then(() => { third = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(third, false, 'third caller blocks at the cap');

  sem.release();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(third, true, 'released slot hands off');
});

test('evaluate filters by creator (Roblox only) when configured', () => {
  const originalRobloxOnly = config.buyRobloxOnly;
  config.buyRobloxOnly = true;

  
  const robloxItemById = { creatorTargetId: 1, creatorName: 'User1' };
  const d1 = evaluate(listing(10), { worth: 1000, item: robloxItemById });
  assert.strictEqual(d1.buy, true);

  
  const robloxItemByName = { creatorTargetId: 12345, creatorName: 'rObLoX' };
  const d2 = evaluate(listing(10), { worth: 1000, item: robloxItemByName });
  assert.strictEqual(d2.buy, true);

  
  const otherItem = { creatorTargetId: 99999, creatorName: 'OtherDev' };
  const d3 = evaluate(listing(10), { worth: 1000, item: otherItem });
  assert.strictEqual(d3.buy, false);
  assert.match(d3.reason, /non-roblox-creator/);

  
  const d4 = evaluate(listing(10), { worth: 1000, item: null });
  assert.strictEqual(d4.buy, false);
  assert.match(d4.reason, /no-item-metadata/);

  config.buyRobloxOnly = originalRobloxOnly;
});

test('evaluate filters by minimum worth when configured', () => {
  const originalMinWorth = config.buyMinWorth;
  config.buyMinWorth = 1000;

  
  const d1 = evaluate(listing(10), { worth: 1500 });
  assert.strictEqual(d1.buy, true);

  
  const d2 = evaluate(listing(10), { worth: 1000 });
  assert.strictEqual(d2.buy, true);

  
  const d3 = evaluate(listing(10), { worth: 500 });
  assert.strictEqual(d3.buy, false);
  assert.match(d3.reason, /worth-below-min/);

  config.buyMinWorth = originalMinWorth;
});
