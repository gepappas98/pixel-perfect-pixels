# Trading Command Center — P0/P1 Stabilization Tracker

Last updated: 2026-10-06 UTC — manual-trigger diagnostic

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

### P0.1 Canonical DB unification — DONE / VERIFY
- Canonical DB: `yckewtpfttvwiptmmrfq`.
- Legacy DB: `gbbrmzstuhdizfvabjvz`.
- Legacy cron writers were frozen.
- Legacy historical data was migrated without reset.
- `data_plane_unification_audit` records the migration/freeze.
- Repo env/config was switched to canonical.
- Migration: `20261006090500_unify_council_source_id_text.sql`.
- Commit: `2df8d7a121981a6030000849c094676a5598e687`.
- Remaining verification: Dashboard / Shadow / DB must show the same current canonical `pipeline_run_id`, timestamps and counts.

### P0.2 Freshness / mapping — DONE
- Prediction selection made directional, volume-aware and probability-bounded.
- Council freshness now uses actual AI/input timestamps.
- Panel uses `source_created_at`.
- Commits: `e77c0d0`, `650d3ee`, `b306a51`.
- Do not retune strategy until clean observations are collected.

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
1. **Manual UI error handling remains OPEN.** The UI currently reports only `Edge Function returned a non-2xx status code`; it does not surface the orchestrator response body.
2. A direct canonical manual diagnostic invocation was verified successfully: run `b7d5e64d-a2cf-41c6-87ea-1478e0816add`, 21.1s, status `completed`, all six canonical stages completed, no executor HTTP 500.
3. A subsequent scheduled canonical run also completed successfully: run `3a86421e-559d-4e15-b467-9995b3b9092a`, 20.3s.
4. The orchestrator's concurrency guard can legitimately return HTTP 409 with `skipped=true` when another run is active; the current UI collapses this into the generic non-2xx message. This must be made explicit in the manual-trigger handler.
5. Verify Pipeline Health against the canonical run source after scheduler consolidation.
6. Verify no duplicate pipeline runs are created by manual + cron overlap.

### CRITICAL — scheduler path still needs consolidation
The current canonical pg_cron state was re-checked:
- active job: `trading-pipeline-orchestrator`, schedule `*/10 * * * *`
- inactive legacy job: `trading-pipeline-every-15-min`
- `pipeline_settings.id=1` currently has `interval_minutes=10`
- the dashboard offers 2/5/10-minute choices, but the canonical DB scheduler is still at 10 minutes.

Separately, the application route `/api/public/cron` still contains the legacy `runFullPipeline()` path. This must still be consolidated so there is no second pipeline implementation.

This is NOT yet considered fixed.

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

**Canonical-path finding (2026-10-06):** the active production orchestrator previously had no variant-resolver stage, and the canonical `signal-combiner` does not currently produce `strategy_variant_signals`. The table currently contains 384 historical `open` rows, with no recent `ambiguous` outcomes. We therefore must NOT mass-resolve those 384 historical rows.

A production `variant-resolver` Edge Function was deployed with a hard historical cutoff (`2026-10-06T09:57:00Z`) so it cannot touch the old sample. It was added as a canonical stage after signal-combiner and verified in run `f3131dbe-43db-4ba1-9916-199f2d9b1138`: stage HTTP 200, `resolved=0`, `skipped_historical=true`. This confirms the safety boundary, but P0.4 remains OPEN until a canonical producer creates fresh variant rows and at least one fresh row is resolved/observed.

Next: wire the variant producer into the canonical path (without mass historical re-resolution), then validate fresh outcomes and the 5m→15m ambiguity rule.

Next sequence:
**correct resolver → collect valid observations → compare `production_regime_label` vs `shadow_regime` vs actual outcome → only then consider strategy/classifier changes.**

---

## P1 — Known items not to forget

### P1.1 Strategy configuration wiring
- Canonical `strategy_config` was intentionally NOT overwritten by legacy balanced settings.
- Deployed signal combiner historically did not read `strategy_config` weights correctly.
- Must verify configuration is actually authoritative before any strategy tuning.
- Do not change current weights/thresholds merely to make metrics look better.

### P1.2 Cron / pipeline source-of-truth mismatch
- Canonical cron previously observed at 10 minutes.
- User has now selected 2 minutes.
- UI, `pipeline_settings`, pg_cron job and actual Edge Function target must all agree.
- No legacy `trading-pipeline-auto` writer may remain active once canonical scheduler is wired.

### P1.3 Security
- `dynamic_watchlist_snapshots` had RLS disabled.
- Security hardening remains open.
- Do not blindly enable RLS without appropriate policies; audit first.

### P1.4 Observability
Need one coherent health model showing:
- latest canonical run
- duration
- status
- last success
- next scheduled run
- consecutive failures
- stage-level failures
- manual vs scheduled trigger source

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
1. Verify manual Run pipeline / improve its error reporting.
2. **DEFERRED:** consolidate the scheduler interval/source-of-truth after higher-priority P0 checks.
3. Verify one or more clean canonical cycles.
4. Verify executor and risk behavior.
5. Verify resolver ambiguity fix / deploy if still missing.

**THEN**
6. Verify canonical Dashboard/Shadow/DB alignment.
7. Wire/verify strategy_config authority.
8. Security/RLS audit.
9. Observability cleanup.

**ONLY AFTER CLEAN DATA**
10. Analyze strategy variants/regime performance.
11. Consider strategy changes based on evidence.

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
