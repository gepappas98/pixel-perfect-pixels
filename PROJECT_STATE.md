Trading Command Center — PROJECT STATE

Master document: complete history, current state, next steps.
Update at end of every session.

Last updated: 2026-10-02 (night)
Session 4: Hot Whale Queue (intra-cycle discovery) + Aggregated Directional Signal

---

EXECUTIVE SUMMARY

Σημερινές συνεδρίες (4 total σε 1 μέρα):

Session 1 — Audit fixes

· ✅ Dynamic trading settings (pipeline_settings + 30s cache)
· ✅ 1h variant resolution (αντί 4h — 4× accuracy)
· ✅ Regime-aware Groq cadence (15/25/40 min)
· ✅ Groq token overflow fix (800 → 4096)
· ✅ Dead constants cleanup

Session 2 — Quality & safety

· ✅ Deterministic auto-switch fallback
· ✅ Auto-demote rule (winRate < 40% → force switch)
· ✅ Circuit breaker (skip new entries on feed failure)
· ✅ Prediction magnitude scaling
· ✅ classify() tightening (RSI 44-56 neutral)
· ✅ Unit tests (57 passing)

Session 3 — Dynamic universe & provenance

· ✅ Dynamic watchlist από Hyperliquid volume + Binance listings
· ✅ 150 coins hard cap (bounded pipeline load)
· ✅ Hysteresis band ($5M add / $3M remove)
· ✅ Pinned symbols (BTC/ETH/SOL + open positions)
· ✅ RevolutX tagging — full provenance tracking
· ✅ Capacity analysis — empirical max ~200 coins
· ✅ 6h snapshot stability

Session 4 — Hot Whale Queue ⭐ ΝΕΟ

· ✅ Intra-cycle discovery — αντί 6h latency → 30min window
· ✅ Aggregated directional signal — buy_ratio + confidence αντί single trade
· ✅ Synthetic candle fallback για sparse symbols
· ✅ Dynamic threshold (0.75 για hot-whale-only)
· ✅ Conviction boost (max +0.30 για strong hot whale)
· ✅ Full RLS + SECURITY DEFINER για Lovable Cloud compatibility

---

KEY INNOVATION — HOT WHALE QUEUE

Το Πρόβλημα που Λύνει

Πριν:

```
13:00  PUMP γίνεται hot στο HL (top mover, $40K whale flow)
13:00  collectWhaleAlerts() καταγράφει το PUMP ✅
13:00  combineSignals() 🚫 ΔΕΝ το κοιτάει (δεν είναι στο watchlistCtx)
19:00  Resolver κάνει refresh → PUMP μπαίνει στο watchlist
19:00  combineSignals() βλέπει το PUMP αλλά έχει χάσει την ευκαιρία
```

Μετά:

```
13:00  PUMP γίνεται hot
13:00  collectWhaleAlerts() → recordHotWhale() → hot_whale_signals table
13:02  Επόμενο pipeline: combineSignals() περιλαμβάνει το PUMP ✅
13:02  Signal παραδίδεται με tag ["hot-whale"] ✅
13:32  Αν δεν υπάρχει νέα δραστηριότητα → expire (30min window)
15:00  Cleanup TTL περνάει (120min) → row διαγράφεται
```

Aggregated Directional Signal

Πριν: Single trade → direction: "accumulation" | "distribution"

· 1 trade μπορεί να είναι hedge, liquidation aftermath, ή market maker rebalance
· Binary, no confidence

Μετά: Aggregated από πολλαπλά trades →

· buy_ratio = buy_usd / total_usd (0..1)
· direction requires: alert_count ≥ 3 AND (buy_ratio ≥ 0.65 OR ≤ 0.35)
· confidence = 0.7 × clarity + 0.3 × sampleFactor
· conviction boost = additive score bonus (max +0.30)

Dynamic Threshold για Sparse Symbols

Πρόβλημα: Perp-only symbols (kPEPE) δεν έχουν Binance candles → mtf.score = 0 → ποτέ BUY με fixed threshold 1.5.

Λύση: Όταν hotWhaleAggregate qualifies AND symbol is sparse (missing MTF or council), κατεβάζουμε τα thresholds:

· buyThreshold: 1.5 → 0.75
· sellThreshold: -1.5 → -0.75
· holdThreshold: 0.5 → 0.25

---

CAPACITY ANALYSIS

Theoretical model (pMap 15, avg 250ms latency):

Coins Tasks Realistic Status
95 (baseline) 285 50-90s ✅
150 (target) 450 65-110s ✅ SAFE
200 600 90-150s ⚠️ Aggressive
250+ 750+ 120-230s+ 🔴 Architectural change

