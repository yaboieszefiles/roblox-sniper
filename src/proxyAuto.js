'use strict';

const { ProxyAgent } = require('undici');
const log = require('./log');
const metrics = require('./metrics');

const SOURCES = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'
];

async function fetchFreeProxies() {
  const list = [];
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const text = await res.text();
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const clean = line.trim();
        if (clean && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(clean)) {
          list.push(clean);
        }
      }
    } catch (err) {
      log.debug(`Failed to fetch proxies from ${url}: ${err.message}`);
    }
  }
  return Array.from(new Set(list));
}

async function isProxyWorking(proxy, timeoutMs = 3000) {
  try {
    const agent = new ProxyAgent({ uri: `http://${proxy}`, connect: { timeout: timeoutMs } });
    const res = await fetch('https://users.roblox.com/v1/users/1', {
      dispatcher: agent,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json && json.id === 1 && json.name === 'Roblox';
  } catch {
    return false;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function findWorkingProxies(limit = 10) {
  log.info('Fetching free proxy list from online sources...');
  const candidates = shuffle(await fetchFreeProxies());
  log.info(`Found ${candidates.length} proxy candidates. Testing them against Roblox...`);

  const working = [];
  const batchSize = 50;

  for (let i = 0; i < candidates.length && working.length < limit; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (proxy) => {
        const ok = await isProxyWorking(proxy);
        return { proxy, ok };
      })
    );

    for (const res of results) {
      if (res.ok) {
        working.push(`http://${res.proxy}`);
        if (working.length >= limit) break;
      }
    }
  }

  log.info(`Successfully found ${working.length} working proxies.`);
  return working;
}

async function loop(signal) {
  const config = require('./config');
  if (!config.autoProxies) return;
  while (!signal?.aborted) {
    await new Promise((r) => setTimeout(r, config.autoProxiesRefreshMs));
    if (signal?.aborted) break;
    try {
      const found = await findWorkingProxies(config.autoProxiesLimit);
      if (found.length > 0) {
        require('./http').setProxies(found);
      }
    } catch (err) {
      log.warn(`Auto-proxy refresh failed: ${err.message}`);
    }
  }
}

module.exports = { findWorkingProxies, loop };
