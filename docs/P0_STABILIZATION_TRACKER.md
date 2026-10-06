# Trading Command Center — P0/P1 Stabilization Tracker

Last updated: 2026-10-06 UTC

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
1. Verify one manual **Run pipeline** creates a new canonical `pipeline_runs` row and completes.
2. Verify Pipeline Health changes from stale/running 100% to healthy/running with the new run.
3. Verify the new run contains canonical stage results and no executor HTTP 500.
4. Verify no duplicate pipeline runs are created by manual + cron overlap.

### CRITICAL — scheduler path still needs consolidation
The UI schedule function still uses the old route:
`set_pipeline_schedule()` → `trading-pipeline-auto` → `/api/public/cron` → legacy `runFullPipeline()`.

This is NOT yet considered fixed.

Target architecture:
**Manual + Auto → canonical `trading-pipeline-orchestrator` → one canonical `pipeline_runs` source of truth.**

The user has intentionally set the UI interval to **2 minutes**. Preserve that setting; do not silently change it back to 10 minutes. First make the 2-minute scheduler invoke the canonical orchestrator safely.

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

Status: the remaining intrabar ambiguity fix still needs production deployment/verification unless a later commit proves it already landed.

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
1. Verify manual Run pipeline.
2. Consolidate 2-minute auto scheduler onto canonical orchestrator.
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
