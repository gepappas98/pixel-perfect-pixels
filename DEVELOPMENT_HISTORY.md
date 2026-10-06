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


## 2026-10-06 — P1.1 deep historical strategy-authority audit

### Evidence recovered
- The historical application pipeline had an explicit fetchStrategy() loader from public.strategy_config, cached for 60s, and combineSignals() passed those weights into the production ruleBased() scorer.
- Historical ruleBased() is materially richer than the currently deployed Edge scorer: it uses whale_weight, technicals_weight, prediction_weight, and council_weight; prediction contribution is magnitude-aware; technicals use the MTF score; council contribution uses a 0.75 base weight times conviction; asset-regime adjustments, hard-conflict handling, and hot-whale conviction boost are part of the historical scoring path.
- Historical scoring thresholds were buy=2.2, sell=-2.2, hold=0.5, with a bounded hot-whale sparse-symbol threshold override documented separately. The active Edge signal-combiner v7 instead hardcodes whale/technical contributions at 1.0, prediction at 0.5, council at conviction×1.5, confidence denominator 3, and thresholds ±1.5.
- Historical unit tests explicitly validate weight sensitivity: whale-focused can produce BUY from whale accumulation alone and chart-trader can produce BUY from aligned MTF alone. This proves the DB/preset weights were not merely UI metadata; they were intended to affect production scoring.
- The current strategy.functions.ts still implements manual persistence and auto-switching against strategy_config, so the auto-switch subsystem can change the DB configuration even though the active canonical Edge producer does not consume those weights.
- Current production DB was rechecked: chart-trader (0.5 / 2.0 / 0.5 / 0.5), auto-switch ON, interval 4h, last auto-switch 2026-10-02.

### Root cause
The architecture drifted into two strategy engines: the historical/server engine is DB-driven, while canonical signal-combiner v7 is a simplified hardcoded engine. Because the legacy runFullPipeline() writer is disabled, the DB-driven scorer is no longer the live producer. Therefore the current auto-adaptive strategy can update strategy_config without necessarily changing the actual canonical composite scoring.

### Best restoration path (decision, not implementation yet)
1. Keep public.strategy_config as the single source of truth for the active composite strategy weights.
2. Port the proven historical ruleBased() semantics into the canonical Edge signal-combiner, rather than inventing a new scoring model or simply copying the current simplified v7 constants.
3. Keep strategy_variant_signals presets isolated as benchmark/shadow arms; they should remain hardcoded preset definitions because they intentionally represent alternative strategies, not the active strategy.
4. Do not change the live DB weights, thresholds, or classifier during the stabilization window. The first implementation pass should be a shadow comparison: load strategy_config, compute the DB-driven historical score alongside the current score, persist diagnostics only, and verify parity/expected deltas on clean canonical inputs.
5. After the shadow comparison is verified, make the DB-driven scorer authoritative in one small canonical change, with explicit logging of the strategy snapshot/preset used for every composite signal. This makes auto-switch changes observable and reproducible.
6. Thresholds are a separate authority problem: they are not currently columns in strategy_config. Do not silently move the historical 2.2/-2.2/0.5 thresholds into the DB in the same change. First restore weight authority; then audit threshold authority as a separate P1 decision.

### Safety conclusion
This is a confirmed P1 wiring defect, not a request to optimize strategy performance. No production code, strategy weights, thresholds, classifier, or historical rows were changed in this audit.


## 2026-10-06 — P1.1 deep historical strategy-authority audit
- Historical canonical intent is now clear: the legacy/server pipeline was explicitly designed to load `strategy_config` via `fetchStrategy()` with a short cache, then pass those weights into the production `ruleBased()` scorer. The historical scorer applies whale, technicals, prediction and council weights and computes confidence from the same configured weights.
- Historical code also contains `compositeMaxScore()`, using the configured weights plus fixed source coefficients, confirming that strategy_config was intended to control both scoring and confidence normalization rather than merely drive the Strategy UI.
- Historical `combineSignals()` begins with `const weights = await fetchStrategy()`; therefore DB strategy configuration was a real production input in the old pipeline implementation.
- Canonical production architecture now bypasses that server pipeline. The active `signal-combiner` Edge Function v7 has a separate simplified `ruleBasedRecommendation()` with hardcoded source weights and hardcoded thresholds, while its observational variant presets are separately hardcoded. It never reads `strategy_config`.
- Canonical `trading-pipeline-orchestrator` v2 calls signal-combiner directly and has no auto-strategy stage. Therefore the existing server-side `maybeAutoSwitchStrategy()` is also not on the canonical scheduled execution path.
- This means the current DB preset (chart-trader: 0.5/2.0/0.5/0.5) can be changed by the application/auto-switch layer while the canonical composite producer continues using its own hardcoded scoring. The strategy panel and canonical signal producer can therefore disagree without an error.
- Best architectural solution identified: restore a single canonical strategy authority at the Edge pipeline boundary, not by reviving the legacy `runFullPipeline()`. The canonical signal-combiner should read `strategy_config` and use one shared scoring contract; auto-switch should either be ported deliberately into the canonical orchestrator/Edge path or remain explicitly disabled/non-authoritative until ported. Do not duplicate the legacy pipeline.
- Critical safety point: wiring `strategy_config` immediately changes production signal behavior because the current DB preset is chart-trader. Therefore the implementation should be a separate, explicitly verified change after capturing the current canonical scoring/output as the baseline. No production code or strategy values were changed in this audit.
- Status: P1.1 historical intent established; architecture decision ready; implementation intentionally not applied yet.


