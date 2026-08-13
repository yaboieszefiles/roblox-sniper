# Roblox Limited Sniper v3
Dual-protocol limited sniper for the 2026 Roblox API. Supports the
**CollectibleItem system** (all modern UGC limiteds) and the legacy
economy endpoints.

## Why v3 exists
v2 ran for 4 hours and **bought 0**. It wasn't losing on speed — it wasn't
even competing. Four separate root causes, all verified against the live API:

**1. The legacy endpoints are dead.** Every limited has moved to the
CollectibleItem system. `economy/v1/assets/{id}/resellers` returns
`HTTP 410 "The asset id is invalid"`. Verified: 3/3 tradeable limiteds returned
listings on the modern API, 0/3 on legacy.

**2. `CATALOG_CREATOR=roblox` filters out the actual targets.** UGC
limiteds are created by *users*, not by Roblox. The filter excludes
100% of what we're looking for.

**3. Reactive rate limiting = 429 death spiral.** It only adjusts after
hitting a 429, then returns to the same speed and repeats. 60% of the log was
backoff warnings.

**4. 4 RTT per buy.** `search → details → resellers → purchase`. Competitors
with pre-resolved IDs are 1 RTT.

Across 340 sampled catalog items: **100% collectible protocol, 0% legacy.**

## Setup
```bash
npm install
cp .env.example .env # put your ROBLOSECURITY cookie here
```

## Usage
```bash
npm run diagnose # read-only: verifies cookie, balance, protocol split
npm run dry      # full pipeline, no purchases
npm start        # ARMED — buys
npm test         # 44 unit tests, no network
```
Start with `diagnose`, then run `dry` for 15 minutes, and only then `start`.

## Architecture
```
index.js          orchestrator, supervised lanes, graceful shutdown
src/
  config.js       env parse + validate, warns on unset keys
  log.js          leveled log + JSONL audit trail
  http.js         undici Pool, HTTP/2, pre-warmed connections
  ratelimit.js    adaptive token buckets (AIMD + ssthresh)
  xsrf.js         CSRF lifecycle, single-flight refresh
  auth.js         identity, balance, cookie-death detection
  valuation.js    Rolimons bulk feed (2514 limiteds per refresh)
  catalog.js      search + batch details + protocol routing
  resellers.js    DUAL PROTOCOL listing fetch
  purchase.js     DUAL PROTOCOL buy + idempotency + spend guard
  watchlist.js    fast lane — pre-resolved IDs
  discovery.js    wide lane — catalog sweep
  engine.js       scoring, decision, execution
  alerts.js       Discord webhooks
  metrics.js      counters + latency percentiles
  state.js        atomic persistence
tools/diagnose.js live protocol verification
legacy/           the old v2, no longer used
```

## Two lanes
**Watchlist (speed).** Sweeps prices of high-value items using
catalog batch details — 120 asset ids per request. Only when a price looks
buyable does it call the resellers endpoint and purchase.

**Discovery (coverage).** Sweeps the catalog for new listings that
are not on the watchlist. Slower per item; different job.

## Why the watchlist is not per-item polling
The original design continuously polled `resellers` for each item.
Live measurement killed that idea: the endpoint 429'd **even at 0.22
rps** — one request every 4.5 seconds. Far too slow to be a normal rate limit,
so it has a separate per-account quota.

The replacement is better. `catalog/items/details` accepts 120
asset ids per POST and returns `lowestResalePrice` for all of them:

| Design              | Requests per sweep | Time   |
|---------------------|-------------------:|-------:|
| Per-item resellers  | 234                | ~10 min|
| Batch details       | 2                  | ~3.3s  |

Measured in a dry run: 234 items, 54 sweeps in 181 seconds, **0 WARN lines**.
v2 had 1020 WARN vs 674 INFO — 60% of the log was backoff warnings.

## The purchase flow
```
GET  apis.roblox.com/marketplace-sales/v1/item/{collectibleItemId}/resellers
POST apis.roblox.com/marketplace-sales/v1/item/{collectibleItemId}/purchase-item
     { collectibleItemId, collectibleProductId, expectedPrice, expectedCurrency: 1,
       expectedPurchaserId, expectedPurchaserType: "User",
       expectedSellerId, expectedSellerType: "User", idempotencyKey: uuid4() }
```
`collectibleProductId` is **per-listing**, not per-item — it must be carried
from the resellers response into the purchase body. It cannot be cached
one-per-item.

The `idempotencyKey` is generated once per attempt and reused on
retries — this prevents double-buys on timeout.

## Rate limiting
Measured, not guessed. Calibration against the live marketplace endpoint:
```
clean up to: 4 rps
first 429:   6 rps (22 within 6s)
p50 latency: 303ms
```
Each bucket has a token bucket that adapts like TCP congestion
control: 429 → halves the rate **and lowers the ceiling** (ssthresh), so
it never returns to a rate that is already known to fail.

Three distinct bugs were caught here in dry runs, and each has a regression test:

1. **Fixed ceiling** — oscillated between 7 rps and 0.2 rps, 23 × 429 in
   two minutes.
2. **Ratchet with no floor** — the fix for #1 caused the ceiling to drop on
   every 429, including ones that arrived while already slow.
   Stuck at 0.2 rps forever.
3. **Priority bypass** — the watchlist passed `priority: true`, and
   priority skipped the circuit breaker. The highest-volume
   caller was exempt from the mechanism meant to protect it. Priority is now
   reserved for purchase only.

## Watchlist sizing
Cheap now. Prices come from batch details (120 ids per
request), so a 240-item watchlist is 2 requests per sweep, not 240.
Default is 240.

## Safety
- `DRY_RUN=true` — full pipeline, no purchases
- `DAILY_SPEND_CAP` — hard ceiling per 24h, atomic in state
- `MIN_PROFIT_PCT` — rejects thin margins
- `SKIP_PROJECTED` — skips the 125 Rolimons-flagged projected items
- `expectedPrice` — server-side guard against price changes during purchase

## Warning
Automated purchasing with a `.ROBLOSECURITY` cookie violates the Roblox
Terms of Use and risks account termination. The
`marketplace-sales` endpoints are undocumented and change without notice — if the bot
stops buying, run `npm run diagnose` to check whether the API has changed.
```
"# roblox-sniper" 
