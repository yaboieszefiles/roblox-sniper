'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.ROBLOSECURITY = process.env.ROBLOSECURITY || 'x'.repeat(100);

const { TokenBucket, parseRetryAfter } = require('../src/ratelimit');

test('token bucket allows a burst up to capacity', async () => {
  const b = new TokenBucket('t', 10, { burst: 3 });
  const t0 = Date.now();
  await b.acquire();
  await b.acquire();
  await b.acquire();
  assert.ok(Date.now() - t0 < 50, 'burst should not block');
});

test('token bucket paces beyond capacity', async () => {
  const b = new TokenBucket('t', 20, { burst: 1 });
  await b.acquire();
  const t0 = Date.now();
  await b.acquire();
  const elapsed = Date.now() - t0;
  
  assert.ok(elapsed >= 30, `expected pacing, waited ${elapsed}ms`);
});

test('penalize halves the rate and reward restores it gradually', () => {
  const b = new TokenBucket('t', 8, { ceiling: 8 });
  b.penalize();
  assert.strictEqual(b.rps, 4, 'multiplicative decrease');
  b.penalize();
  assert.strictEqual(b.rps, 2);

  
  b.lastProbe = Date.now() - 10000;
  b.reward();
  assert.ok(b.rps > 2 && b.rps <= 8, `additive increase, got ${b.rps}`);
});

test('rate never drops below the floor', () => {
  const b = new TokenBucket('t', 1);
  for (let i = 0; i < 30; i++) b.penalize();
  assert.ok(b.rps >= 0.2, `floor held, got ${b.rps}`);
});

test('throttling lowers the ceiling so recovery cannot re-trip it', () => {
  
  
  
  
  const b = new TokenBucket('t', 3.5);
  assert.strictEqual(b.ceiling, 7, 'starts at the hard ceiling');

  b.penalize();
  assert.ok(b.ceiling < 3.5, `ceiling drops below the failed rate, got ${b.ceiling}`);
  const ceilingAfter = b.ceiling;

  
  for (let i = 0; i < 40; i++) {
    b.lastProbe = 0;
    b.reward();
  }
  assert.ok(b.rps <= ceilingAfter + 0.001, `rate capped at ${ceilingAfter}, got ${b.rps}`);
  assert.ok(b.rps < 7, 'never returns to the original ceiling while throttling is recent');
});

test('ceiling relaxes after a long clean streak', () => {
  const b = new TokenBucket('t', 4);
  b.penalize();
  const lowered = b.ceiling;
  assert.ok(lowered < 4);

  
  b.lastThrottleAt = Date.now() - 120000;
  for (let i = 0; i < 20; i++) {
    b.lastProbe = 0;
    b.reward();
  }
  assert.ok(b.ceiling > lowered, `ceiling recovers over time, ${lowered} -> ${b.ceiling}`);
  assert.ok(b.ceiling <= b.hardCeiling, 'never exceeds the configured hard ceiling');
});

test('a throttle while already crawling does not strand the bucket', () => {
  
  
  
  
  
  const b = new TokenBucket('t', 3.5);
  for (let i = 0; i < 15; i++) b.penalize();

  assert.ok(b.ceiling >= b.ceilingFloor, `ceiling respects its floor, got ${b.ceiling}`);
  assert.ok(b.ceiling > 0.2, 'ceiling never collapses to the rate floor');

  
  b.lastThrottleAt = Date.now() - 120000;
  for (let i = 0; i < 30; i++) {
    b.lastProbe = 0;
    b.reward();
  }
  assert.ok(b.rps > 1, `recovers to a usable rate, got ${b.rps}`);
});

test('circuit opens after sustained failures', () => {
  const b = new TokenBucket('t', 5);
  for (let i = 0; i < 5; i++) b.penalize();
  assert.ok(b.isOpen, 'circuit should be open after 5 consecutive failures');
  assert.ok(b.stats.breaks >= 1);
});

test('reward clears the failure streak', () => {
  const b = new TokenBucket('t', 5);
  b.penalize();
  b.penalize();
  assert.strictEqual(b.consecutiveFailures, 2);
  b.reward();
  assert.strictEqual(b.consecutiveFailures, 0);
});

test('priority waiters are served before queued normal ones', async () => {
  const b = new TokenBucket('t', 4, { burst: 1 });
  await b.acquire();               

  const order = [];
  const normal = b.acquire().then(() => order.push('normal'));
  
  await new Promise((r) => setImmediate(r));
  const prio = b.acquire({ priority: true }).then(() => order.push('priority'));

  await Promise.all([normal, prio]);
  assert.deepStrictEqual(order, ['priority', 'normal']);
});

test('an open circuit gates normal callers but not the purchase lane', async () => {
  
  
  
  
  
  const b = new TokenBucket('t', 4);
  for (let i = 0; i < 5; i++) b.penalize();
  assert.ok(b.isOpen, 'circuit is open');

  b.tokens = 10;   

  let normalResolved = false;
  b.acquire({ priority: false }).then(() => { normalResolved = true; });
  let priorityResolved = false;
  b.acquire({ priority: true }).then(() => { priorityResolved = true; });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(priorityResolved, true, 'purchase lane passes through');
  assert.strictEqual(normalResolved, false, 'normal callers wait for the circuit');
});

test('parseRetryAfter handles seconds, dates and junk', () => {
  assert.strictEqual(parseRetryAfter({ 'retry-after': '5' }), 5000);
  assert.strictEqual(parseRetryAfter({ 'retry-after': '0.2' }), 500); 
  assert.strictEqual(parseRetryAfter({}), 0);
  assert.strictEqual(parseRetryAfter({ 'retry-after': 'nonsense' }), 0);
  const future = new Date(Date.now() + 10000).toUTCString();
  const ms = parseRetryAfter({ 'retry-after': future });
  assert.ok(ms > 5000 && ms <= 11000, `date form, got ${ms}`);
});