## 2026-10-06 — P1.1 live baseline captured before authority wiring
- Deployed Supabase signal-combiner is confirmed ACTIVE v7 and matches the GitHub canonical source.
- Current public.strategy_config: chart-trader, weights 0.5 / 2.0 / 0.5 / 0.5; auto-switch ON; 4h interval; last auto-switch 2026-10-02T04:40:13.577319Z.
- Recent canonical composite output still shows the hardcoded scorer in action. Example: a ZEC whale-accumulation-only signal was produced with confidence 0.3333 and recommendation WATCH. Under the configured chart-trader whale weight (0.5), the historical weight-driven scorer would materially differ, demonstrating that the DB configuration is currently not merely dormant metadata.
- No production code, strategy values, thresholds, or signal rows were modified during this baseline capture.
- Safe next implementation step: add a read-only strategy snapshot/shadow calculation to the canonical combiner, compare it against the current scorer, and persist diagnostics without changing the emitted composite recommendation. Only after parity/delta verification should authority be switched.


## 2026-10-06 — P1.1 shadow diagnostics deployed and made non-blocking
- Added read-only `strategy_config` shadow diagnostics to canonical `signal-combiner`; the first real canonical run at 15:20 UTC produced 11 diagnostic rows with preset `chart-trader` and weights 0.5 / 2.0 / 0.5 / 0.5.
- The 15:20 UTC canonical pipeline completed successfully (about 20.5s) with no pipeline error. Current vs configured-shadow values were persisted without changing the emitted composite recommendation. Examples: ZEC current score 1.0 / WATCH vs shadow score 0.5 / WATCH; ETH current -1.0 / WATCH vs shadow -0.5 / WATCH.
- Identified a safety issue in the initial shadow implementation: a diagnostics INSERT failure used to throw and could fail the canonical signal-combiner. This violated the requirement that diagnostics be non-invasive.
- Corrected the GitHub implementation so diagnostics INSERT errors are logged and do not abort composite signal generation. Commit: `57501e1e4e8038ef89713916db36bb42eca94773` (`fix: keep strategy shadow diagnostics non-blocking`).
- Deployed the corrected canonical `signal-combiner` as Supabase version 9, ACTIVE, preserving `verify_jwt=false` and the existing shared dependencies.
- The 15:20 UTC rows were generated by v8 before the non-blocking correction. Runtime verification of v9 must therefore come from the next canonical scheduled run; no ad-hoc function invocation is being claimed.
- Shadow calculation remains intentionally a safe authority-wiring diagnostic using the current Edge scoring contract plus DB weights; it is not yet claimed to be full historical `pipeline.server.ts` parity. Threshold authority and auto-switch authority remain separate P1 decisions.


## 2026-10-06 — Published UI still serving stale frontend build
- Live Lovable UI was rechecked after the backend scheduler and strategy authority work. The page still displays the old client state: Every 2 minutes, Pipeline Health STALE, historical timeout errors as current-looking state, and Strategy Weights Balanced 1.0/1.0/1.0/1.0 with auto-adaptive every 1h.
- Canonical production DB disagrees: `trading-pipeline-orchestrator` is active at `*/10 * * * *`; `get_pipeline_cron_health()` reports HEALTHY with last successful run at 15:20:21 UTC (20.5s); `strategy_config` is `chart-trader` with weights 0.5/2.0/0.5/0.5 and auto-switch interval 4h.
- The current Lovable source for both `CronHealthPanel.tsx` and `StrategyPanel.tsx` correctly reads the canonical server functions and is therefore not the source of the stale values. The mismatch is in the published frontend artifact/build being served at the public URL.
- A fresh Lovable production deployment was submitted: deployment id `8c01064a-4082-4948-8c73-ce7e245038da`. Status returned `pending`; completion has not been claimed.
- No backend scheduler, strategy values, signal logic, or database data was changed for this UI issue. Next verification is to refresh the published app after the deployment completes and confirm it shows 10-minute scheduling, HEALTHY status, and the live chart-trader configuration.
