# Trading Command Center — P0/P1 Stabilization Tracker

Last updated: 2026-10-08 UTC — canonical observability pass

## Operating rule

**Do not lose old issues while fixing new ones.** Every change must be recorded here as:
- DONE = fixed and verified
- DEPLOYED / VERIFY = code is changed but production behavior still needs confirmation
- OPEN = known issue not yet fixed
- DEFERRED = intentionally postponed

Hard constraints:
1. Do not reset/delete historical data.
2. Do not change strategy weights, thresholds, classifier, EMA50/ADX, R:R, or production strategy while stabilization is incomplete.
3. Do not create a second pipeline implementation.
4. Canonical production DB is `yckewtpfttvwiptmmrfq`.
5. Legacy DB `gbbrmzstuhdizfvabjvz` is frozen; its history is retained.
6. Paper mode / risk safety remains the priority.

---

## P0 — Data plane / source of truth

### P0.1 Canonical DB unification — DONE / RUNTIME VERIFIED
- Canonical DB: `yckewtpfttvwiptmmrfq`.
- Legacy DB: `gbbrmzstuhdizfvabjvz`.
- Legacy cron writers were frozen.
- Legacy historical data was migrated without reset.
- `data_plane_unification_audit` records the migration/freeze.
- Repo env/config was switched to canonical.
- Migration: `20261006090500_unify_council_source_id_text.sql`.
- Commit: `2df8d7a121981a6030000849c094676a5598e687`.
- Runtime verification 2026-10-08: canonical `trading-pipeline-orchestrator` is writing current `pipeline_runs`; latest observed run `b95945c7-01c5-44e6-8e44-5e3b74439eab` completed successfully at 15:24:21 UTC. Dashboard visual alignment remains a publish/visual verification item.

### P0.2 Freshness / mapping — DONE / RUNTIME VERIFIED (2026-10-08)
- Prediction selection made directional, volume-aware and probability-bounded.
- Council freshness now uses actual AI/input timestamps.
- Panel uses `source_created_at`.
- Commits: `e77c0d0`, `650d3ee`, `b306a51`.
- Clean canonical cycle verified 2026-10-08: latest prediction snapshot `2026-10-08T15:24:12.974Z` and latest council `source_created_at=2026-10-08T15:24:10.520Z` were produced within the same successful canonical run window. Freshness gates remain intact; no stale promotion observed in this cycle.
- Do not retune strategy until additional clean observations are collected.

---

## P0.3 Pipeline execution / health — IN PROGRESS

### Fixed
- False stale/100% health was traced to orphan run:
  `a11b5583-615f-4bd3-ae8c-ba21b01da695`.
- That stale run was reconciled to `error`.
- Recent canonical history showed real runs completing in roughly 20–25s.
- Old executor could fail the stage with HTTP 500; safer paper Spot Long-only executor v2 was deployed.
- Executor v2: paper-only, BUY-only, max 3 open positions, $1,000 notional, SL 3%, TP 6%, duplicate protection, per-signal error isolation.
- Manual **Run pipeline** was found to call the wrong legacy `runFullPipeline()`.
- Manual trigger was corrected to invoke canonical Edge Function `trading-pipeline-orchestrator`.
- Commit: `12a11bd6b0b63d0d3d232019786ab9b2a141ac5e`.
- Production deployment was initiated after this change.

### OPEN — next immediate work
1. **Manual UI error handling — DONE / CODE VERIFIED.** `src/lib/pipeline.functions.ts` now reads the orchestrator response body when Supabase returns a non-2xx error and preserves actionable details such as `skipped=true`, reason/message and `run_id`.
2. A direct canonical manual diagnostic invocation was verified successfully: run `b7d5e64d-a2cf-41c6-87ea-1478e0816add`, 21.1s, status `completed`, all six canonical stages completed, no executor HTTP 500.
3. A subsequent scheduled canonical run also completed successfully: run `3a86421e-559d-4e15-b467-9995b3b9092a`, 20.3s.
4. The orchestrator's concurrency guard can legitimately return HTTP 409 with `skipped=true` when another run is active; the current UI collapses this into the generic non-2xx message. This must be made explicit in the manual-trigger handler.
5. **Runtime verified:** canonical scheduler continues to produce successful 10-minute runs; latest observed run completed in ~20.3s with all stages HTTP 200.
6. Continue monitoring manual + cron overlap; no duplicate run pattern observed in the latest scheduled sequence.

### Scheduler path — CANONICALIZED / VERIFY PUBLISH
The current canonical pg_cron state was re-checked:
- active job: `trading-pipeline-orchestrator`, schedule `*/10 * * * *`
- inactive legacy job: `trading-pipeline-every-15-min`
- `pipeline_settings.id=1` currently has `interval_minutes=10`
- the dashboard offers 2/5/10-minute choices, but the canonical DB scheduler is still at 10 minutes.

The application route `/api/public/cron` was disabled in commit `c32d591550375f974ee412ff881134d59f6c87f1` with HTTP 410. The legacy `runFullPipeline()` writer is therefore no longer reachable through that route. Remaining verification is deployment/published-route confirmation.

