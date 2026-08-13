'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);

const tmpState = path.join(os.tmpdir(), `sniper_test_state_${process.pid}.json`);
process.env.STATE_FILE = tmpState;
process.env.LOG_FILE = path.join(os.tmpdir(), `sniper_test_${process.pid}.log`);
process.env.JSONL_FILE = '';

const { TtlMap, state, saveSync, load, spentLast24h } = require('../src/state');

test('TtlMap expires entries past their ttl', () => {
  const m = new TtlMap(1000);
  m.set('fresh');
  m.set('old', Date.now() - 5000);

  assert.strictEqual(m.has('fresh'), true);
  assert.strictEqual(m.has('old'), false, 'expired entry reads as absent');
  assert.strictEqual(m.size, 1, 'expired entry is dropped on read');
});

test('TtlMap.prune removes all stale entries', () => {
  const m = new TtlMap(1000);
  m.set('a', Date.now() - 5000);
  m.set('b', Date.now() - 5000);
  m.set('c');
  assert.strictEqual(m.prune(), 2);
  assert.strictEqual(m.size, 1);
});

test('TtlMap.load skips entries already expired', () => {
  const m = new TtlMap(1000);
  m.load([['fresh', Date.now()], ['stale', Date.now() - 99999], ['bad'], null]);
  assert.strictEqual(m.size, 1);
  assert.strictEqual(m.has('fresh'), true);
});

test('state round-trips through an atomic save', () => {
  state.attempted.set(12345);
  state.rejected.set(67890);
  state.alerted.set(11111);
  state.totals.sniped = 3;
  state.totals.failed = 2;
  state.totals.alerts = 7;
  state.spendLedger = [[Date.now(), 42]];

  assert.strictEqual(saveSync(), true);
  assert.ok(fs.existsSync(tmpState), 'state file written');

  
  state.attempted.map.clear();
  state.rejected.map.clear();
  state.alerted.map.clear();
  state.totals.sniped = 0;
  state.spendLedger = [];

  assert.strictEqual(load(), true);
  assert.strictEqual(state.attempted.has(12345), true);
  assert.strictEqual(state.rejected.has(67890), true);
  assert.strictEqual(state.totals.sniped, 3);
  assert.strictEqual(state.totals.alerts, 7);
  assert.strictEqual(spentLast24h(), 42);
});

test('save leaves no temp file behind', () => {
  saveSync();
  const dir = path.dirname(tmpState);
  const leftovers = fs.readdirSync(dir).filter(
    (f) => f.startsWith(path.basename(tmpState)) && f.endsWith('.tmp')
  );
  assert.deepStrictEqual(leftovers, [], 'temp files are renamed, not left');
});

test('corrupt state file is quarantined rather than fatal', () => {
  fs.writeFileSync(tmpState, '{ this is not json');
  assert.strictEqual(load(), false, 'load reports failure but does not throw');

  const dir = path.dirname(tmpState);
  const quarantined = fs.readdirSync(dir).filter(
    (f) => f.startsWith(path.basename(tmpState)) && f.includes('.corrupt.')
  );
  assert.ok(quarantined.length > 0, 'corrupt file preserved for inspection');
  for (const f of quarantined) fs.unlinkSync(path.join(dir, f));
});

test('v2 state files still load', () => {
  fs.writeFileSync(tmpState, JSON.stringify({
    attempted: [],
    rejected: [],
    alerted: [[153563580, Date.now()]],
    totalSniped: 5,
    totalFailed: 1,
    totalAlerts: 18,
    ts: new Date().toISOString(),
  }));

  state.totals.sniped = 0;
  state.totals.alerts = 0;
  assert.strictEqual(load(), true);
  assert.strictEqual(state.totals.sniped, 5, 'flat v2 key migrated');
  assert.strictEqual(state.totals.alerts, 18);
  assert.strictEqual(state.alerted.has(153563580), true);
});

test.after(() => {
  for (const f of [tmpState, process.env.LOG_FILE]) {
    try { fs.unlinkSync(f); } catch {}
  }
});