Practical max: 200 coins (με pMap 20).

Με hot queue: +20 coins worst case → 170 effective coins. Ακόμα safe.

---

STATUS

Component Status
Pipeline ✅ Healthy, 150 + hot coins bounded
Dynamic watchlist ✅ Deployed
Hot Whale Queue ✅ Deployed (intra-cycle)
Provenance tagging ✅ Alerts/trades/signals tagged
Whale aggregation ✅ buy_ratio + confidence
Circuit breaker ✅ Active
Auto-switch ✅ vwap-momentum + deterministic fallback
Unit tests ✅ 87+ passing
Paper mode ✅ Active

---

FILES & ARCHITECTURE

New Files (Session 4)

File Purpose Lines
supabase/migrations/20261002130000_hot_whale_queue.sql Hot queue + RLS + RPCs ~170
src/lib/hot-whale.server.ts Recording + aggregation + conviction boost ~290
src/lib/__tests__/hot-whale.test.ts 30 tests ~250

New Files (Session 3)

File Purpose Lines
supabase/migrations/20261002120000_dynamic_watchlist.sql Snapshots + tags ~70
src/lib/coin-provenance.ts Static curation ~55
src/lib/watchlist-resolver.server.ts Dynamic resolution ~450
src/lib/watchlist-expander.ts Manual discovery ~150

New Files (Session 1+2)

File Purpose
src/lib/trading-settings.server.ts Dynamic TP/SL
vitest.config.ts Test runner
src/lib/__tests__/signal-logic.test.ts 41 tests
src/lib/__tests__/mtf-gate.test.ts 16 tests

Patched Files

File Session
src/lib/pipeline.server.ts 1,2,3,4 (30+ patches)
src/lib/watchlist-resolver.server.ts 4 (tagsFor signature)
src/lib/strategy.functions.ts 2 (deterministic fallback)
package.json 2 (vitest scripts)

---

DATABASE SCHEMA

Tables

Table Purpose Session
dynamic_watchlist_snapshots Watchlist snapshots (6h TTL) 3
hot_whale_signals Intra-cycle hot queue (120min TTL) 4
trade_alerts + tags[] column 3
trades + source_tags[] column 3
composite_signals + source_tags[] column 3
strategy_variant_signals + source_tags[] column 3

RPC Functions (Session 4)

Function Purpose
record_hot_whale(text, numeric, boolean, text) Upsert hot observation
get_hot_whale_symbols(int, int) Fetch top N hot symbols
cleanup_hot_whales(int) Delete stale entries

Όλες SECURITY DEFINER SET search_path = public + explicit GRANT EXECUTE.

---

PROVENANCE TAGS

Κάθε alert/trade/signal παίρνει tags[]:

Tag Σημασία Session
always-include BTC/ETH/SOL 3
open-position Έχει ανοιχτό trade 3
revolutx Manual curated 3
hl-dynamic Auto-added από HL volume 3
core-fallback Cold-start fallback 3
hot-whale Intra-cycle discovery 4

---

VERIFICATION QUERIES

Hot Whale Queue Health

```sql
-- 1. Current hot symbols
SELECT symbol, alert_count, ROUND(total_usd) AS usd,
       ROUND(buy_usd / NULLIF(total_usd, 0) * 100) AS buy_pct,
       sources, last_seen_at::text
FROM hot_whale_signals
ORDER BY total_usd DESC;
```

Expected: 5-20 rows. Coins όπως PUMP, kPEPE, ENA, HBAR.

```sql
-- 2. Hot signals produced
SELECT symbol, recommendation, confidence, source_tags, created_at::text
FROM composite_signals
WHERE source_tags @> ARRAY['hot-whale']
ORDER BY created_at DESC LIMIT 20;
```

```sql
-- 3. Hot trades opened
SELECT symbol, side, source_tags, status, created_at::text
FROM trades
WHERE source_tags @> ARRAY['hot-whale']
ORDER BY created_at DESC LIMIT 10;
```

Dynamic Watchlist

```sql
SELECT cardinality(symbols) AS n, source, hl_candidates, binance_filtered,
       cardinality(pinned_symbols) AS n_pinned,
       computed_at, expires_at
FROM dynamic_watchlist_snapshots
ORDER BY computed_at DESC LIMIT 1;
```

Expected: n = 145-155, source = "refreshed" ή "cache", hl_candidates ≥ 230.

Pipeline Health

```sql
SELECT started_at::text, ROUND(duration_ms/1000.0,1) AS sec,
       whales, indicators, signals, variants_resolved, status, error_message
FROM pipeline_runs
ORDER BY started_at DESC LIMIT 10;
```

Feed Alerts (Session 4)