Target architecture:
**Manual + Auto → canonical `trading-pipeline-orchestrator` → one canonical `pipeline_runs` source of truth.**

The user has decided that the current 10-minute canonical schedule can remain temporarily. The 2-minute UI selection and scheduler/source mismatch are deferred, because interval length is not currently creating a material operational problem. Revisit later; do not lose the issue.

---

## P0.4 Shadow / variant outcome resolver — OPEN / VERIFY

Previously identified resolver correctness issue:
- Lower timeframe sequence must be 5m, then 15m.
- If a lower-timeframe candle touches both TP and SL, outcome must immediately be `ambiguous`; never continue to a later candle.
- Ambiguous outcomes must not enter the performance-resolved denominator.
- Do not mass-update historical outcomes.
- Historical WIN/LOSS corrections, if needed, must be targeted only.

Previously verified:
- Resolver starvation fixed/verified.
- Per-symbol candle lookup fixed/verified.
- BUY/SELL TP/SL direction fixed/verified.
- Shadow rows reach the resolver.

Status: the ambiguity logic itself is already correct in the legacy/server implementation: ambiguous 1h candles are inspected 5m first, then 15m; a lower-timeframe candle touching both TP and SL immediately returns `ambiguous`, and `ambiguous` has no PnL/exit price.

**Canonical-path finding (updated 2026-10-08):** the canonical `signal-combiner` now produces fresh `strategy_variant_signals` BUY benchmark rows through idempotent `source_fingerprint` upserts. The latest observed fresh row was created at `2026-10-08T15:12:17.060Z`. We therefore must NOT mass-resolve the legacy sample.

A production `variant-resolver` Edge Function is deployed with a hard historical cutoff (`2026-10-06T09:57:00Z`) and is a canonical stage after signal-combiner. Runtime verification 2026-10-08: `fresh_72h_due=0`; `legacy_72h_excluded=342`. This confirms the safety boundary. P0.4 remains OPEN only for the first fresh 72h resolution/forensic candle verification.

Next: wire the variant producer into the canonical path (without mass historical re-resolution), then validate fresh outcomes and the 5m→15m ambiguity rule.

Next sequence:
**correct resolver → collect valid observations → compare `production_regime_label` vs `shadow_regime` vs actual outcome → only then consider strategy/classifier changes.**

---

## P1 — Known items not to forget

### P1.1 Strategy configuration wiring — DONE / RUNTIME VERIFIED (2026-10-06)
- Commit `11f97930911b6709075bdbd4e0e40eea5f133dca` wires the canonical production scorer to `strategy_config`.
- Runtime verification on canonical DB `yckewtpfttvwiptmmrfq` confirms the active row is `chart-trader`: whale 0.5 / technicals 2.0 / prediction 0.5 / council 0.5; auto-switch enabled, 4h interval.
- Fresh composite rows are using those weights. Example at 20:30 UTC: ETH = whale distribution (-0.50) + prediction leaning yes (+0.25) = -0.25, confidence 0.071428..., recommendation HOLD. This matches the configured production scorer contract.
- 30-minute runtime evidence: 11 fresh composite rows and 30 strategy-shadow diagnostics; no scorer/runtime error observed.
- No thresholds, classifier, EMA50/ADX, R:R, or historical data were changed.
- Strategy tuning remains deferred; this closes the wiring defect only.

### P1.2 Cron / pipeline source-of-truth mismatch
- Canonical cron previously observed at 10 minutes.
- User has now selected 2 minutes.
- UI, `pipeline_settings`, pg_cron job and actual Edge Function target must all agree.
- No legacy `trading-pipeline-auto` writer may remain active once canonical scheduler is wired.

### P1.3 Security — RUNTIME VERIFIED / NO ACTION REQUIRED
- `dynamic_watchlist_snapshots` has RLS enabled.
- Explicit public-read policy exists for `anon` and `authenticated`; no public write policy is present.
- Canonical security advisors currently report only the four intentionally retained SECURITY DEFINER read RPC warnings (`get_pipeline_cron_health`, `get_portfolio_summary`, `get_system_resource_stats`, `get_variant_performance`).
- No blind RLS change is required at this stage.

### P1.4 Observability — IN PROGRESS / CODE IMPROVED
Need one coherent health model showing:
- latest canonical run
- duration
- status
- last success
- next scheduled run
- consecutive failures
- stage-level failures
- manual vs scheduled trigger source

**Implemented in this pass:**
- Canonical get_pipeline_cron_health() now exposes trigger and source from the orchestrator's persisted pipeline_runs.result metadata for both the latest run and last successful run.
- nextRunAt is now anchored to the latest scheduled run when available, so a manual dashboard run cannot shift the displayed next scheduler time.
- CronHealthPanel now displays trigger/source metadata for the current and last successful run.
- Runtime verification immediately after the DB change returned RUNNING, interval 2 minutes, latest source pg_cron, trigger scheduled, last success at 15:30:27.820Z, next run 15:34:00Z.
- This is observability only: no pipeline stages, strategy weights, thresholds, risk limits, or historical data were changed.
- Remaining: publish/verify the frontend artifact and later add stage-level failure detail if the current UI does not already surface it.

