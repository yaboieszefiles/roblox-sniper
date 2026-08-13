'use strict';
// Read-only dry run for the deal scanner: samples the catalog and reports how
// many listings would trip the discount threshold. Buys nothing, sends nothing.
//   node test_alert.js          -> uses ALERT_DISCOUNT_PCT (default 60)
//   node test_alert.js 45       -> tries a 45% threshold instead

const axios = require('axios');
require('dotenv').config();

const COOKIE = (process.env.ROBLOSECURITY || '').trim();

const client = axios.create({
  timeout: 10000,
  headers: {
    Cookie: `.ROBLOSECURITY=${COOKIE}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: 'https://www.roblox.com/',
  },
});

async function getXsrf() {
  try {
    await client.post('https://auth.roblox.com/v2/logout', {});
  } catch (e) {
    const t = e?.response?.headers?.['x-csrf-token'];
    if (t) return t;
  }
  return null;
}

(async () => {
  const xsrf = await getXsrf();
  console.log('XSRF:', xsrf ? xsrf.slice(0, 12) + '...' : 'FAILED');
  if (!xsrf) process.exit(1);

  const THRESHOLD =
    Number(process.argv[2]) || Number(process.env.ALERT_DISCOUNT_PCT) || 60;
  const MIN_AVG = Number(process.env.ALERT_MIN_AVG) || 50;
  console.log(`Threshold: >=${THRESHOLD}% off RAP, min RAP ${MIN_AVG}R$`);
  let cursor = '';
  let scanned = 0;
  let rapOk = 0;
  let noRap = 0;
  const hits = [];

  for (let page = 0; page < 4; page++) {
    const search = await client.get(
      'https://catalog.roblox.com/v1/search/items'
        + '?taxonomy=tZsUsd2BqGViQrJ9Vs3Wah&CreatorName=roblox'
        + '&limit=30&salesTypeFilter=2&sortType=4'
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    );
    const ids = (search.data?.data || []).map((i) => i.id).filter(Boolean);
    cursor = search.data?.nextPageCursor || '';
    if (!ids.length) break;

    const det = await client.post(
      'https://catalog.roblox.com/v1/catalog/items/details',
      { items: ids.map((id) => ({ id: Number(id), itemType: 'Asset' })) },
      { headers: { 'X-CSRF-TOKEN': xsrf } }
    );
    const details = det.data?.data || [];

    for (const d of details) {
      const lowest = d.lowestResalePrice ?? d.lowestPrice;
      if (lowest == null || lowest <= 0 || d.hasResellers === false) continue;
      scanned++;
      let rap = 0;
      try {
        const r = await client.get(
          `https://economy.roblox.com/v1/assets/${d.id}/resale-data`
        );
        rap = Number(r.data?.recentAveragePrice) || 0;
      } catch (e) {
        noRap++;
        continue;
      }
      if (rap < MIN_AVG) {
        noRap++;
        continue;
      }
      rapOk++;
      const disc = Math.round((1 - lowest / rap) * 100);
      if (disc >= THRESHOLD) {
        hits.push({ name: d.name, id: d.id, lowest, rap, disc });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!cursor) break;
  }

  console.log(
    `\nScanned ${scanned} listings | usable RAP: ${rapOk} | no/low RAP: ${noRap}`
  );
  console.log(`Deals >=${THRESHOLD}% off: ${hits.length}`);
  for (const h of hits) {
    console.log(
      `  ${String(h.name).slice(0, 30).padEnd(32)} ${h.lowest}R$ vs RAP ${h.rap}R$ = ${h.disc}% off`
    );
  }
})().catch((e) => {
  console.error('ERR', e?.response?.status, e.message);
  process.exit(1);
});
