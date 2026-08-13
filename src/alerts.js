'use strict';







const axios = require('axios');
const config = require('./config');
const log = require('./log');
const metrics = require('./metrics');
const { state, save } = require('./state');
const rl = require('./ratelimit');

const MAX_QUEUE = 100;
const MIN_GAP_MS = 400;

const queue = [];
let draining = false;
let dropped = 0;

function enqueue(payload) {
  if (!config.webhookUrl) return false;
  if (queue.length >= MAX_QUEUE) {
    dropped++;
    metrics.inc('webhook.dropped');
    return false;
  }
  queue.push(payload);
  drain();
  return true;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const payload = queue.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let url = config.webhookUrl;
          if (url) {
            try {
              const urlObj = new URL(url);
              urlObj.searchParams.set('with_components', 'true');
              url = urlObj.toString();
            } catch (e) {
              url += (url.includes('?') ? '&' : '?') + 'with_components=true';
            }
          }
          await axios.post(url, payload, { timeout: 6000 });
          metrics.inc('webhook.sent');
          break;
        } catch (err) {
          if (err?.response?.status === 429) {
            await rl.sleep(retryAfterMs(err.response));
            continue;
          }
          metrics.inc('webhook.failed');
          log.debug(`Webhook failed: ${err.message}`);
          break;
        }
      }
      await rl.sleep(MIN_GAP_MS);
    }
  } finally {
    draining = false;
  }
}


function retryAfterMs(res) {
  const raw = Number(res?.data?.retry_after);
  if (!Number.isFinite(raw) || raw <= 0) return 1000;
  const ms = raw < 100 ? raw * 1000 : raw;
  return Math.min(Math.max(ms, 500), 15000);
}

function thumbnail(assetId) {
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${assetId}&width=420&height=420&format=png`;
}

function itemUrl(assetId) {
  return `https://www.roblox.com/catalog/${assetId}`;
}

function sniped({ assetId, name, price, worth, protocol, elapsedMs, username }) {
  const profit = worth ? worth - price : null;
  const contentText =
    `**Price:** ${price}R$\n` +
    `**Worth:** ${worth ? `${worth.toLocaleString()}R$` : 'unknown'}\n` +
    `**Profit:** ${profit != null ? `+${profit.toLocaleString()}R$` : 'unknown'}\n` +
    `**Speed:** ${elapsedMs ? `${Math.round(elapsedMs)}ms` : 'n/a'}\n` +
    `**Protocol:** ${protocol}\n` +
    `**Account:** @${username}`;

  enqueue({
    flags: 32768,
    components: [{
      type: 17,
      accent_color: 0x22c55e,
      components: [
        {
          type: 10,
          content: `### 🎯 SNIPED — ${name}`
        },
        {
          type: 12,
          items: [{
            media: {
              url: thumbnail(assetId)
            }
          }]
        },
        {
          type: 10,
          content: contentText
        },
        {
          type: 1,
          components: [{
            type: 2,
            label: 'Open Roblox Catalog',
            style: 5,
            url: itemUrl(assetId)
          }]
        }
      ]
    }]
  });
}

function deal({ assetId, name, price, worth, discount, demandLabel, protocol }) {
  const buyable = price <= config.maxPrice
    ? 'Yes — within cap'
    : `No — over ${config.maxPrice}R$ cap`;

  const contentText =
    `**Price:** ${price}R$\n` +
    `**Worth:** ${worth.toLocaleString()}R$\n` +
    `**Gap:** ${(worth - price).toLocaleString()}R$\n` +
    `**Demand:** ${demandLabel || 'unknown'}\n` +
    `**Auto-buy:** ${buyable}\n` +
    `**Protocol:** ${protocol || 'n/a'}`;

  enqueue({
    flags: 32768,
    components: [{
      type: 17,
      accent_color: discount >= 70 ? 0xef4444 : 0xf59e0b,
      components: [
        {
          type: 10,
          content: `### 🚀 ${discount}% Off — ${name}`
        },
        {
          type: 12,
          items: [{
            media: {
              url: thumbnail(assetId)
            }
          }]
        },
        {
          type: 10,
          content: contentText
        },
        {
          type: 1,
          components: [{
            type: 2,
            label: 'Open Roblox Catalog',
            style: 5,
            url: itemUrl(assetId)
          }]
        }
      ]
    }]
  });
}

function notice(title, description, color = 0x3b82f6) {
  enqueue({
    flags: 32768,
    components: [{
      type: 17,
      accent_color: color,
      components: [
        {
          type: 10,
          content: `### ${title}\n${description}`
        }
      ]
    }]
  });
}



function maybeAlert({ assetId, name, price, worth, demandLabel, protocol }) {
  if (!config.alertEnabled) return false;
  if (!worth || worth < config.alertMinValue) return false;
  if (config.alertMaxPrice > 0 && price > config.alertMaxPrice) return false;
  if (state.alerted.has(assetId)) return false;

  const discount = Math.round((1 - price / worth) * 100);
  if (discount < config.alertDiscountPct) return false;

  state.alerted.set(assetId);
  state.totals.alerts++;
  save();
  metrics.inc('alerts.sent');

  log.deal(
    `${name} — ${price}R$ vs worth ${worth.toLocaleString()}R$ (${discount}% off)`,
    { assetId, price, worth, discount }
  );
  deal({ assetId, name, price, worth, discount, demandLabel, protocol });
  return true;
}

function stats() {
  return { queued: queue.length, dropped };
}

module.exports = { sniped, deal, notice, maybeAlert, enqueue, stats };