### P1.5 Execution audit
After pipeline stability:
- confirm paper BUY rows only
- confirm no new legacy SELL rows
- confirm duplicate protection
- confirm open-position/risk caps
- confirm SL/TP close logic
- confirm portfolio RPC/reporting

---

## Deferred — DO NOT TOUCH YET

- Strategy weights / presets
- Confidence threshold
- Market-regime classifier
- EMA50 / ADX logic
- R:R changes
- Production strategy logic
- Historical mass re-resolution
- Performance optimization based on the current small/possibly contaminated sample

Reason: stabilization and clean data collection come first.

---

## Current execution order

**NOW**
1. **P0.4 — Fresh canonical variant observation:** producer is active; latest fresh variant observed 2026-10-08 15:12 UTC. Wait for first fresh 72h due row, then verify resolver trigger + Binance candle outcome.
2. Verify manual Run Pipeline UI diagnostics and the disabled `/api/public/cron` route in the published frontend.
3. Verify Dashboard / Shadow / DB alignment on the same canonical run.
4. Verify executor/risk behavior and resolver 5m→15m ambiguity on a fresh resolved row.
5. Then complete P1.4 observability cleanup.

**THEN**
6. Verify canonical Dashboard/Shadow/DB alignment.
7. Security/RLS audit.
8. Observability cleanup.

**ONLY AFTER CLEAN DATA**
9. Complete regime × outcome and signal-independence analysis on the clean sample.
10. Consider strategy/classifier changes based on evidence.

---

## Change discipline

Before every new fix:
1. Read this tracker.
2. Mark the target issue.
3. Make one coherent change.
4. Verify the change.
5. Record commit/deployment and remaining verification.
6. Only then move to the next issue.

**Never declare the project "fixed" while an earlier P0 remains OPEN/VERIFY.**


## 2026-10-08 — Canonical Dashboard / Shadow / DB alignment audit

- Canonical runtime verified against pipeline_runs, composite_signals, prediction_snapshots, council_signals, and strategy_variant_signals.
- Latest scheduled run observed: completed canonical trading-pipeline-orchestrator, source pg_cron, 2026-10-08 16:00:00–16:00:26 UTC.
- Same fresh window contains current composite signals, fresh prediction snapshots, fresh council signals, and fresh canonical shadow variants; no trade was created because execution correctly had no available BUY slot / no eligible BUY in that execution window.
- get_variant_performance(7) is still the canonical long-only benchmark RPC: resolved historical outcomes plus current open canonical observations. SELL variants remain excluded from performance.
- DB benchmark settings verified: TP +4%, SL −3%, expiry 72h.
- UI semantic mismatch found and corrected: VariantComparisonPanel previously called the benchmark “Legacy Variant Performance” even though its open rows now include current canonical observations. Commit: 9b2e4cacbc136996de0066278f7676b4f5e77517.
- No strategy/risk/execution logic or historical data changed. Frontend publish verification remains required.

## 2026-10-07 — Whale Radar Council telemetry deployment

- Whale Radar telemetry was still showing **0 runtime events** while `council_decisions` remained stale (latest observed 2026-08-28).
- Root cause candidate was confirmed in the browser persistence path: `saveCouncilRuntimeEvent()` used the legacy runtime-localStorage-overridable Supabase client, while the Council itself used the canonical generated client.
- Canonical telemetry fix is commit `56d331709366804167ba593a8711af034cf110d3`: telemetry inserts now use `@/integrations/supabase/client`, matching the Council/agent path.
- Current Whale Radar Lovable source is at that commit and was re-published successfully on 2026-10-07; published app remains `crypto-whale-watch-nexus.lovable.app`.
- Production DB verification immediately before this deployment: `council_decisions=5`, latest decision `2026-08-28 10:47:59 UTC`; `council_runtime_events=0`.
- **VERIFY NEXT:** one fresh published-app scan must produce at least `SCAN_COMPLETED` and `CANDIDATES_FOUND` telemetry; then confirm `COUNCIL_TRIGGERED` and either `COUNCIL_PERSISTED`, `COUNCIL_SKIPPED`, or `COUNCIL_FAILED`.
- Do not relax Council freshness, create synthetic decisions, or alter TCC thresholds while this upstream verification is pending.

## 2026-10-06 — Market Regime + duplicate pipeline finding

### P0.3 / Observability
- **System Resources Pipeline source-of-truth fix committed:** `bf245317ac6130042b45c6855e3c78480b88fbf6`.
- `getSystemResourceMetrics()` now reads pipeline status/duration from canonical `get_pipeline_cron_health()` instead of independently scanning `pipeline_runs`.
- This removes the contradiction that produced the false `3440.3s · running` display while canonical runs were completing in ~20–25s.
- Lovable production deployment was published with latest commit `bf245317ac6130042b45c6855e3c78480b88fbf6`.

