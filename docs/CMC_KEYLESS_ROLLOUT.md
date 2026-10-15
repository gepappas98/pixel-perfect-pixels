# CMC Keyless rollout — Research Lab

## Scope and invariants

- No account, API key, or `X-CMC_PRO_API_KEY` header.
- Use only the documented public prefix `https://pro-api.coinmarketcap.com/public-api`.
- CMC data is context and discovery telemetry only. It must never create a BUY by itself.
- Existing Hyperliquid whale flow, Binance/Bybit candles, Council, composite thresholds, auto-switch, trade-executor and live-order settings are unchanged.
- No historical trades, signals, pipeline runs, or existing research rows are deleted or reset.
- CMC macro snapshots remain append-only. Ranked CMC listing snapshots retain seven days of history; after a complete successful listings batch is inserted, the sync function prunes only `cmc_listing_snapshots` rows older than seven days. If fetching/inserting a new batch fails, cleanup does not run. Cleanup failure is logged and reported without invalidating the successful new batch.
- CMC sync functions must require JWT verification and be called internally by the orchestrator using its server-side service token.
- Every CMC stage is optional. Errors must be logged and returned as HTTP 200 diagnostics to preserve fail-open orchestration.

## Phase 1 — Macro snapshot

Function: `supabase/functions/cmc-macro-sync/index.ts`

Endpoints:
1. `/v1/global-metrics/quotes/latest?convert=USD`
2. `/v3/fear-and-greed/latest`
3. `/v1/altcoin-season-index/latest`

The macro stage runs at most once per 25 minutes after a complete successful snapshot. Partial snapshots do not suppress the next retry. Each source has an independent status, HTTP status, latency and error field. Missing values stay null; they are never silently replaced with neutral/bullish values.

The market-cap delta is calculated against the prior valid market-cap observation only when that observation is no more than 24 hours old. The actual comparison window is persisted separately. `market_structure_tag` stays `unknown` if either dominance or alt-season is missing.

Table: `public.cmc_macro_snapshots`.

## Phase 1b — Ranked listings research cache

Function: `supabase/functions/cmc-listings-sync/index.ts`

Endpoint: `/v3/cryptocurrency/listings/latest?start={1,201,401,601,801}&limit=200&convert=USD`

- Each successful refresh requests up to 1,000 ranked assets in five sequential pages (or stops early if the provider returns a short page).
- This is broader than Top 200, but is **not a claim that every CMC asset is exposed by the keyless endpoint**. Actual returned coverage is recorded in function diagnostics.
- Successful snapshots are throttled to one every 6 hours.
- Stores bounded structured fields only; does not persist the complete raw response.
- A snapshot must contain at least 50 valid assets or it is rejected.
- Listings history is retained for seven days. Only after a complete valid batch is inserted, the function deletes rows in `cmc_listing_snapshots` older than the seven-day cutoff and reports `pruned_rows`; cleanup errors are logged/reported separately and do not turn the successful sync into a failure. This retention does not touch macro snapshots, watchlist snapshots, signals, trades, pipeline runs, or paper-trading history.
- During a dynamic watchlist refresh, CMC candidates with at least $5M 24h volume (or $3M for already-selected symbols) can join Hyperliquid candidates only when both Binance USDT Spot metadata and RevolutX's public EEA pair configuration confirm an active market for the base asset.
- CMC candidates fail closed if either venue's market metadata is unavailable/empty; CMC rank or volume never substitutes for venue tradability. Hyperliquid candidate eligibility and existing pinned/open-position behavior remain separate.
- The orchestrator awaits the optional listings sync before starting `whale-watch`, so a newly completed CMC batch is available to the same cycle's watchlist resolution. The call has a 50-second ceiling to cover up to five 8-second page requests; fail-open errors do not block the existing pipeline.
- `dynamic_watchlist_snapshots.cmc_snapshot_at` records the CMC batch consumed. A new batch (or first rollout with a historical batch) bypasses the cache once, then the existing 6-hour stability cache resumes.
- The active watchlist remains capped at 150 dynamic/core symbols plus existing open positions and pinned entries. CMC does not create BUY signals or change execution rules.
- Storage growth must be monitored before considering any explicit retention policy.

Table: `public.cmc_listing_snapshots`.

## Dashboard

`CmcMarketStructurePanel` reads the latest macro snapshot, latest Alternative.me global Fear & Greed snapshot, and the latest CMC ranked listings. It displays missing/partial data explicitly. A difference of 20 or more F&G points is a visual research divergence only, not an entry gate.

## Security

Both new functions have explicit `verify_jwt = true` in `supabase/config.toml`. The orchestrator sends the existing server-side service token for these internal calls. The public client receives SELECT only on the two snapshot tables; insert/update/delete permissions are revoked from `anon` and `authenticated`.

## Validation required before merge/deploy

1. Apply migrations to a non-production/dev database first.
2. Deploy both functions with JWT verification enabled.
3. Invoke each function via the authenticated orchestrator.
4. Confirm each endpoint's JSON shape and `status.error_code` handling in logs.
5. Confirm macro rows have plausible value ranges and per-source statuses.
6. Confirm V3 listings `quote` parsing handles the documented USD quote array (and the keyed-object fallback); verify price, volume, market cap and 24h change are populated rather than silently null.
7. Confirm listings snapshot has 50–1,000 rows (depending on provider paging/availability) and the top 5 shown in UI are from the same captured batch.
8. Simulate/observe HTTP 429, timeout, and one-endpoint partial failure; ensure the orchestrator still completes the existing critical stages.
9. Confirm no new CMC-derived values enter composite scoring, strategy auto-switch or trade-executor.
10. Confirm RLS: anon/authenticated SELECT works; writes are denied; service role can write.
11. Monitor pipeline runtime, database growth, and 429 frequency before any watchlist merge.
12. Confirm the listing sync reports `retention_days: 7`, a numeric `pruned_rows` count (or a separately reported cleanup error), and that only listing rows older than seven days are removed.

## Later phases — intentionally not included

- Entry-context persistence and post-mortem cohorts for CMC macro values.
- Broader CMC discovery beyond the first 1,000 ranked assets, only if the public keyless endpoints demonstrably expose it and request/storage budgets support it.
- Any soft sizing/confidence modifier. This requires observed telemetry and documented validation first.