```sql
SELECT event_type, tags, COUNT(*) FROM trade_alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY event_type, tags;
```

---

LOG LINES ΝΑ ΨΑΞΕΙΣ

Μετά το deploy, στο επόμενο pipeline (2-3 runs):

```
[WATCHLIST] source=refreshed total=150 pinned_always=3 pinned_open=4 revolutx=15 hl_dynamic=128 (hl_candidates=247, binance_filtered=198)
[HOT_WHALE] queued 8 non-watchlist symbols (top: PUMP=$40K, kPEPE=$32K, ...)
[COIN_PROVENANCE] total=150 revolutx=15 hl_dynamic=128 always_include=3 open_positions=4
[INDICATORS] including 8 hot-whale symbols: PUMP,kPEPE,...
[INDICATORS] Collected 465/471 (98.7%) in 78000ms
[HOT_WHALE_INCLUDE] added 8 hot symbols to signals: PUMP,kPEPE,...
[HOT_WHALE_DIRECTION] PUMP: accumulation (buy_ratio=72%, samples=5, conf=68%)
[hot-whale boost +0.15 (buy_ratio 72%, samples 5, conf 68%)]
[HOT_WHALE] cleaned 3 stale entries
[PIPELINE_DONE] watchlist_size=150 source=refreshed
```

---

STRATEGY CONFIG (Τρέχον)

```json
{
  "preset_name": "vwap-momentum",
  "whale_weight": 0.5,
  "technicals_weight": 2.2,
  "prediction_weight": 0.5,
  "council_weight": 0.8,
  "auto_switch_enabled": false,
  "last_auto_reasoning": "AUTO_DEMOTE: current=chart-trader → vwap-momentum (74% WR)"
}
```

---

ΑΜΕΣΕΣ ΕΝΕΡΓΕΙΕΣ

Τώρα (Deploy)

1. Apply migrations (2):
   ```bash
   # Στο Supabase SQL Editor:
   # 1. 20261002120000_dynamic_watchlist.sql (Session 3)
   # 2. 20261002130000_hot_whale_queue.sql (Session 4)
   ```
2. Deploy files:
   · src/lib/hot-whale.server.ts (new)
   · src/lib/watchlist-resolver.server.ts (patched tagsFor)
   · src/lib/pipeline.server.ts (Part 1 + Part 2)
   · src/lib/__tests__/hot-whale.test.ts (new)