### P0.4 / Variant data integrity
- A concrete **second-pipeline writer** was confirmed: `/api/public/cron` was still invoking legacy `runFullPipeline()`.
- This was not merely a 2/5/10-minute scheduling mismatch: the legacy application pipeline could create duplicate/contaminated variant observations alongside the canonical orchestrator.
- The legacy application cron route is now disabled with HTTP 410 and an explicit canonical-owner message. Commit: `31f0e1880e42ddbaf18eb02b467d77554eb65f46`.
- No historical variant rows were deleted or mass-modified.
- Six variant rows created around 10:03 UTC have `source_fingerprint` populated but `production_regime_label/regime_label` NULL; these pre-date signal-combiner v6 deployment (~10:04 UTC) and are **not part of the clean regime-labeled observation sample**. Keep them untouched; exclude them from clean strategy analysis until explicitly handled.
- Canonical signal-combiner v6 successfully completed at 10:05 UTC and subsequent canonical runs completed; no new NULL-regime variant rows have appeared since the v6 deployment window.
- The canonical resolver remains protected by the historical cutoff; do not mass-resolve old rows.

### Market Regime panel
- `MarketRegimePanel` was traced to `getMarketRegime()`.
- Hardened `market-regime.functions.ts` with bounded whale/council reads and a fail-safe diagnostic fallback so an unexpected calculation exception cannot surface as a blank panel. Commit: `1a9578b169780d9618b6c8bcdf8e7ce2c6ea4fcb`.
- This is a UI/observability hardening change only; it does **not** alter production strategy weights, thresholds, classifier, EMA50/ADX, or R:R.
- Lovable project latest commit after deployment: `bf245317ac6130042b45c6855e3c78480b88fbf6`.

### Current verification rule
- From this point forward, a variant is considered part of the **clean new sample** only if it is produced by canonical `signal-combiner`, has a non-null regime label, has a non-null source fingerprint, and is created after the v6 canonical producer deployment window.
- Continue observation before any strategy tuning.

## 2026-10-06 — Legacy → Canonical improvement audit

| Legacy mechanism | Finding | Action |
|---|---|---|
| Hot-whale queue | Discovers large-flow symbols outside the 6h watchlist; batch aggregation, TTL and sample-size guard | **PORT CANDIDATE** — only if canonical producer lacks equivalent |
| Hard-conflict gate | Whale vs prediction conflict with neutral MTF becomes semantic HOLD | **PORT CANDIDATE** — safety/quality gate; no threshold tuning |
| Binance → data-api → Bybit candle fallback | Improves resilience when a market endpoint is unavailable | **PORT CANDIDATE** — infrastructure resilience only |
| Bounded concurrency (`pMap`) | Prevents one feed / symbol from serially extending the pipeline | **KEEP / VERIFY** — canonical must have equivalent bounded fan-out |
| Fail-open feed isolation | Individual whale/feed failures do not abort the entire cycle | **KEEP / VERIFY** |
| 5m → 15m variant ambiguity resolver | Same candle touching TP and SL becomes `ambiguous` immediately; excluded from resolved denominator | **KEEP CANONICAL** — already represented by the canonical resolver safety design; verify with fresh rows |
| Market-session classification | Adds session context and peak/off-hours metadata | **PORT METADATA ONLY** — session score modifier remains disabled/shadow-only |
| CORE_ALWAYS_INCLUDE (BTC/ETH/SOL) | Prevents dynamic watchlist churn from dropping core majors | **KEEP / VERIFY** |
| Watchlist provenance / snapshots | Provides reproducibility of why a symbol entered the cycle | **KEEP / VERIFY** |
| Cleanup feature flags + error serialization | Safe staged rollout and consistent diagnostics | **KEEP / VERIFY** |
| Legacy shadow performance SQL | Historical performance aggregation and long-only filtering | **REUSE LOGIC, NOT WRITER** — no second producer |

### Important architectural rule

The legacy `runFullPipeline()` remains **disabled**. We are extracting useful algorithms and safeguards, not reactivating the legacy execution path.

No historical `strategy_variant_signals` rows will be rewritten as part of this audit.

### Current blocker

The canonical Lovable agent could not be asked to apply this improvement pass because the connected Lovable workspace currently reports **out of credits**. Therefore **no unverified canonical code change is being claimed** from this audit.

The next implementation pass must inspect the canonical orchestrator first and port only features that are genuinely absent. This prevents duplicate implementations and avoids accidentally changing production strategy logic.

### Required verification after implementation

For each ported feature:
1. prove the canonical path owns it;
2. prove the legacy writer remains disabled;
3. run typecheck/build/tests;
4. execute at least one canonical cycle;
5. compare canonical output with the relevant legacy algorithm on the same inputs;
6. only then mark the feature DONE.

**Do not deploy strategy changes merely because a legacy feature looks attractive. Stabilization and clean observations remain the priority.**

## 2026-10-06 — Legacy → Canonical audit VERIFIED against current main

The canonical source was inspected directly before any porting change. The previously listed legacy mechanisms are already represented in the current canonical implementation, so **no duplicate port was applied**:

- Hot-whale queue: canonical pipeline uses `recordHotWhale()`, `getHotWhaleBatch()` and hot-whale tags.
- Hard-conflict gate: canonical `detectHardConflict()` is called by the signal combiner.
- Candle resilience: canonical Binance hosts include `api.binance.com` and `data-api.binance.vision`, with Bybit kline fallback.
- Bounded concurrency: canonical `pMap()` is used for feed/symbol fan-out.
- Feed isolation: individual source/symbol failures are caught and recorded without aborting the cycle.
- Variant ambiguity: canonical resolver checks 5m then 15m and returns `ambiguous` when one lower-timeframe candle touches both TP and SL.
- Market session: canonical signals persist `market_session`; the session score modifier remains gated by configuration and was not enabled.
- Core majors: `CORE_ALWAYS_INCLUDE = [BTC, ETH, SOL]` is already enforced by the watchlist resolver.
- Provenance: canonical watchlist context and `tagsFor()` preserve symbol origin/tags.
- Error serialization: canonical pipeline and market-regime paths use `serializeError()`.
- Variant performance: canonical pipeline writes variant rows itself; legacy `runFullPipeline()` remains disabled.

**Safety decision:** No production strategy logic was changed in this pass, no historical `strategy_variant_signals` rows were rewritten, and no second writer/pipeline was introduced.

**Result:** the Legacy → Canonical improvement pass requires **no additional code port at this point**. The next work is verification of these existing safeguards in live canonical cycles, not reimplementation.

This supersedes the previous `PORT CANDIDATE` wording for the mechanisms proven above.


## 2026-10-06 — Manual trigger diagnostics improved

- **P0.3 manual UI error handling:** code fix committed in `efc65a6b99dff453ad75164077c7c4f86b5509b5`.
- `runPipeline()` still invokes only the canonical `trading-pipeline-orchestrator`.
- On non-2xx responses, the handler now attempts to read the Edge Function response body and surfaces `message/error/reason`, `skipped=true`, and `run_id` when available.
- This specifically distinguishes a legitimate canonical concurrency skip (HTTP 409) from an actual pipeline failure instead of showing only the generic non-2xx message.
- **No pipeline logic, strategy logic, DB data, or scheduler was changed.**
- `/api/public/cron` was re-checked on current `main`: it is already disabled and returns HTTP 410; it does **not** call `runFullPipeline()`. The older tracker wording claiming it still contains the legacy writer is stale and should no longer be treated as an open code defect.
- Remaining P0.3 verification: publish this commit, trigger Run Pipeline once, and confirm the dashboard displays the canonical response/diagnostic correctly.


## 2026-10-06 — Production frontend re-publish / health display verification

- Lovable project `Pixel Perfect Pixels` latest source commit is `c98ab7284c36d29fa424555b62680ee2779d4150`.
- The project was re-published to the production URL `aicombined-trading-command-center.lovable.app` to ensure the current canonical health frontend is serving the latest source.
- Deployment request: `4aefc67f-1a0f-448e-8a04-b1be6beec3f1`.
- Current source code already reads canonical `get_pipeline_cron_health()` for both Pipeline Health and System Resources; no strategy, scheduler, historical-data, or pipeline-writer changes were made.
- Live verification still required from the production UI after the publish: Pipeline Health should report the real canonical status/last success and System Resources should show the real latest-run duration rather than the stale/0.0s values previously observed.
- The dashboard's `Every 2 min` selector remains a separate deferred UI/scheduler source-of-truth issue; do not change it during this verification pass.


## 2026-10-06 — Runtime conflict analysis: frontend healthy, canonical Edge inputs stale/misaligned

### Confirmed runtime state
- Canonical DB is healthy: 12/12 canonical runs completed in the last 2h, 0 errors, 0 running.
- Latest canonical run `aa2245b0-e3ea-4472-a2e2-83e5a4392fc7` completed in 22.973s at 12:00:24 UTC.
- `get_pipeline_cron_health()` reports **HEALTHY**, canonical schedule **10 minutes**, next run 12:10 UTC, consecutive failures 0.
- Therefore the observed UI `Every 2 minutes / Stale` remains a frontend/source-of-truth mismatch, not a runtime pipeline outage.

### Critical finding — active Supabase Edge signal-combiner is not the same implementation as current repo pipeline logic
- Production Edge Function `signal-combiner` is **version 6**.
- Its deployed code directly reads latest prediction/council rows but does **not** apply the current repo freshness guards for prediction/council data.
- Current repo `pipeline.server.ts` defines prediction freshness at 30m and council freshness at 30m (20m trending / 45m calm) and explicitly removes stale rows before signal combination.
- This creates a real runtime conflict: the DB/Edge canonical path can use stale council/prediction rows even though the current repo logic is designed to reject them.

