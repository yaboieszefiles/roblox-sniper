'use strict';












const http = require('./http');
const log = require('./log');
const config = require('./config');
const rl = require('./ratelimit');

let token = null;
let inFlight = null;
let lastRefresh = 0;

function current() {
  return token;
}

function capture(headersOrErr) {
  const t =
    headersOrErr?.['x-csrf-token']
    || headersOrErr?.headers?.['x-csrf-token']
    || headersOrErr?.csrfToken;
  if (t && t !== token) {
    token = t;
    lastRefresh = Date.now();
    return true;
  }
  return Boolean(t);
}



async function fetchToken() {
  try {
    const res = await http.post(
      'https://auth.roblox.com/v1/authentication-ticket',
      {},
      { xsrf: true, retries: 1, priority: true, label: 'xsrf' }
    );
    if (capture(res.headers)) return true;
  } catch (err) {
    if (err.status === 403 && capture(err.headers)) return true;
    if (err.status === 401) {
      log.error('XSRF refresh got 401 — cookie is dead');
      throw err;
    }
    log.debug(`XSRF via authentication-ticket failed: ${err.message}`);
  }

  
  
  try {
    const res = await http.post(
      'https://economy.roblox.com/v1/purchases/products/0',
      {},
      { xsrf: true, retries: 1, priority: true, label: 'xsrf' }
    );
    if (capture(res.headers)) return true;
  } catch (err) {
    if (capture(err.headers)) return true;
    log.debug(`XSRF fallback failed: ${err.message}`);
  }

  return Boolean(token);
}

function refresh() {
  if (inFlight) return inFlight;
  inFlight = fetchToken()
    .catch((err) => {
      log.warn(`XSRF refresh failed: ${err.message}`);
      return Boolean(token);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function ensure() {
  if (token) return token;
  await refresh();
  return token;
}



async function loop(signal) {
  while (!signal?.aborted) {
    await rl.sleep(config.xsrfMs);
    if (signal?.aborted) break;
    await refresh();
  }
}

function ageMs() {
  return lastRefresh ? Date.now() - lastRefresh : null;
}



http.setXsrfProvider(current);

module.exports = { current, refresh, ensure, loop, capture, ageMs };