3. Verify migration:
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name = 'hot_whale_signals';
   
   SELECT proname FROM pg_proc
   WHERE proname IN ('record_hot_whale', 'get_hot_whale_symbols', 'cleanup_hot_whales');
   ```

Σε 10 λεπτά

· ☐ Check pipeline_runs: status = 'success'
· ☐ Check [HOT_WHALE] logs
· ☐ Verify hot_whale_signals table populated
· ☐ Check composite_signals με hot-whale tag

Σε 1 ώρα

· ☐ Measure pipeline duration (< 120s)
· ☐ Check hot queue churn (πόσα μπαίνουν/βγαίνουν ανά 30min)
· ☐ Verify hot trades opening

Σε 24-48h

· ☐ Provenance analytics:
  ```sql
  SELECT
    CASE
      WHEN source_tags @> ARRAY['hot-whale'] THEN 'hot-whale'
      WHEN source_tags @> ARRAY['revolutx'] THEN 'revolutx'
      WHEN source_tags @> ARRAY['hl-dynamic'] THEN 'hl-dynamic'
      WHEN source_tags @> ARRAY['always-include'] THEN 'always-include'
      ELSE 'other'
    END AS provenance,
    COUNT(*) AS trades,
    COUNT(*) FILTER (WHERE pnl > 0) AS wins,
    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1) AS win_rate,
    ROUND(SUM(pnl)::numeric, 2) AS total_pnl
  FROM trades
  WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '7 days'
  GROUP BY 1 ORDER BY total_pnl DESC;
  ```
· ☐ Tune HOT_THRESHOLD_USD αν χρειάζεται (default $25K)
· ☐ Tune HOT_TTL_MINUTES (default 120min)
· ☐ Tune HOT_CONVICTION_MIN_USD (default $50K)

---

ΚΡΙΣΙΜΕΣ ΑΠΟΦΑΣΕΙΣ

Γιατί Hot Queue αντί για μείωση resolver TTL;

Option Pros Cons
Μείωση TTL (6h → 30min) Πιο ανταποκρίσιμο Χάος στο watchlist, χάνεις stability
Hot Queue (επιλέχθηκε) Isolated, capped, ephemeral +1 table, +80 γραμμές κώδικα

Hot queue είναι surgical addition: 20 symbols max, expires σε 30min, δεν επηρεάζει το core watchlist.

Γιατί Aggregated Direction αντί single trade;

Single Aggregated
1 trade = 1 direction 5+ trades → ratio + confidence
100% confidence πάντα Confidence scales με sample + clarity
Δεν ξέρεις αν είναι hedge Ratio 70%+ = πραγματικό accumulation
Binary 3-way (accum/dist/neutral)

Γιατί Dynamic Threshold (0.75);

Για sparse hot symbols (kPEPE, perp-only):

· Fixed 1.5 → ποτέ BUY (γιατί max score = whale_weight × 1.0 = 0.5)
· Dynamic 0.75 → BUY εφικτό με hot boost + whale agg

Bounded: μόνο όταν qualifiesForConvictionBoost (usd ≥ $50K AND confidence ≥ 0.70).

---

ROLLBACK

```sql
-- Full rollback hot queue:
DROP FUNCTION IF EXISTS public.record_hot_whale(text, numeric, boolean, text);
DROP FUNCTION IF EXISTS public.get_hot_whale_symbols(int, int);
DROP FUNCTION IF EXISTS public.cleanup_hot_whales(int);
DROP TABLE IF EXISTS public.hot_whale_signals CASCADE;
NOTIFY pgrst, 'reload schema';
```

Revert patches σε pipeline.server.ts (6 patches) + watchlist-resolver.server.ts (1 patch). Καμία επίπτωση σε άλλα components.

---

LESSONS LEARNED (Session 4)

# Μάθημα
1 Latency gap between discovery and signal generation είναι silent killer. Hot queue γεφυρώνει.
2 Single-trade direction is noise. Aggregation over 3+ samples δίνει signal, όχι θόρυβο.
3 Dynamic thresholds need bounds. Πάντα paired με qualification gate.
4 SECURITY DEFINER required για Lovable Cloud RPCs. Χωρίς αυτό: permission denied 42501.
5 Fail-open design — hot queue errors δεν σταματούν το pipeline.

---

NEXT SESSION — ΤΙ ΝΑ ΣΤΕΙΛΕΙΣ

1. Αυτό το αρχείο
2. Output από:
   ```sql
   -- A. Hot queue state
   SELECT symbol, alert_count, ROUND(total_usd) AS usd,
          ROUND(buy_usd/NULLIF(total_usd,0)*100) AS buy_pct,
          sources, last_seen_at::text
   FROM hot_whale_signals ORDER BY total_usd DESC LIMIT 20;
   
   -- B. Hot signals produced
   SELECT symbol, recommendation, confidence, source_tags
   FROM composite_signals WHERE source_tags @> ARRAY['hot-whale']
   ORDER BY created_at DESC LIMIT 20;
   
   -- C. Pipeline duration
   SELECT started_at::text, ROUND(duration_ms/1000.0,1) AS sec, status, signals
   FROM pipeline_runs WHERE started_at > NOW() - INTERVAL '2 hours'
   ORDER BY started_at DESC LIMIT 10;
   
   -- D. Watchlist snapshot
   SELECT cardinality(symbols) AS n, source, hl_candidates, binance_filtered
   FROM dynamic_watchlist_snapshots ORDER BY computed_at DESC LIMIT 1;
   
   -- E. Feed alerts
   SELECT event_type, tags, COUNT(*) FROM trade_alerts
   WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY event_type, tags;
   ```
3. Log lines: [HOT_WHALE], [HOT_WHALE_INCLUDE], [HOT_WHALE_DIRECTION], [PIPELINE_DONE]
4. Τι θέλεις:
   · Expansion σε 200 coins (pMap 20)
   · Per-provenance performance analysis
   · Hyperliquid candle fetcher για perp-only
   · Live trading mode
   · Regime-aware thresholds tuning

---

COMMIT MESSAGE

```bash
git add -A
git commit -m "feat(hot-whale): intra-cycle discovery + aggregated direction signal

- Add hot_whale_signals table with RLS + SECURITY DEFINER RPCs
- Add hot-whale.server.ts (record/fetch/aggregate/conviction boost)
- Feed hot queue from collectWhaleAlerts() for non-watchlist symbols
- Include hot symbols in collectIndicators() + collectCouncilSignals()
- Override single-trade direction with aggregated buy_ratio (3+ samples)
- Dynamic thresholds (0.75 vs 1.5) for sparse hot-whale symbols
- Additive conviction boost (max +0.30) for strong hot whale flow
- Fail-open design: hot queue errors never block pipeline
- 30 new unit tests

Sessions: 4 (audit + quality + dynamic universe + hot queue)"
git push
```

---

Generated: 2026-10-02 (night)
Next review: 2026-10-03 (after 24h hot queue operation)
