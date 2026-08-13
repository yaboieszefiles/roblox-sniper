'use strict';













const { Pool, ProxyAgent } = require('undici');
const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const rl = require('./ratelimit');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

const HOSTS = [
  'https://catalog.roblox.com',
  'https://economy.roblox.com',
  'https://apis.roblox.com',
  'https://users.roblox.com',
  'https://auth.roblox.com',
  'https://www.rolimons.com',
];

const pools = new Map();
const proxyAgents = new Map();
let proxyIdx = 0;
let activeProxies = [...config.proxies];

function setProxies(newProxies) {
  activeProxies = [...newProxies];
  const oldAgents = Array.from(proxyAgents.values());
  proxyAgents.clear();
  for (const agent of oldAgents) {
    agent.close().catch(() => {});
  }
}

function getProxyAgent(uri) {
  let agent = proxyAgents.get(uri);
  if (!agent) {
    agent = new ProxyAgent({ uri, ...poolOptions() });
    agent.proxyUri = uri;
    proxyAgents.set(uri, agent);
  }
  return agent;
}

function removeProxy(uri) {
  const idx = activeProxies.indexOf(uri);
  if (idx !== -1) {
    activeProxies.splice(idx, 1);
    log.warn(`Proxy ${uri} failed and was removed. Remaining proxies: ${activeProxies.length}`);
  }
  const agent = proxyAgents.get(uri);
  if (agent) {
    proxyAgents.delete(uri);
    agent.close().catch(() => {});
  }
}

function handleFailure(client, origin) {
  if (client && client.proxyUri) {
    removeProxy(client.proxyUri);
  } else {
    const p = pools.get(origin);
    if (p) {
      pools.delete(origin);
      p.close().catch(() => {});
    }
  }
}

function poolOptions() {
  return {
    connections: 8,
    pipelining: 1,      
    allowH2: true,
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 120000,
    headersTimeout: 8000,
    bodyTimeout: 8000,
    connect: { timeout: 6000 },
  };
}

function poolFor(origin) {
  if (activeProxies.length) {
    const uri = activeProxies[proxyIdx++ % activeProxies.length];
    return getProxyAgent(uri);
  }
  let p = pools.get(origin);
  if (!p) {
    p = new Pool(origin, poolOptions());
    pools.set(origin, p);
  }
  return p;
}

class HttpError extends Error {
  constructor(status, body, url, headers) {
    const apiMsg =
      body?.errors?.[0]?.message
      || body?.errorMessage
      || body?.message
      || (typeof body === 'string' ? body.slice(0, 200) : null);
    super(`HTTP ${status} ${url}${apiMsg ? ` — ${apiMsg}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.headers = headers || {};
    this.apiCode = body?.errors?.[0]?.code ?? null;
  }
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType && !contentType.includes('json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}




let xsrfProvider = null;
function setXsrfProvider(fn) {
  xsrfProvider = fn;
}

async function request(url, {
  method = 'GET',
  body = null,
  headers = {},
  priority = false,
  auth = true,
  xsrf = false,
  retries = 2,
  timeoutMs = 8000,
  label = null,
  
  
  
  preAuthorized = false,
} = {}) {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const bucket = rl.bucketFor(parsed);
  const metricName = label || `${parsed.hostname.split('.')[0]}.${method.toLowerCase()}`;

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    
    
    if (!preAuthorized || attempt > 0) {
      await bucket.acquire({ priority });
    }

    const reqHeaders = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...headers,
    };
    if (auth && config.cookie) {
      reqHeaders.cookie = `.ROBLOSECURITY=${config.cookie}`;
      reqHeaders.referer = 'https://www.roblox.com/';
      reqHeaders.origin = 'https://www.roblox.com';
    }
    if (xsrf && xsrfProvider) {
      const token = xsrfProvider();
      if (token) reqHeaders['x-csrf-token'] = token;
    }

    let payload;
    if (body !== null && body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      reqHeaders['content-type'] = 'application/json';
    }

    const client = poolFor(origin);
    const t0 = performance.now();
    try {
      const res = await client.request({
        path: parsed.pathname + parsed.search,
        method,
        headers: reqHeaders,
        body: payload,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const text = await res.body.text();
      const elapsed = performance.now() - t0;
      metrics.observe(metricName, elapsed);

      const parsedBody = parseBody(text, res.headers['content-type']);

      if (res.statusCode >= 200 && res.statusCode < 300) {
        bucket.reward();
        return { status: res.statusCode, headers: res.headers, data: parsedBody, elapsed };
      }

      const err = new HttpError(res.statusCode, parsedBody, url, res.headers);

      if (res.statusCode === 429 || res.statusCode === 503) {
        handleFailure(client, origin);
        bucket.penalize(rl.parseRetryAfter(res.headers));
        lastErr = err;
        if (attempt < retries) continue;
        throw err;
      }

      
      
      if (res.statusCode === 403 && res.headers['x-csrf-token']) {
        err.csrfToken = res.headers['x-csrf-token'];
      }

      
      if (res.statusCode >= 400 && res.statusCode < 500) {
        bucket.reward();
        throw err;
      }

      handleFailure(client, origin);
      lastErr = err;
      if (attempt < retries) {
        await rl.sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    } catch (err) {
      handleFailure(client, origin);
      if (err instanceof HttpError) throw err;

      
      metrics.observe(`${metricName}.error`, performance.now() - t0);
      metrics.inc(`http.neterr.${err.code || 'unknown'}`);
      lastErr = err;
      if (attempt < retries) {
        await rl.sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastErr || new Error(`request failed: ${url}`);
}



function backoffMs(attempt) {
  const base = 150 * Math.pow(2, attempt);
  return Math.floor(base / 2 + Math.random() * base);
}

const get = (url, opts) => request(url, { ...opts, method: 'GET' });
const post = (url, body, opts) => request(url, { ...opts, method: 'POST', body });



async function prewarm() {
  const results = await Promise.allSettled(
    HOSTS.map(async (origin) => {
      const t0 = performance.now();
      
      await poolFor(origin).request({ path: '/', method: 'HEAD', headers: { 'user-agent': USER_AGENT } });
      return { origin, ms: Math.round(performance.now() - t0) };
    })
  );

  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.length - ok.length;
  const detail = ok.map((r) => `${new URL(r.value.origin).hostname.split('.')[0]}=${r.value.ms}ms`).join(' ');
  log.info(`Connections pre-warmed: ${ok.length}/${results.length} ${detail}${failed ? ` (${failed} failed)` : ''}`);
}


function startKeepAlive(intervalMs = 20000) {
  const t = setInterval(() => {
    for (const origin of HOSTS) {
      poolFor(origin)
        .request({ path: '/', method: 'HEAD', headers: { 'user-agent': USER_AGENT } })
        .then((r) => r.body.dump())
        .catch(() => {});
    }
  }, intervalMs);
  t.unref();
  return t;
}

async function close() {
  await Promise.allSettled(Array.from(pools.values()).map((p) => p.close()));
  pools.clear();
}

module.exports = {
  request,
  get,
  post,
  prewarm,
  startKeepAlive,
  close,
  setXsrfProvider,
  HttpError,
  USER_AGENT,
  HOSTS,
  setProxies,
};
