# Trading Command Center — Development History

## Purpose
This file is the durable chronological record of P0/P1 investigations, restorations, fixes, and verification. Rule: inspect current canonical behavior + recover historical intent before changing code. Prefer restoration/improvement over rebuilding working logic.

## 2026-10-06 — Canonical scheduler control restored
- Identified mismatch between UI schedule control and the canonical trading-pipeline-orchestrator cron.
- Restored public.set_pipeline_schedule(_minutes) to operate on the canonical orchestrator.
- Supported intervals: 0, 2, 5, 10 minutes.
- Canonical production schedule verified at */10 * * * *.
- Durable migration: supabase/migrations/20261006180000_canonical_pipeline_schedule_control.sql.
- Commit: 8cb1f012d3664ab7fbaa6ccaadf08439ff95372b.

## 2026-10-06 — Pipeline health / orchestrator verification
- Canonical orchestrator stages verified: whale-watch, tradingview-signals, polymarket-check, council-sync, signal-combiner, variant-resolver, trade-executor.
- Abandoned running safety valve retained at 20 minutes; no change made to healthy execution behavior.
- Recent production verification: 12 completed runs, 0 errors, 0 running; average duration about 22.98s over the checked 2-hour window.

## 2026-10-06 — Dynamic watchlist restored
Historical design recovered from GitHub:
- Hyperliquid full-universe discovery by 24h notional volume.
- Binance USDT/TRADING listing filter.
- Hysteresis: $5M add / $3M remove.
- 6-hour snapshot stability.
- Core pinned: BTC/ETH/SOL.
- Open-position pinning.
- RevolutX-discovered symbols retained as pinned candidates when Binance-listed.
- Maximum universe: 150 symbols.
- Historical provenance and hot-whale expansion logic preserved as reference.

Canonical whale-watch restored to this dynamic model and deployed as v6.
Production snapshot after verification: 39 symbols; 234 HL candidates; 35 above HL threshold; 28 Binance-filtered; 20 pinned; 19 dynamic.
No qualifying >=$100k whale alert was found in the verification window; treated as a data condition, not an execution error.

GitHub sync commit: f1ce006700b58eee9a5ddd3a327a3c7ba255fda5.

## 2026-10-06 — Composite SELL / Spot-long-only review
- Observed bearish SELL composite signals while execution is Binance Spot long-only.
- Decision: do not delete or alter them yet.
- Future direction: separate signal intelligence from execution intent and preserve bearish context for risk/exit/reversal logic.
- Status: deferred; no implementation change made.

## 2026-10-06 — P0.2 input freshness investigation
- Pipeline execution itself is healthy.
- Prediction and council inputs were observed stale in the UI snapshot (older than the 30-minute freshness guard).
- Decision: do not weaken freshness guards and do not modify the signal combiner merely to restore signal counts.
- Next investigation: inspect polymarket-check and council-sync, compare current canonical implementation with historical implementation, and identify why fresh data is not being persisted.

## Working rules
1. One P0/P1 item at a time.
2. No changes to already-working behavior without evidence.
3. Preserve historical implementation intent and provenance.
4. Verify every production change with a targeted query or invocation.
5. Record every meaningful investigation, change, commit, and verification result here.
6. Vercel is not the target; canonical Supabase + GitHub/Lovable path is authoritative.


## 2026-10-06 — P1.1 strategy_config authority audit
- Audit only; no production code or DB values changed.
- public.strategy_config currently has chart-trader = whale 0.5 / technicals 2.0 / prediction 0.5 / council 0.5; auto-switch enabled; interval 4h; last auto-switch 2026-10-02.
- Repo server strategy loader (src/lib/pipeline.server.ts) reads strategy_config, and strategy.functions.ts owns manual/auto-switch persistence.
- Canonical deployed signal-combiner v7 does not read strategy_config for production composite scoring. Its production ruleBasedRecommendation() uses fixed 1-point whale/technicals, 0.5 prediction, and council conviction x1.5, with hard thresholds buy >=1.5 / sell <=-1.5; its separate variant presets are also hardcoded in the Edge Function.
- Therefore strategy_config is authoritative for the application/server strategy layer and auto-switch persistence, but not authoritative for the canonical Edge composite producer used by the orchestrator.
- This is a genuine P1 architecture/source-of-truth mismatch, not a reason to change weights immediately.
- Safety decision: do not modify strategy_config, thresholds, or signal scoring during this audit. Next step is to inspect historical canonical intent and decide the smallest restoration path so the DB strategy config becomes authoritative without changing current behavior accidentally.
