# Intelligent Research Lab — Production Audit
**Audit date:** 2026-10-24  
**Canonical source:** Supabase project `yckewtpfttvwiptmmrfq`  
**Repository head inspected:** `d5fa398335466d0357722ea1ff65260228fc0517`  
**Mode:** Read-only database inspection; no trade/history rows changed.

## 1. Recovery snapshot

- Archive run: `20261024T054440Z`
- Status: `EXPORT_COMPLETE`
- Scope: 65 public base tables, 1,124,109 rows, 95 files.
- Manifest: `20261024T054440Z/manifest.json`
- Manifest SHA-256: `63ee06c6ba946d9dd1243304a3da5b5bd7e25f34322aca63a305da457341dc1d`
- Storage read-back SHA-256 matched; `readback_verified=true`.
- The snapshot is retained as a recovery point. Do not reset production or delete source rows based solely on this export.

**Scope limitation:** This is a table-data export, not a full PostgreSQL backup. It does not include routines/function bodies, triggers, policies/grants, extensions, cron job definitions, or view definitions. Public schema currently has 65 base tables and 3 views: `cmc_listing_research_observations`, `council_lessons_link_audit`, and `portfolio_summary`. Their source tables are included, but the view definitions are not part of the archive manifest.

## 2. Retention/deletion guard

The active cron job calls `cleanup_research_data(72,168,false)`. The database control row currently reports:
- `allow_archive=false`
- `allow_source_delete=false`

The function returns before archival or DELETE statements when archive is disabled. Source deletion is therefore locked by the current flags. Keep both flags false until the archive and evidence-value review is complete. Do not enable retention deletion as part of this audit.

## 3. V3 benchmark — live database counts

The live V3 cohort is isolated by all of:
- `research_cases.cohort = 'V3'`
- `source_table = 'strategy_variant_signals'`
- `scorer_version = 'v3-mtf-aligned'`
- `fingerprint LIKE 'v3|%'`

Current cohort:
- Total rows: **6,062**
- Resolved rows: **5,947** (2,646 wins, 2,974 losses, 327 expired)
- Open rows: **115**
- Binary win/loss observations for the statistical-validation panel: **5,620**
- Distinct (symbol, cycle) pairs among those binary observations: **4,601**

The per-strategy RPC `observatory_v3_benchmark_summary()` is a **raw variant-row** summary, not a deduplicated symbol-cycle result. Its reported net PnL is in percent units and must not be read as USD or as the live portfolio's PnL.

| Strategy | Total cases | Resolved | W | L | Expired | Open | Win rate among W/L | Mean resolved net PnL (%) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| accumulation | 3,275 | 3,266 | 886 | 2,236 | 144 | 9 | 28.38% | -0.992247 |
| ai-driven | 275 | 264 | 187 | 65 | 12 | 11 | 74.21% | +2.079128 |
| balanced | 153 | 146 | 99 | 36 | 11 | 7 | 73.33% | +1.950237 |
| chart-trader | 68 | 61 | 35 | 19 | 7 | 7 | 64.81% | +1.292924 |
| conservative | 201 | 194 | 130 | 53 | 11 | 7 | 71.04% | +1.843993 |
| smc-reversal | 200 | 186 | 103 | 72 | 11 | 14 | 58.86% | +1.043329 |
| volatility-timing | 227 | 213 | 114 | 87 | 12 | 14 | 56.72% | +0.900167 |
| vwap-momentum | 168 | 157 | 84 | 63 | 10 | 11 | 57.14% | +0.923937 |
| whale-focused | 1,495 | 1,460 | 1,008 | 343 | 109 | 35 | 74.61% | +2.024543 |

**Statistical caution:** the current cohort covers only a short period (approximately 2026-10-19 through 2026-10-24). It is not out-of-sample evidence across market regimes. Do not promote a strategy or change live scoring based on these values alone. Check timestamp availability at entry and preserve separation between raw rows and deduplicated symbol-cycle units.

## 4. V3 UI defect identified

