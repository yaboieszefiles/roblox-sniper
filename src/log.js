'use strict';









const fs = require('fs');
const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const MAX_QUEUE = 5000;

const textQueue = [];
const jsonQueue = [];
let flushing = false;
let dropped = 0;

function enqueue(queue, line) {
  if (queue.length >= MAX_QUEUE) {
    dropped++;
    return;
  }
  queue.push(line);
}

function flush() {
  if (flushing) return;
  if (textQueue.length === 0 && jsonQueue.length === 0) return;
  flushing = true;

  const text = textQueue.splice(0, textQueue.length).join('');
  const json = jsonQueue.splice(0, jsonQueue.length).join('');

  let pending = 0;
  const done = () => {
    if (--pending > 0) return;
    flushing = false;
    if (textQueue.length || jsonQueue.length) flush();
  };

  if (text && config.logFile) {
    pending++;
    fs.appendFile(config.logFile, text, done);
  }
  if (json && config.jsonlFile) {
    pending++;
    fs.appendFile(config.jsonlFile, json, done);
  }
  if (pending === 0) flushing = false;
}


const timer = setInterval(flush, 1000);
timer.unref();

function stripAnsi(s) {
  
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function emit(level, tag, color, msg, fields) {
  if (LEVELS[level] < threshold) return;

  const ts = new Date().toISOString();
  const line = `${color}${tag}${C.reset} ${msg}`;
  console.log(line);

  enqueue(textQueue, `[${ts}] ${level.toUpperCase().padEnd(5)} ${tag.trim()} ${stripAnsi(msg)}\n`);

  if (config.jsonlFile) {
    const rec = { ts, level, ...(fields || {}) };
    if (!rec.msg) rec.msg = stripAnsi(msg);
    let encoded;
    try {
      encoded = JSON.stringify(rec);
    } catch {
      encoded = JSON.stringify({ ts, level, msg: stripAnsi(msg), note: 'fields not serializable' });
    }
    enqueue(jsonQueue, encoded + '\n');
  }

  flush();
}

const log = {
  debug: (m, f) => emit('debug', '[DEBUG]', C.dim, m, f),
  info: (m, f) => emit('info', '[INFO] ', C.cyan, m, f),
  warn: (m, f) => emit('warn', '[WARN] ', C.yellow, m, f),
  error: (m, f) => emit('error', '[ERROR]', C.red, m, f),

  
  found: (m, f) => emit('info', '[FOUND]', C.bold + C.yellow, m, { evt: 'found', ...f }),
  snipe: (m, f) => emit('info', '[SNIPE]', C.bold + C.green, m, { evt: 'snipe', ...f }),
  fail: (m, f) => emit('warn', '[FAIL] ', C.red, m, { evt: 'fail', ...f }),
  deal: (m, f) => emit('info', '[DEAL] ', C.bold + C.magenta, m, { evt: 'deal', ...f }),

  
  audit: (fields) => {
    if (!config.jsonlFile) return;
    enqueue(jsonQueue, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
  },

  droppedCount: () => dropped,

  
  flushSync() {
    try {
      if (textQueue.length && config.logFile) {
        fs.appendFileSync(config.logFile, textQueue.splice(0, textQueue.length).join(''));
      }
      if (jsonQueue.length && config.jsonlFile) {
        fs.appendFileSync(config.jsonlFile, jsonQueue.splice(0, jsonQueue.length).join(''));
      }
    } catch {
      
    }
  },

  colors: C,
};

module.exports = log;
