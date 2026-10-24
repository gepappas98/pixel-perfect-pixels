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

**Scope limitation:** This is a table-data export, not a full PostgreSQL backup. It does not include routines/function bodies, triggers, policies/grants, extensions, cron job definitions, or view definitions. The live database inventory is 65 public base tables, 3 views (`cmc_listing_research_observations`, `council_lessons_link_audit`, `portfolio_summary`), 66 public routines, 10 public triggers, 117 public RLS policies, 8 extensions, and 16 cron jobs (13 active). These object definitions are not part of the archive manifest. The views' source tables are included, but the view definitions are not.

## 2. Retention/deletion guard

The active cron job calls `cleanup_research_data(72,168,false)`. The database control row currently reports:
- `allow_archive=false`
- `allow_source_delete=false`

The function returns before archival or DELETE statements when archive is disabled. Source deletion is therefore locked by the current flags. Keep both flags false until the archive and evidence-value review is complete. Do not enable retention deletion as part of this audit.

The read-only call `get_research_archive_status(72,168)` currently reports **incomplete**: 138,601 eligible retention-source rows, 0 archived in `research_evidence`, 138,601 missing evidence keys. By source table: asset_news_events 948; asset_flow_snapshots 44,190; whale_flow_snapshots 6,524; asset_price_snapshots 44,186; whale_flow_transitions 2,578; event_flow_transmissions 30; asset_sentiment_snapshots 35,006; whale_flow_shock_followups 2,561; whale_flow_transition_context 2,578. This is the separate evidence/retention archive, not the 1.124M-row Storage snapshot. It indicates no qualifying retention sources have yet been captured into `research_evidence`; it does not mean the source rows are missing. Deletion remains disabled.

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

- `research_evidence`: 13,037 rows after the V4 backfill (8,815 before backfill)
- `research_cases`: 12,999 rows: 2,250 V2, 6,062 V3, 4,222 V4 and 465 paper-trade cases marked Unknown
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


## 9. Research findings populated (candidate-only, additive)

The previously empty `research_findings` table now contains **10 candidate findings**. Nine V3 summary findings were added, and one provenance finding was added and then updated to record the completed V4 backfill. No trade, signal, benchmark, or existing case rows were modified:
- 9 per-strategy V3 raw win/loss summaries, totaling 5,620 case references and 5,620 evidence references across those findings.
- 1 data-lineage finding, linked to all 6,062 V3 research cases and their 6,062 evidence references.

Every candidate has `confidence=0`, status `candidate`, and explicit limitations. These are not validated strategy edges and are not live scorer inputs. The summaries use win/loss outcomes only; expired/open observations are excluded from win rate and mean PnL.

## 10. Critical cohort policy-scope and provenance caveat

A read-only join of `strategy_variant_signals` to `research_cases` found:
- `v2|` rows: 65,735 raw rows in the source table, dated 2026-10-14 15:30 UTC to 2026-10-19 16:50 UTC.
- `v3|` rows: 6,062, dated 2026-10-19 17:00 UTC to 2026-10-22 22:30 UTC; **0** carry the `policy=v4_live_aligned` tag.
- `v4|` rows: 4,209, dated 2026-10-22 22:40 UTC to 2026-10-24 06:00 UTC; all 4,209 carry `policy=v4_live_aligned`.
- All 6,062 `v3|` rows are represented as `research_cases.cohort='V3'` and `scorer_version='v3-mtf-aligned'`. The current source code explicitly describes V3 as pre-V4 policy methodology, while V4 rows carry `policy=v4_live_aligned`. The V3 label should be treated as MTF-component designation only; it does not prove full policy parity with V4.
- The current `research_cases` population originally lacked V4. An additive production migration `add_v4_research_cohort_and_backfill_cases` has now extended the cohort constraint and backfilled V4 separately. Verification after backfill: **4,222 V4 cases**, all linked to entry-context evidence; 1,422 are open and 2,800 resolved. The cohort counts are now 2,250 V2, 6,062 V3, 4,222 V4, and 465 paper-trade cases marked Unknown.

