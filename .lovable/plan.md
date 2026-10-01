# Whale audit: findings and proposed fix (nothing has been changed)

## Binance root cause (confirmed)
- **Code path:** `collectExchangeWhaleAlerts()` (`src/lib/pipeline.server.ts` lines 575–623) calls `binancePublicGet()` (lines 181–236). The live server gets 403 from both Binance hosts, so the 503/403 response is returned. Line 586, `if (!res.ok) return out;`, then returns an empty list with no log for that coin. Line 613, `if (rows.length === 0) return 0;`, means no upsert runs and no error is raised. The run still ends as `success`.
- **Proof from the data:** Out of 715 successful runs, only 4 ever stored Binance whales: 09-28 07:42, 10:13, 10:23 and 09-30 **03:44:37**. All 4 started at off-schedule times, so they were **manual runs from the preview**, not the 10-minute schedule. The 03:44 run stored 156 whales. Every scheduled run since then (03:50, 04:00, …) shows `whales=0`. The live server's logs show `403` on every Binance call.
- **Conclusion:** The scheduled live server's network region is blocked by Binance (a geo-block, not rate limiting). It is not deduplication, not thresholds, not lookback, and not a parsing bug. Binance data only ever arrived when someone pressed Run pipeline in the preview. Hyperliquid continues because it is not geo-blocked.
- **Smallest safe fix:** In `collectExchangeWhaleAlerts()`, when `!res.ok`, call Bybit `GET /v5/market/recent-trade?category=spot&symbol=XXXUSDT&limit=1000`. Use the same `whaleFloor`, `source: "bybit-recent-trades"`, `tx_hash = execId`, and `side` "Buy" = accumulation, "Sell" = distribution. Also add one `console.warn` per run with the number of coins that failed. Bybit klines already work from the live server, so this source is reachable.

## Verdict
`whales=0` comes from two causes. Neither is a crash or a deduplication bug.
1. **Binance fetch is failing (main cause).** The live server gets **HTTP 403** from both `api.binance.com` and `data-api.binance.vision` on every request. The logs show this on every run (e.g. 12:50 UTC: `ALL HOSTS FAILED ... 403`). The latest `binance-agg-trades` row is from **2026-09-30 03:44 UTC**, so nothing has arrived for about 33h. Indicators still show 281 because klines fall back to Bybit. aggTrades has **no fallback**, and `collectExchangeWhaleAlerts()` quietly returns `[]` on `!res.ok`. From the sandbox, the same Binance endpoint returns 200 and BTC trades above $50K, so the market does have qualifying trades. The block applies to the server's network region.
2. **Hyperliquid: few trades qualify, plus deduplication.** `recentTrades` returns only about 10 recent trades per coin. The largest BTC trade sampled was about $450, far below the $100K HL floor. A run inserts something only when a big trade happens in that small window. Recent runs with `whales=1` (11:10, 11:00, 07:50) match the rows that exist. Re-seen trades are skipped by `upsert(onConflict: source,tx_hash, ignoreDuplicates)`, and `.select("id")` returns only new rows. So `whales` counts **new inserts**, not trades seen.

## Exact thresholds
- `whaleFloor(coin)`: BTC/ETH/BNB $50K; SOL/XRP/ADA/DOGE $25K; TRX $20K; AVAX/DOT/LTC/BCH $15K; the $10K group (LINK, MATIC, ATOM, NEAR, APT, SUI, UNI, AAVE, MKR, ETC, XLM, ICP, FIL, RNDR); the $5K group (CRV, ARB, OP, INJ, TIA, SEI, RUNE, FTM, HBAR, ALGO, VET, SAND, MANA, AXS, GALA, IMX, GRT, SHIB, PEPE, ORDI); WIF/BONK/FLOKI/BOME/MEME $3K. Every other coin uses `DEFAULT_MIN_WHALE_USD` = $25K.
- Hyperliquid floor = `whaleFloor × 2` (`HL_FLOOR_MULTIPLIER`).
- Binance: last 1000 aggTrades per watchlist coin. For BTC that covers only about 90 seconds of trading. Direction: `m=true` means distribution.
- Hyperliquid: watchlist coins plus the top 25 coins by volume, using `recentTrades`.

## Lookback and use by composite signals
- `combineSignals()` and the variant/shadow path both read `whale_alerts` with `created_at >= now − WHALE_LOOKBACK_HOURS (6h)`. The main path keeps up to 2000 rows (largest first), the variant path up to 3000 (newest first), and both keep at most 20 per symbol. Direction is decided by a 1.15× buy-vs-sell USD ratio.
- **Old rows are not used beyond 6h.** The Binance rows from 09-30 have dropped out. Composite whale input currently comes only from the sparse Hyperliquid rows. That is why "whale ×1.2" factors still show up for some symbols.
- Cleanup deletes whale rows older than 7 days.

## Minor notes
- `whale_alerts` has two identical unique indexes on `(source, tx_hash)`. This is harmless but redundant.
- A 403 is logged only as a warning or error. The run still reports `success`, so the outage is invisible on the dashboard.

## Proposed fix (needs approval)
1. Add a fallback source for big trades when Binance returns 403, such as Bybit `/v5/market/recent-trade` or OKX trades, using the same floors. Store it under its own `source`.
2. Record a per-source whale status (ok, blocked, or 0 qualifying) on `pipeline_runs`, or log it, so a silent 403 shows up on the dashboard.
3. Optional: raise Hyperliquid coverage. Either lower `HL_FLOOR_MULTIPLIER` to 1, or poll more often and accept that `recentTrades` only covers a short window.
4. Optional: drop the duplicate unique index.
