'use strict';






const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const SAVE_DEBOUNCE_MS = 400;

class TtlMap {
  constructor(ttl) {
    this.ttl = ttl;
    this.map = new Map();
  }

  set(key, at = Date.now()) {
    this.map.set(key, at);
  }

  has(key) {
    const at = this.map.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttl) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }

  prune(now = Date.now()) {
    let removed = 0;
    for (const [k, at] of this.map) {
      if (now - at > this.ttl) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  entries() {
    return Array.from(this.map.entries());
  }

  load(entries) {
    if (!Array.isArray(entries)) return;
    const now = Date.now();
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [k, at] = pair;
      if (typeof at !== 'number') continue;
      if (now - at > this.ttl) continue;
      this.map.set(k, at);
    }
  }
}

const state = {
  attempted: new TtlMap(config.attemptedTtl),
  skipped: new TtlMap(config.skipTtl),
  rejected: new TtlMap(config.rejectTtl),
  alerted: new TtlMap(config.alertTtl),

  totals: {
    sniped: 0,
    failed: 0,
    alerts: 0,
    spent: 0,
  },

  
  spendLedger: [],
};

function spentLast24h(now = Date.now()) {
  const cutoff = now - 86400000;
  let total = 0;
  for (const [ts, amount] of state.spendLedger) {
    if (ts >= cutoff) total += amount;
  }
  return total;
}

function recordSpend(robux, now = Date.now()) {
  state.spendLedger.push([now, robux]);
  state.totals.spent += robux;
  pruneLedger(now);
  save();
}

function pruneLedger(now = Date.now()) {
  const cutoff = now - 86400000;
  let i = 0;
  while (i < state.spendLedger.length && state.spendLedger[i][0] < cutoff) i++;
  if (i > 0) state.spendLedger.splice(0, i);
}


let saveTimer = null;
let saveInFlight = false;
let saveAgain = false;

function serialize() {
  return JSON.stringify({
    version: 3,
    attempted: state.attempted.entries(),
    rejected: state.rejected.entries(),
    alerted: state.alerted.entries(),
    totals: state.totals,
    spendLedger: state.spendLedger,
    ts: new Date().toISOString(),
  });
}

function writeAtomic(file, data, cb) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.open(tmp, 'w', (openErr, fd) => {
    if (openErr) return cb(openErr);
    fs.write(fd, data, (writeErr) => {
      if (writeErr) {
        fs.close(fd, () => fs.unlink(tmp, () => cb(writeErr)));
        return;
      }
      
      
      fs.fsync(fd, () => {
        fs.close(fd, (closeErr) => {
          if (closeErr) return fs.unlink(tmp, () => cb(closeErr));
          fs.rename(tmp, file, (renameErr) => {
            if (renameErr) return fs.unlink(tmp, () => cb(renameErr));
            cb(null);
          });
        });
      });
    });
  });
}

function doSave() {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  saveInFlight = true;
  const payload = serialize();
  writeAtomic(config.stateFile, payload, (err) => {
    saveInFlight = false;
    if (err) log.warn(`State save failed: ${err.message}`);
    if (saveAgain) {
      saveAgain = false;
      doSave();
    }
  });
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    doSave();
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

function saveSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const tmp = `${config.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, serialize());
    fs.renameSync(tmp, config.stateFile);
    return true;
  } catch (err) {
    log.warn(`Final state save failed: ${err.message}`);
    return false;
  }
}

function load() {
  try {
    if (!fs.existsSync(config.stateFile)) return false;
    const raw = fs.readFileSync(config.stateFile, 'utf8');
    if (!raw.trim()) return false;
    const data = JSON.parse(raw);

    state.attempted.load(data.attempted);
    state.rejected.load(data.rejected);
    state.alerted.load(data.alerted);

    
    const t = data.totals || {};
    state.totals.sniped = t.sniped ?? data.totalSniped ?? 0;
    state.totals.failed = t.failed ?? data.totalFailed ?? 0;
    state.totals.alerts = t.alerts ?? data.totalAlerts ?? 0;
    state.totals.spent = t.spent ?? 0;

    if (Array.isArray(data.spendLedger)) {
      state.spendLedger = data.spendLedger.filter(
        (e) => Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number'
      );
      pruneLedger();
    }

    log.info(
      `State restored — ${state.attempted.size} attempted, ${state.rejected.size} rejected, `
        + `${state.alerted.size} alerted, ${state.totals.sniped} sniped, `
        + `${spentLast24h()}R$ spent in last 24h`
    );
    return true;
  } catch (err) {
    
    
    log.warn(`State load failed (${err.message}) — starting fresh`);
    try {
      const bak = `${config.stateFile}.corrupt.${Date.now()}`;
      fs.renameSync(config.stateFile, bak);
      log.warn(`Corrupt state moved to ${path.basename(bak)}`);
    } catch {
      
    }
    return false;
  }
}

function pruneAll() {
  const removed =
    state.attempted.prune() + state.skipped.prune() + state.rejected.prune() + state.alerted.prune();
  pruneLedger();
  return removed;
}

module.exports = {
  state,
  TtlMap,
  save,
  saveSync,
  load,
  pruneAll,
  recordSpend,
  spentLast24h,
};
