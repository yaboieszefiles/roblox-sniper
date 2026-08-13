'use strict';
















const log = require('./log');
const metrics = require('./metrics');

const MIN_RPS = 0.2;
const DECREASE_FACTOR = 0.5;
const PROBE_INTERVAL_MS = 3000;  








const INCREASE_FACTOR = 1.5;
const INCREASE_FLOOR = 0.3;      
const CEILING_RECOVERY_MS = 20000; 

class TokenBucket {
  constructor(name, rps, { burst = null, ceiling = null } = {}) {
    this.name = name;
    this.baseRps = rps;
    this.rps = rps;
    this.hardCeiling = ceiling ?? rps * 2;
    
    
    
    
    this.ceilingFloor = Math.max(MIN_RPS, rps * 0.35);
    
    
    
    
    
    
    
    this.ceiling = this.hardCeiling;
    this.capacity = burst ?? Math.max(1, Math.ceil(rps));
    this.tokens = this.capacity;
    this.last = Date.now();
    this.lastProbe = Date.now();
    this.waiters = [];
    this.draining = false;

    
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastThrottleAt = 0;

    this.stats = { taken: 0, waited: 0, throttled: 0, breaks: 0 };
  }

  refill(now = Date.now()) {
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rps);
    this.last = now;
  }

  get isOpen() {
    return Date.now() < this.openUntil;
  }

  
  
  acquire({ priority = false, timeoutMs = 30000 } = {}) {
    const now = Date.now();
    this.refill(now);

    
    
    
    
    
    
    if (this.isOpen && !priority) {
      const wait = this.openUntil - now;
      return sleep(wait).then(() => this.acquire({ priority, timeoutMs }));
    }

    if (this.tokens >= 1 && (this.waiters.length === 0 || priority)) {
      this.tokens -= 1;
      this.stats.taken++;
      return Promise.resolve();
    }

    this.stats.waited++;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, priority, expires: now + timeoutMs };
      if (priority) {
        
        const idx = this.waiters.findIndex((w) => !w.priority);
        if (idx === -1) this.waiters.push(waiter);
        else this.waiters.splice(idx, 0, waiter);
      } else {
        this.waiters.push(waiter);
      }
      this.drain();
    });
  }

  drain() {
    if (this.draining) return;
    this.draining = true;

    const step = () => {
      const now = Date.now();
      this.refill(now);

      
      while (this.waiters.length && this.waiters[0].expires < now) {
        const w = this.waiters.shift();
        w.reject(new RateLimitTimeout(`${this.name} bucket wait exceeded`));
      }

      while (this.waiters.length && this.tokens >= 1) {
        if (this.isOpen && !this.waiters[0].priority) break;
        this.tokens -= 1;
        this.stats.taken++;
        this.waiters.shift().resolve();
      }

      if (this.waiters.length === 0) {
        this.draining = false;
        return;
      }

      
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(5, Math.ceil((deficit / this.rps) * 1000) + 2);
      
      
      
      setTimeout(step, waitMs);
    };

    step();
  }

  
  penalize(retryAfterMs = 0) {
    this.stats.throttled++;
    this.consecutiveFailures++;
    metrics.inc(`ratelimit.${this.name}.throttled`);

    const before = this.rps;

    
    
    
    
    
    
    if (before > this.ceilingFloor) {
      this.ceiling = Math.max(this.ceilingFloor, Math.min(this.ceiling, before * 0.9));
    }

    this.rps = Math.max(MIN_RPS, this.rps * DECREASE_FACTOR);
    this.tokens = 0;
    this.lastProbe = Date.now();
    this.lastThrottleAt = Date.now();

    if (retryAfterMs > 0) {
      this.openUntil = Math.max(this.openUntil, Date.now() + retryAfterMs);
    }

    if (this.consecutiveFailures >= 5) {
      
      
      
      
      const breakMs = Math.min(8000, 1000 * this.consecutiveFailures);
      this.openUntil = Math.max(this.openUntil, Date.now() + breakMs);
      this.stats.breaks++;
      metrics.inc(`ratelimit.${this.name}.circuit_open`);
      
      if (this.consecutiveFailures === 5) {
        log.warn(
          `${this.name}: throttled — pausing ${(breakMs / 1000).toFixed(1)}s, `
            + `rps ${before.toFixed(2)} -> ${this.rps.toFixed(2)}`
        );
      }
    } else {
      log.debug(`${this.name}: rps ${before.toFixed(2)} -> ${this.rps.toFixed(2)}`);
    }
  }

  
  reward() {
    this.consecutiveFailures = 0;
    const now = Date.now();
    if (now - this.lastProbe < PROBE_INTERVAL_MS) return;
    this.lastProbe = now;

    
    
    
    
    
    if (this.ceiling < this.hardCeiling && now - this.lastThrottleAt > CEILING_RECOVERY_MS) {
      this.ceiling = Math.min(this.hardCeiling, this.ceiling * 1.15);
    }

    if (this.rps < this.ceiling) {
      const step = Math.max(INCREASE_FLOOR, this.rps * (INCREASE_FACTOR - 1));
      this.rps = Math.min(this.ceiling, this.rps + step);
      this.capacity = Math.max(1, Math.ceil(this.rps));
    }
  }

  snapshot() {
    return {
      rps: Number(this.rps.toFixed(2)),
      base: this.baseRps,
      tokens: Number(this.tokens.toFixed(2)),
      queued: this.waiters.length,
      open: this.isOpen,
      ...this.stats,
    };
  }
}

class RateLimitTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitTimeout';
  }
}

function sleep(ms) {
  
  
  
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}


const buckets = new Map();

function register(name, rps, opts) {
  const b = new TokenBucket(name, rps, opts);
  buckets.set(name, b);
  return b;
}

function bucket(name) {
  return buckets.get(name) || buckets.get('other');
}



function bucketFor(url) {
  try {
    const host = typeof url === 'string' ? new URL(url).hostname : url.hostname;
    if (host.includes('catalog')) return bucket('catalog');
    if (host.includes('economy')) return bucket('economy');
    if (host.includes('apis.roblox')) return bucket('marketplace');
    if (host.includes('rolimons')) return bucket('rolimons');
    return bucket('other');
  } catch {
    return bucket('other');
  }
}

function parseRetryAfter(headers) {
  const h = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!h) return 0;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.min(Math.max(n * 1000, 500), 60000);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 500), 60000);
  return 0;
}

function snapshotAll() {
  const out = {};
  for (const [name, b] of buckets) out[name] = b.snapshot();
  return out;
}

module.exports = {
  TokenBucket,
  RateLimitTimeout,
  register,
  bucket,
  bucketFor,
  parseRetryAfter,
  snapshotAll,
  buckets,
  sleep,
};
