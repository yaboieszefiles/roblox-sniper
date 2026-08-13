'use strict';






const http = require('./http');
const log = require('./log');
const rl = require('./ratelimit');
const metrics = require('./metrics');

const BALANCE_TTL_MS = 30000;

const identity = {
  userId: null,
  username: 'unknown',
  displayName: null,
};

let robux = 0;
let balanceAt = 0;
let balanceInFlight = null;

async function whoami() {
  const res = await http.get('https://users.roblox.com/v1/users/authenticated', {
    priority: true,
    label: 'auth.whoami',
  });
  identity.userId = res.data?.id ?? null;
  identity.username = res.data?.name || 'unknown';
  identity.displayName = res.data?.displayName || identity.username;
  if (!identity.userId) throw new Error('authenticated endpoint returned no user id');
  return identity;
}

async function fetchBalance() {
  if (!identity.userId) await whoami();
  const res = await http.get(
    `https://economy.roblox.com/v1/users/${identity.userId}/currency`,
    { label: 'auth.balance' }
  );
  robux = Number(res.data?.robux) || 0;
  balanceAt = Date.now();
  return robux;
}


function balance({ force = false } = {}) {
  if (!force && Date.now() - balanceAt < BALANCE_TTL_MS) return Promise.resolve(robux);
  if (balanceInFlight) return balanceInFlight;
  balanceInFlight = fetchBalance()
    .catch((err) => {
      log.debug(`Balance fetch failed: ${err.message}`);
      return robux; 
    })
    .finally(() => {
      balanceInFlight = null;
    });
  return balanceInFlight;
}

function cachedBalance() {
  return robux;
}

function invalidateBalance() {
  balanceAt = 0;
}



function debit(amount) {
  robux = Math.max(0, robux - amount);
}



async function healthLoop(signal, onDead) {
  while (!signal?.aborted) {
    try {
      await http.get('https://users.roblox.com/v1/users/authenticated', { label: 'auth.health' });
      metrics.inc('auth.health.ok');
      await rl.sleep(300000);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        log.error(`Cookie is dead (HTTP ${err.status}) — refresh ROBLOSECURITY in .env`);
        metrics.inc('auth.health.dead');
        onDead?.(err);
        return;
      }
      log.warn(`Health check error: ${err.message}`);
      await rl.sleep(30000);
    }
  }
}

async function balanceLoop(signal) {
  while (!signal?.aborted) {
    await rl.sleep(120000);
    if (signal?.aborted) break;
    const before = robux;
    await balance({ force: true });
    if (robux !== before) {
      log.info(`Balance: ${robux}R$ (was ${before}R$)`);
    }
  }
}

module.exports = {
  identity,
  whoami,
  balance,
  cachedBalance,
  invalidateBalance,
  debit,
  healthLoop,
  balanceLoop,
};
