'use strict';










const config = require('../src/config');
const log = require('../src/log');
const rl = require('../src/ratelimit');

const C = log.colors;
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

function head(title) {
  console.log(`\n${C.bold}${C.cyan}── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}${C.reset}`);
}

async function main() {
  console.log(`${C.bold}${C.cyan}\nROBLOX SNIPER — DIAGNOSTICS${C.reset}`);
  console.log(dim('read-only; nothing is purchased\n'));

  
  head('CONFIG');
  if (config.problems.length) {
    for (const p of config.problems) console.log(`  ${bad('✗')} ${p}`);
    console.log(`\n${bad('Fix config before continuing.')}`);
    process.exit(1);
  }
  console.log(`  ${ok('✓')} config valid`);
  console.log(`  ${dim(`${config.fallbacks.length} keys using defaults`)}`);
  console.log(`  mode: ${config.dryRun ? warn('DRY RUN') : bad('ARMED — will buy')}`);

  rl.register('catalog', config.rps.catalog);
  rl.register('economy', config.rps.economy);
  rl.register('marketplace', config.rps.marketplace);
  rl.register('rolimons', 0.5);
  rl.register('other', 5);

  const http = require('../src/http');
  const xsrf = require('../src/xsrf');
  const auth = require('../src/auth');
  const catalog = require('../src/catalog');
  const valuation = require('../src/valuation');
  const resellers = require('../src/resellers');

  
  head('CONNECTIVITY');
  const t0 = Date.now();
  await http.prewarm();
  console.log(`  ${ok('✓')} pools warm in ${Date.now() - t0}ms`);

  
  head('AUTH');
  await xsrf.refresh();
  if (!xsrf.current()) {
    console.log(`  ${bad('✗')} no XSRF token — cookie is probably dead`);
    process.exit(1);
  }
  console.log(`  ${ok('✓')} XSRF ${dim(xsrf.current().slice(0, 16) + '…')}`);

  let me;
  try {
    me = await auth.whoami();
    console.log(`  ${ok('✓')} logged in as ${C.bold}${me.displayName} (@${me.username})${C.reset} [${me.userId}]`);
  } catch (err) {
    console.log(`  ${bad('✗')} auth failed: ${err.message}`);
    process.exit(1);
  }

  const bal = await auth.balance({ force: true });
  const balMsg = `${bal}R$`;
  if (bal < config.maxPrice) {
    console.log(`  ${warn('!')} balance ${balMsg} — below MAX_PRICE ${config.maxPrice}R$, few buys possible`);
  } else {
    console.log(`  ${ok('✓')} balance ${balMsg}`);
  }

  
  head('VALUATION (Rolimons)');
  let valCount = 0;
  try {
    valCount = await valuation.refresh();
    console.log(`  ${ok('✓')} ${valCount} limiteds loaded`);
    const projected = [...valuation.items.values()].filter((i) => i.projected).length;
    console.log(`  ${dim(`${projected} flagged projected (will be skipped)`)}`);
  } catch (err) {
    console.log(`  ${warn('!')} Rolimons unavailable: ${err.message}`);
  }

  
  head('CATALOG SEARCH');
  const { items } = await catalog.search({ limit: 30 });
  console.log(`  ${ok('✓')} search returned ${items.length} items`);
  if (config.catalogCreator) {
    console.log(`  ${warn('!')} CATALOG_CREATOR="${config.catalogCreator}" is set — this EXCLUDES UGC limiteds`);
  } else {
    console.log(`  ${ok('✓')} no creator filter (correct for UGC limiteds)`);
  }

  const details = await catalog.batchDetails(items.map((i) => i.id).filter(Boolean));
  const collectible = details.filter((d) => d.protocol === 'collectible');
  const legacy = details.filter((d) => d.protocol === 'legacy');
  console.log(`  ${ok('✓')} resolved ${details.length} details in one batch`);
  console.log(`      protocol split: ${C.bold}${collectible.length} collectible${C.reset}, ${legacy.length} legacy`);

  
  head('PROTOCOL TEST — the reason v2 bought nothing');
  console.log(dim('  Picking tradeable limiteds and calling BOTH APIs on each.\n'));

  
  const probes = valuation
    .topCandidates(8, { budget: 500, minValue: 100 })
    .slice(0, 5);

  if (!probes.length) {
    console.log(`  ${warn('!')} no valuation data — skipping protocol test`);
  } else {
    const resolved = await catalog.resolveMany(probes.map((p) => p.assetId));
    let legacyWorked = 0;
    let collectibleWorked = 0;

    for (const item of resolved) {
      const label = `${String(item.assetId).padEnd(12)} ${(item.name || '').slice(0, 24).padEnd(26)}`;

      
      let collResult = 'n/a';
      if (item.collectibleItemId) {
        try {
          const listings = await resellers.fetch(item, { limit: 10 });
          collResult = `${listings.length} listings`;
          if (listings.length) {
            collectibleWorked++;
            const l = listings[0];
            collResult += ` (cheapest ${l.price}R$, productId ${String(l.collectibleProductId).slice(0, 8)}…)`;
          }
        } catch (err) {
          collResult = `ERR ${err.status || ''} ${err.message.slice(0, 40)}`;
        }
      }

      
      let legResult;
      try {
        const res = await http.get(
          `https://economy.roblox.com/v1/assets/${item.assetId}/resellers?limit=10&cursor=`
        );
        const n = res.data?.data?.length || 0;
        legResult = `${n} listings`;
        if (n) legacyWorked++;
      } catch (err) {
        legResult = `HTTP ${err.status} ${(err.body?.errors?.[0]?.message || '').slice(0, 30)}`;
      }

      console.log(`  ${label}`);
      console.log(`    modern (marketplace-sales): ${collResult.startsWith('ERR') || collResult === 'n/a' ? bad(collResult) : ok(collResult)}`);
      console.log(`    legacy (economy)          : ${legResult.includes('HTTP') ? bad(legResult) : ok(legResult)}`);
    }

    console.log('');
    console.log(`  ${C.bold}VERDICT${C.reset}`);
    console.log(`    modern API returned listings for ${collectibleWorked}/${resolved.length} items`);
    console.log(`    legacy API returned listings for ${legacyWorked}/${resolved.length} items`);
    if (collectibleWorked > legacyWorked) {
      console.log(`    ${ok('✓ Diagnosis confirmed:')} v2 used only the legacy path, which is why it never bought.`);
    } else if (legacyWorked > 0 && collectibleWorked === 0) {
      console.log(`    ${warn('! Unexpected:')} legacy works and modern does not. The API may have changed —`);
      console.log(`      check src/resellers.js against a live response before running armed.`);
    } else {
      console.log(`    ${warn('! Inconclusive:')} neither path returned listings. Try again when more items are on sale.`);
    }
  }

  
  head('RATE LIMIT BUDGET');
  const snap = rl.snapshotAll();
  for (const [name, b] of Object.entries(snap)) {
    const flag = b.throttled > 0 ? warn(`${b.throttled} throttled`) : ok('clean');
    console.log(`  ${name.padEnd(12)} rps=${String(b.rps).padEnd(6)} taken=${String(b.taken).padEnd(4)} ${flag}`);
  }

  head('SUMMARY');
  console.log(`  cookie      ${ok('alive')}`);
  console.log(`  balance     ${bal}R$`);
  console.log(`  valuations  ${valCount}`);
  console.log(`  protocol    ${collectible.length}/${details.length} collectible`);
  console.log(`\n  Next: ${C.bold}npm run dry${C.reset} — full pipeline, buys nothing\n`);

  await http.close();
  log.flushSync();
}

main().catch((err) => {
  console.error(`\n${bad('DIAGNOSTIC FAILED')}: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