### Evidence
- At the 12:00 UTC canonical run, `council_sync` synced 5 rows whose `source_created_at` values are from **2026-08-28**, while `council_signals` latest source time is **2026-10-06 08:50 UTC**; the dashboard shows council data `3h ago`.
- At the same run, `polymarket-check` returned updated market payloads, but the DB `prediction_snapshots.created_at` values remain at older insertion timestamps because the function upserts existing rows without explicitly refreshing `created_at`. This conflicts with freshness logic that interprets `created_at` as snapshot freshness.
- Despite stale timestamps, the deployed v6 `signal-combiner` attached prediction snapshot IDs to current composite signals. Example: BNB and UNI at 12:00 UTC include `prediction market leaning no` and non-null prediction IDs even though the table's latest `created_at` is hours old.
- `council-sync` itself is a separate freshness problem: it imports `source_created_at` from the external Whale Radar feed; the feed currently returns very old decisions, so the sync can be technically successful while providing stale AI inputs.
- `polymarket-check` keyword matching is also too broad: substring matching can map unrelated political questions such as `Adam Schiff` to ADA and `Hegseth` to ETH. These rows were observed in the 12:00 stage output. This is data-quality contamination, not a pipeline execution failure.

### Safety conclusion
- This is the user's suspected "conflict": **execution is healthy, but input freshness/source semantics are inconsistent between the current repo design and the actually deployed Edge Functions.**
- No production strategy weights, thresholds, historical rows, or trading logic were changed during this analysis.
- Do not tune strategy based on the current variant/signal sample until this runtime source mismatch is corrected and clean observations resume.

### Next implementation target
1. Bring canonical `signal-combiner` freshness semantics in line with the current repo implementation (without changing strategy thresholds/weights).
2. Give prediction snapshots an explicit `updated_at`/freshness timestamp semantics, or safely refresh the existing timestamp on successful market upsert; do not reinterpret historical data.
3. Tighten Polymarket symbol matching to avoid substring collisions.
4. Verify `council-sync` source freshness and prevent stale external decisions from being treated as current.
5. Execute one clean canonical cycle and verify the composite signal provenance/freshness against DB timestamps.

## 2026-10-06 — Runtime freshness conflict: implementation pass deployed

### Canonical Edge Functions corrected
The runtime mismatch identified above was corrected without changing strategy weights, thresholds, classifier, EMA50/ADX, R:R, scheduler interval, or historical rows.

- **signal-combiner v7 deployed**
  - prediction inputs now require `created_at` within the last **30 minutes**;
  - council inputs now require `source_created_at` within the last **30 minutes**;
  - whale inputs are bounded to the canonical **6-hour** lookback;
  - regime-level prediction/council reads use the same freshness windows;
  - stale rows therefore cannot be attached to new composite signals or fresh variant observations.
- **polymarket-check v3 deployed**
  - symbol matching uses the canonical crypto event feed and word-boundary matching;
  - this blocks known collisions such as `Adam Schiff → ADA` and `Hegseth → ETH`;
  - the function now uses the canonical `/events?tag_slug=crypto` feed, applies the existing $500 minimum-volume / 5%-95% probability / directional-question filters, and explicitly refreshes `prediction_snapshots.created_at` on successful upsert.
- **council-sync v2 deployed**
  - external council decisions older than 30 minutes are rejected from the sync write path;
  - stale external decisions are reported as `stale_skipped` instead of being treated as fresh.
- Supabase production project: `yckewtpfttvwiptmmrfq`.
- Deployment verification:
  - `polymarket-check` v5 ACTIVE
  - `council-sync` v2 ACTIVE
  - `signal-combiner` v7 ACTIVE

### Canonical repo source-of-truth
The deployed Edge Function sources are now mirrored under `supabase/functions/{polymarket-check,council-sync,signal-combiner}` plus `supabase/functions/_shared/*`.

### Market Regime
- Commit `c3831abfef29da9f91f17b7f8ab29f54ef4f84e4`.
- `getMarketRegime()` now filters prediction snapshots to the same 30-minute freshness window.
- This is a data-freshness correction only; no regime thresholds or weights were changed.
- Lovable production publish/verification remains required for this frontend server-function change.

### Verification required
1. Wait for / trigger one canonical cycle after the Edge Function deployments.
2. Confirm no current composite signal references prediction/council rows outside the freshness windows.
3. Confirm Polymarket rows no longer contain the known political-symbol collisions.
4. Confirm fresh Polymarket upserts advance `prediction_snapshots.created_at`.
5. Confirm stale council feed decisions are skipped rather than written as fresh.
6. Only after these checks pass, resume clean variant/resolver observation.

**Status: DEPLOYED / VERIFY.** No historical rows were deleted or rewritten.

## 2026-10-06 — Runtime verification after freshness deployment

- Canonical manual run after the fixes: `0e60f643-f690-4d89-9c47-50beeabb2210`.
- Run completed successfully in **21.476s**; all seven canonical stages returned HTTP 200.
- `polymarket-check` v5 returned **200**, scanned **689** crypto-tagged markets, and inserted **0** usable snapshots. This is a **data-availability/degraded-input condition**, not a pipeline error.
- `council-sync` v2 returned **200**, `synced=0`, `stale_skipped=5`. The external council feed is currently stale, so no stale council decisions were promoted into fresh canonical inputs.
- `signal-combiner` v7 produced 25 current composite signals, but the fresh cycle attached **0 prediction** and **0 council** rows. This is the expected safety result while those feeds have no fresh inputs.
- Direct `polymarket-check` v5 smoke test returned HTTP 200 with `scanned=689`, `inserted=0`; no runtime exception.
- Known contamination check returned **0** recent `Adam Schiff → ADA` / `Hegseth → ETH` rows.
- No historical rows were deleted, rewritten, or mass-resolved.