`src/components/trading/V3StatisticalValidationPanel.tsx` requested only `.range(0,4999)`. The live query currently has 5,620 resolved win/loss rows, so the panel could silently omit at least 620 rows. This biases raw metrics and symbol-cycle deduplication, because the query sorts oldest-first.

A proposed code-only fix is in branch `fix/v3-benchmark-pagination-2026-10-24`: fetch stable, ordered pages of 1,000 until the final partial page. It is not merged or deployed. Review and run project validation before merging; Lovable production deployment remains a separate explicit step.

## 5. Historical paper-trade ledger (USD PnL)

Current `trades` table: **465 rows**, 442 closed and 23 open.

| Entry source | Closed | Closed PnL sum (USD) | Open |
|---|---:|---:|---:|
| cmc_paper | 294 | -1,038.36 | 13 |
| early_entry_regime | 26 | +210.90 | 0 |
| event_flow_paper | 48 | -429.65 | 9 |
| standard | 74 | -187.51 | 1 |

These are current source-table totals, not the older dashboard snapshots. Preserve row-level history; do not replace prior reported snapshots without recording their as-of time and calculation semantics.

## 6. Intelligent Research Lab enrichment status

- `research_evidence`: 8,815 rows
- `research_cases`: 8,777 rows, including 6,062 V3 cases
- `research_findings`: 0 rows — candidate/validated findings layer is not yet populated
- `council_lessons`: 471 rows
- Council lesson links: 442 linked; 29 orphaned source trade IDs; 0 missing source_trade_id values.
- `cmc_listing_research_observations` view: 28,000 observations across 1,050 assets; 24,810 have a 24h forward label and 16,722 have a 72h label. These are derived labels for retrospective research, not entry-time features.
- Event→Flow, whale-flow, accumulation shadow, social-chain, early-entry lineage, strategy diagnostics, dynamic watchlist, and paper trade data tables are included among the 65 exported base tables.

Recommended retention priority:
1. Preserve raw trade/signal histories, immutable entry contexts, timestamps and provenance/fingerprints.
2. Preserve V3/V2/legacy cohorts separately; never merge them into a single performance population.
3. Preserve `research_evidence`, `research_cases`, and future reproducible `research_findings` with causal timestamps and evidence IDs.
4. Treat repeated derived snapshots/diagnostics as secondary only after source lineage and reproducibility are confirmed; do not delete them yet.

## 7. Dependency and deployment findings

- Active canonical orchestrator cron: every 10 minutes; its job uses the Vault-held `pipeline_orchestrator_cron_token`.
- Active collectors include Event→Flow, social-source sweep, market candles, early-entry variants, paper-open logic and watchdog/readiness checks. Cron definitions are outside the table snapshot and must be exported separately for a full recovery plan.
- Active Edge Functions include `signal-combiner`, `variant-resolver`, `council-lessons`, and `research-archive-exporter`.
- `signal-combiner` imports the shared `_shared/mtf-scoring.ts` function and uses 4h/1h/1d technical inputs. The shadow diagnostic path intentionally retains separate legacy council multipliers/thresholds; compare those diagnostic semantics to the active scorer before using them as benchmark evidence.
- The deployed `council-lessons` function is currently `verify_jwt=false` while using a service-role client and writing lessons/trade flags. Review invocation/authentication boundaries before expanding automated use; this audit did not change the function.

## 8. Next actions (non-destructive)

1. Merge/deploy the V3 pagination fix only after code review and validation.
2. Export the missing database-object layer: views, functions/procedures, triggers, RLS policies/grants, extensions, cron jobs, Vault secret **names only** (never secret values), and Edge Function source/version/config metadata.
3. Investigate the 29 orphaned Council lesson links; do not fabricate or rewrite source trade IDs.
4. Populate `research_findings` only with reproducible, timestamp-safe findings linked to existing cases/evidence.
5. Continue MTF parity audit across live scorer, variant resolver, V3 benchmark, and shadow diagnostics. Keep V2/legacy excluded from active V3 analysis.
6. Keep source-deletion flags disabled until a full recoverability test and explicit retention review are complete.
