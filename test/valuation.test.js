'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);

const { parseFeed, topCandidates, items } = require('../src/valuation');




const SAMPLE = {
  items: {
    1028606: ['Red Baseball Cap', '', 1426, -1, 1426, -1, -1, -1, -1, -1],
    21070012: ['Dominus Empyreus', 'domi', 110000000, 110000000, 110000000, 0, 2, -1, -1, 1],
    4771632715: ['Eggmunition', '', 284, 300, 284, 3, 2, 1, -1, -1],
    999: ['Broken', '', -1, -1, -1, -1, -1, -1, -1, -1],
  },
};

test('parseFeed maps the array layout to named fields', () => {
  const parsed = parseFeed(SAMPLE);
  const cap = parsed.get(1028606);
  assert.strictEqual(cap.name, 'Red Baseball Cap');
  assert.strictEqual(cap.rap, 1426);
  assert.strictEqual(cap.value, null, '-1 value becomes null');
  assert.strictEqual(cap.worth, 1426, 'worth falls back to rap');
});

test('parseFeed prefers community value over rap for worth', () => {
  const parsed = parseFeed(SAMPLE);
  const egg = parsed.get(4771632715);
  assert.strictEqual(egg.rap, 284);
  assert.strictEqual(egg.value, 300);
  assert.strictEqual(egg.worth, 300);
});

test('parseFeed decodes flags and labels', () => {
  const parsed = parseFeed(SAMPLE);
  const egg = parsed.get(4771632715);
  assert.strictEqual(egg.projected, true, 'projected flag is 1');
  assert.strictEqual(egg.demandLabel, 'High');

  const dom = parsed.get(21070012);
  assert.strictEqual(dom.projected, false, '-1 is not projected');
  assert.strictEqual(dom.rare, true);
  assert.strictEqual(dom.demandLabel, 'Terrible');
});

test('parseFeed keeps items with no data but zero worth', () => {
  const parsed = parseFeed(SAMPLE);
  assert.strictEqual(parsed.get(999).worth, 0);
});

test('parseFeed rejects malformed payloads', () => {
  assert.throws(() => parseFeed(null), /missing/);
  assert.throws(() => parseFeed({}), /missing/);
  assert.throws(() => parseFeed({ items: {} }), /zero items/);
});

test('topCandidates skips projected items', () => {
  items.clear();
  for (const [k, v] of parseFeed(SAMPLE)) items.set(k, v);

  const withProjected = topCandidates(10, { minValue: 0, skipProjected: false, budget: 20 });
  const without = topCandidates(10, { minValue: 0, skipProjected: true, budget: 20 });

  assert.ok(withProjected.some((i) => i.assetId === 4771632715), 'projected item present when allowed');
  assert.ok(!without.some((i) => i.assetId === 4771632715), 'projected item filtered out');
});

test('topCandidates ranks by reachability, not raw worth', () => {
  items.clear();
  for (const [k, v] of parseFeed(SAMPLE)) items.set(k, v);

  
  
  const ranked = topCandidates(5, { minValue: 0, skipProjected: true, budget: 22 });
  assert.strictEqual(ranked[0].assetId, 1028606, 'reachable item outranks the Dominus');
});

test('topCandidates respects minValue', () => {
  items.clear();
  for (const [k, v] of parseFeed(SAMPLE)) items.set(k, v);
  const ranked = topCandidates(10, { minValue: 2000, skipProjected: true, budget: 100 });
  assert.ok(ranked.every((i) => i.worth >= 2000));
});