### Important interpretation
- The original runtime conflict is now materially corrected: **stale prediction/council inputs are no longer allowed into new composite signals**.
- The system is currently **execution-healthy but input-degraded** because the external council feed is stale and Polymarket currently yields no rows passing the canonical usability filters.
- Do **not** compensate for the missing inputs by relaxing freshness windows, probability/volume filters, or strategy thresholds. Observe the feeds first.
- `P0.2` therefore remains **OPEN / VERIFY** until fresh prediction/council data is observed in a clean cycle.
- `P0.3` execution verification is strengthened by this successful clean canonical run; frontend health display still needs live UI verification.
- `P0.4` remains OPEN: no fresh variant outcome has yet been resolved.

### Transient test note
- An intermediate `polymarket-check` v4 deployment returned `ReferenceError: matchSymbol is not defined` during a test because the canonical function body had not yet been fully aligned with the event-feed implementation. v5 replaced it immediately.
- v5 was directly smoke-tested with HTTP 200 and then exercised successfully inside the full canonical run above.

**Current status: runtime freshness guards DEPLOYED + VERIFIED; external prediction/council feeds currently DEGRADED; no strategy changes made.**

## 2026-10-06 — P1.1 deep strategy-authority audit + implementation completed

- Historical evidence confirmed `strategy_config` was designed as a production scoring input, not UI-only metadata.
- The canonical scorer was then wired to load the authoritative `strategy_config` row in commit `11f97930911b6709075bdbd4e0e40eea5f133dca`.
- Runtime verification on canonical DB `yckewtpfttvwiptmmrfq` confirmed the active `chart-trader` weights are actually reflected in fresh composite scores (e.g. ETH -0.50 whale +0.25 prediction = -0.25, HOLD).
- This was a wiring restoration only. No strategy weights, thresholds, classifier, EMA50/ADX, R:R, or historical rows were changed.
- Strategy variants remain benchmark/shadow arms and are not conflated with active strategy config.

Status: **P1.1 DONE — RUNTIME VERIFIED**

## 2026-10-06 — Canonical website-read binding pass

### System Resources — FIXED / VERIFY
- Root cause confirmed: canonical DB had **no** `public.get_system_resource_stats()`; the dashboard was therefore dependent on the legacy server-side Supabase binding.
- Canonical `get_system_resource_stats()` was created directly in `yckewtpfttvwiptmmrfq` as a read-only `SECURITY DEFINER` aggregate RPC with explicit `anon/authenticated/service_role` EXECUTE.
- Metrics now use client-backend connection count, database size, exact `strategy_variant_signals` count, and database cache-hit ratio.
- Canonical verification returned: **12/60 connections, 26 MB, 718 variant rows, 99.92% cache hit**.
- Repo migration mirror: `supabase/migrations/20261006192000_canonical_system_resource_stats.sql`.
- `getSystemResourceMetrics()` now reads both resource stats and pipeline health through the canonical Supabase client.
- Code commit: `f74606e7fa50514c6ea0c831d909d3becfad363f`.
- Migration commit: `d002142a2b58c293e03b00488fc93f071514e48b`.
- Production UI verification remains required after publish.

### Website read binding — FIXED / VERIFY
The following read-only website paths were moved off the legacy server-side Supabase binding and onto the canonical client, without changing write paths:
- AI health read — commit `4ffaf7795360c06648779cad020f654cff155eea`.
- Strategy config read — commit `8f04c1bd51640276c1a4cee01c1ddbc4b283d08e`.
- Cleanup config read — commit `493c3f3ef637bef26cfb1a37eb4404f6e60fd042`.
- Market Regime read — commit `bb359b194e2e82cca00c28441688a7f73287e402`.
- Diagnostic / Shadow read paths — commits `334a721fd7ef39d88df1403d1e8cefb4ea718c4e`, `d87014748a0b887c7ad824b1765c0b45deb56464`.
- Portfolio was already correctly using the canonical browser client; canonical `get_portfolio_summary()` verified successfully with 0 open, 0 closed and 3 legacy open SELL rows excluded.
- Schedule read and Pipeline Health read were already moved to the canonical client in commits `509eeff7161e29683568281a42879ea2be3b1954` and `d24fff7cc320a198f6ae6aa317129ced63448db3`.

### Security note
- Supabase security advisor flags the new System Resources RPC as a public SECURITY DEFINER function. This is intentional for the public dashboard and the function returns aggregate resource metrics only; no secrets, rows, or query text are exposed.
- Existing security findings remain open and are not being mixed into this read-binding pass.

## 2026-10-09 — Research checkpoint / avoid repeated work