This is a material policy-scope/provenance caveat, not proof that the MTF formula itself differs. The shared MTF helper is used in current live/variant scoring, but current metadata does not prove that every historical V3 row used the same MTF implementation, gate, booster and thresholds. Keep V3 results provisional; do not relabel historical records or mix V3 and V4. The candidate finding `research-data-lineage-v3-v4-20261024` records the remaining V3 provenance discrepancy and the completed V4 backfill with source case/evidence links.

## 11. Council orphan audit

The 29 orphaned Council lesson links date from 2026-10-12 through 2026-10-14; all are older than the 442 currently linked lessons (2026-10-15 through 2026-10-24). Examples point to UUIDs absent from the current `trades` table. This suggests historical source-trade lineage may have been removed or the identifiers were created from a different source, but it is not sufficient to distinguish those possibilities. No IDs were rewritten and no lessons deleted. Next step is to search archived snapshot rows for the exact UUIDs and recover links only where a deterministic match exists.

## 8. Next actions (non-destructive)

1. Merge/deploy the V3 pagination fix only after code review and validation.
2. Export the missing database-object layer: views, functions/procedures, triggers, RLS policies/grants, extensions, cron jobs, Vault secret **names only** (never secret values), and Edge Function source/version/config metadata. Keep the separate retention archive paused until the 138,601-source evidence gap is addressed and verified.
3. Investigate the 29 orphaned Council lesson links against the archived trade snapshot; do not fabricate or rewrite source trade IDs.
4. Keep the 10 `research_findings` as candidate-only until independent deduplicated symbol-cycle and out-of-sample checks validate them; all currently have confidence 0 and are not live scorer inputs.
5. Reconcile the V3 scorer-version label with source-code provenance; V4 cohort support/backfill is now complete. Continue MTF parity audit across live scorer, variant generation, V3 benchmark, and shadow diagnostics. Keep V2/legacy excluded from active V3 analysis.
6. Keep source-deletion flags disabled until a full recoverability test and explicit retention review are complete.


## 12. Independent repository backup verified

The merged full-repository backup workflow completed successfully on `main` at commit `d5fa398335466d0357722ea1ff65260228fc0517` (run [40060991374](https://github.com/gepappas98/pixel-perfect-pixels/actions/runs/40060991374)). The workflow log explicitly records:
- `tracked_file_count: 408`
- `all_tracked_files_included: true`
- full source archive, manifest and verification summary retained as an artifact
- isolated IRL archive mirror step completed successfully

Artifact: [full-repository-source-backup-d5fa398335466d0357722ea1ff65260228fc0517](https://github.com/gepappas98/pixel-perfect-pixels/actions/runs/40060991374). ZIP size 703,629 bytes; artifact digest `sha256:62f458d1bb75d0a3866a1332e93fbb0bff5908f1a55b8413bd6a6d443a641976`; retention expiry 2027-01-22. This verifies the code snapshot for that commit, not a PostgreSQL schema/data backup and not the later unmerged PR branch.

## 13. Production object inventory (2026-10-24)

A read-only catalog query confirmed:
- 65 public base tables, 3 views, 1,046 public columns
- 241 constraints, 254 indexes
- 66 public routines (signatures inventoried; routine bodies are not part of the table-data snapshot)
- 10 non-internal triggers, 117 public RLS policies
- 8 extensions, 16 cron jobs (13 active)

This is the inventory of the missing object layer that must accompany a recoverable database backup. The earlier table-data manifest does not contain these definitions. A metadata-only archive write was attempted but was rejected by the connected archive SQL tool; therefore **do not claim the object bundle has been durably exported yet**. Next step is to export a versioned metadata document through the verified repository archive workflow or a supported archive API, verify its read-back hash, and include view/trigger/policy/constraint/index definitions. Routine source bodies and cron command text must remain excluded or separately reviewed for embedded secrets.

## 14. Retention gap refreshed

As of the latest read-only check at 2026-10-24 06:20 UTC, `get_research_archive_status(72,168)` reports `status=incomplete`, `eligible_sources=138,953`, `archived_sources=0`, `missing_sources=138,953`, `archive_enabled=false`, and `delete_enabled=false`. The per-table source counts drift as new rows arrive, so use this latest snapshot rather than the earlier 138,601 count. No archive/delete flags were changed.