- `DB-NULL-23` — full SQL NULL inventory: **DONE**. Do not rerun the inventory; continue only with a specific root-cause question.
- Social observation/transmission writer investigation: **STOPPED BY USER**. Do not reopen unless explicitly requested.
- `repeated_buy_research_ledger` — **WAITING_FOR_MATURITY**. Do not rerun the same performance analysis until markout horizons and sample size mature.
- Next active item: **Whale Flow Shock Follow-up data-quality semantics**. Read-only canonical DB audit found 546 rows labeled `complete_24h`, but only 144 had `btc_return_24h` populated. Root cause: `refresh_whale_flow_shock_followups()` labels completeness from flow deltas only, without requiring the paired BTC price return.
- Draft fix: PR [#72](https://github.com/gepappas98/pixel-perfect-pixels/pull/72), branch `fix/whale-flow-shock-data-quality`. Completeness now requires both flow and BTC price values at the same horizon; migration includes one bounded 168-hour refresh of derived follow-up rows.
- **Production status:** migration has NOT been applied. No source snapshots, transitions, trades, scoring, strategy, or scheduler were changed.
- Next action: review PR #72 and its SQL, then apply the migration to canonical Supabase only after explicit approval; verify resulting horizon counts before using this dataset for causal analysis.

## 2026-10-09 — Whale Flow Shock data-quality fix applied

- PR [#72](https://github.com/gepappas98/pixel-perfect-pixels/pull/72) merged into `main`; merge commit `8c6af7853ef352ef3a6e922d39d0e94096ae0d5a`.
- Migration `20261009050000_fix_whale_flow_shock_data_quality.sql` applied successfully to canonical Supabase project `yckewtpfttvwiptmmrfq`; Supabase migration history records `fix_whale_flow_shock_data_quality` at version `20261009043906`.
- Verification after the bounded 168-hour recomputation:
  - `complete_24h`: 144 rows, all 144 have both `delta_24h_pp` and `btc_return_24h`.
  - `complete_4h`: 486 rows, all 486 have both `delta_4h_pp` and `btc_return_4h`.
  - `complete_1h`: 76 rows, all 76 have both `delta_60m_pp` and `btc_return_1h`.
  - `complete_15m`: 21 rows, all 21 have both `delta_15m_pp` and `btc_return_15m`.
  - `partial`: 457 rows remain partial where the paired horizon is not fully available.
- The former false `complete_24h` count of 546 is now 144; this is a correction to completeness labels, not deletion of source data.
- No trading strategy, live/paper execution, risk limits, or scheduler were changed. Repeated BUY ledger remains **WAITING_FOR_MATURITY**.


## 2026-10-09 — P0 paper book / MTM forensic pass (draft branch)

- Canonical DB confirmed: `yckewtpfttvwiptmmrfq`; no SQL writes or historical data changes were made during this audit.
- Read-only snapshot: 46 open paper rows total = 43 BUY + 3 legacy SELL; BUY exposure is $43,000 across 8 symbols, all-side open entry notional is $46,000. Concentration: ONDO 17 rows / $17,000; TIA 15 / $15,000; DOT 5 / $5,000. All sampled open rows have entry price, quantity, SL and TP.
- Confirmed code issue in `TradesPanel.tsx`: one rejected Binance ticker request could reject the whole `Promise.all`, causing all current prices to disappear. Draft fix isolates failures per symbol, adds a timeout and explicitly warns when some prices are unavailable.
- Confirmed code issue in `RiskPanel.tsx`: any server-side query failure returned default `0 / 17` with an apparently ACTIVE status. Draft fix marks fallback metrics as DATA UNAVAILABLE and partial price coverage as PARTIAL DATA.
- Confirmed canonical orchestrator calls the `trade-executor` Edge Function. The repository implementation previously bypassed capacity in research mode, only deduplicated the exact same signal, and did not manage TP/SL exits in that function. Draft fix adds current-ticker TP/SL close handling with fee-aware realized PnL, a hard cap of 3 open paper BUY positions, and one open BUY per symbol. Signal-level observations remain in the research ledger; SELL rows are not deleted or rewritten. Risk-engine defaults are aligned to 3 max open positions and $30 max risk/trade at $20,000 equity (0.15%); portfolio/daily caps remain 1.2%. Strategy weights and confidence thresholds are unchanged.
- Branch: `fix/p0-paper-book-mtm-observability`. Changes are code-only and are NOT deployed to Supabase or production. Build/typecheck/runtime verification is still required before merge/deploy.
- Important limitation: ticker-based exit checks can miss an intrabar TP/SL touch between polling runs; this draft does not claim candle-level ambiguity resolution. Existing open rows will only close when a current ticker price meets their stored TP/SL; no bulk close/reset was performed.


- Follow-up read-only snapshot during review: the existing deployed pipeline continued changing the book while this PR remained undeployed. Latest query returned 45 open paper BUY rows ($45,000 entry notional) across 8 symbols plus 3 legacy SELL rows ($48,000 total all-side notional). This confirms the old deployed executor is still adding positions; code changes on the draft branch have not affected production. Counts are time-sensitive and must be re-queried before deployment.
- UI follow-up: risk percentage formatting now shows two decimal places for per-trade risk so 0.15% is not rounded misleadingly to 0.1%.
