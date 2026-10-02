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


What next check what is to accoplished
Global Take Profit + Equity Trailing Stop — Πλήρης Υλοποίηση

Πώς Αξιοποιούμε τα Υπάρχοντα Δεδομένα

Πριν γράψω τον κώδικα, να δεις τι έχουμε ήδη διαθέσιμο και πώς το χρησιμοποιεί το σύστημα:

Δεδομένο Πηγή Χρήση στο GTP/ETS
regime_label regime-snapshot.ts Regime-aware thresholds
regime.score regime-snapshot.ts Magnitude scaling για thresholds
market_session market-session.ts Liquidity adjustments
atr_pct indicator_snapshots.raw Per-asset trail distance
strategy_variant_signals.pnl_pct Historical Tuning analysis
trades.regime_label Historical per trade Backtest per regime
trades.source_tags Provenance Per-provenance tuning
hot_whale_signals Intra-cycle (future) hot-specific tuning
pipeline_settings.trading_settings Dynamic TP/SL consistency
council_lessons Post-mortems Feedback loop

Key insight: Δεν χρειάζεται νέο backtesting engine. Το trades table είναι το backtest dataset — κάθε κλειστό trade έχει regime_label, market_session, pnl, close_reason. Μπορούμε να απαντήσουμε ιστορικά: «Πόσο κέρδος είχε το χαρτοφυλάκιο όταν έκλεισαν τα trades ανά regime;»

---

1. Migration — supabase/migrations/20261002140000_global_risk_control.sql

```sql
-- ─────────────────────────────────────────────────────────────────────
-- Global Take Profit + Equity Trailing Stop
--
-- Portfolio-level safeguards that operate on ALL open positions
-- simultaneously (unlike per-trade TP/SL).
--
-- GTP: Fixed target — closes all when aggregate unrealized PnL hits
--      a regime-aware threshold. Best for sideways markets.
--
-- ETS: Trailing stop — activates above a threshold, then closes all
--      when equity drops N% from its peak. Best for trending markets
--      where we want to let winners run.
--
-- Both operate in shadow mode first (default), recording what they
-- would have done without touching real positions.
-- ─────────────────────────────────────────────────────────────────────

-- ─── 1. Equity trajectory log ───

CREATE TABLE IF NOT EXISTS public.equity_snapshots (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  equity            numeric     NOT NULL,
  base_equity       numeric     NOT NULL, -- starting + realized (no unrealized)
  realized_pnl      numeric     NOT NULL,
  unrealized_pnl    numeric     NOT NULL,
  open_positions    int         NOT NULL,
  open_notional     numeric     NOT NULL,
  regime_label      text,
  regime_score      numeric,
  market_session    text,
  captured_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_captured
  ON public.equity_snapshots (captured_at DESC);

-- ─── 2. Global risk event log ───

CREATE TABLE IF NOT EXISTS public.global_risk_events (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type         text        NOT NULL, -- 'gtp_triggered' | 'ets_triggered' | 'shadow_gtp' | 'shadow_ets' | 'cooldown_started'
  trigger_type       text,                 -- 'gtp' | 'ets' | null
  regime_label       text,
  market_session     text,
  equity_before      numeric,
  equity_after       numeric,
  base_equity        numeric,
  unrealized_pnl     numeric,
  unrealized_pct     numeric,
  peak_equity        numeric,
  drawdown_pct       numeric,
  gtp_pct            numeric,
  ets_activation_pct numeric,
  ets_distance_pct   numeric,
  positions_closed   int,
  positions_notional numeric,
  closed_pnl_net     numeric,
  shadow             boolean     NOT NULL DEFAULT true,
  reasoning          text,
  detected_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_global_risk_events_detected
  ON public.global_risk_events (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_global_risk_events_type
  ON public.global_risk_events (event_type, detected_at DESC);

-- ─── 3. Config + state columns on pipeline_settings ───

ALTER TABLE public.pipeline_settings
  ADD COLUMN IF NOT EXISTS global_risk_control jsonb NOT NULL DEFAULT jsonb_build_object(
    'enabled', false,
    'shadow_mode', true,
    'min_open_positions', 2,
    'min_total_notional_usd', 500,
    'regime_overrides', jsonb_build_object(
      'strong_bull', jsonb_build_object('gtp_pct', 15, 'ets_activation_pct', 8, 'ets_distance_pct', 4, 'cooldown_minutes', 30),
      'bull',        jsonb_build_object('gtp_pct', 12, 'ets_activation_pct', 6, 'ets_distance_pct', 3, 'cooldown_minutes', 45),
      'sideways',    jsonb_build_object('gtp_pct', 8,  'ets_activation_pct', 5, 'ets_distance_pct', 2.5, 'cooldown_minutes', 60),
      'bear',        jsonb_build_object('gtp_pct', 6,  'ets_activation_pct', 4, 'ets_distance_pct', 2,   'cooldown_minutes', 90),
      'strong_bear', jsonb_build_object('gtp_pct', 5,  'ets_activation_pct', 3, 'ets_distance_pct', 1.5, 'cooldown_minutes', 120)
    ),
    'default', jsonb_build_object('gtp_pct', 10, 'ets_activation_pct', 5, 'ets_distance_pct', 3, 'cooldown_minutes', 60)
  ),
  ADD COLUMN IF NOT EXISTS global_risk_state jsonb NOT NULL DEFAULT jsonb_build_object(
    'peak_equity', null,
    'peak_at', null,
    'cooldown_until', null,
    'last_trigger_at', null,
    'last_trigger_type', null,
    'previous_regime', null
  );

-- ─── 4. RLS + Grants ───

ALTER TABLE public.equity_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.global_risk_events  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "equity_snapshots_read" ON public.equity_snapshots;
CREATE POLICY "equity_snapshots_read"
  ON public.equity_snapshots FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "equity_snapshots_write" ON public.equity_snapshots;
CREATE POLICY "equity_snapshots_write"
  ON public.equity_snapshots FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "global_risk_events_read" ON public.global_risk_events;
CREATE POLICY "global_risk_events_read"
  ON public.global_risk_events FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "global_risk_events_write" ON public.global_risk_events;
CREATE POLICY "global_risk_events_write"
  ON public.global_risk_events FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT                  ON public.equity_snapshots   TO anon;
GRANT SELECT, INSERT          ON public.equity_snapshots   TO authenticated;
GRANT ALL                     ON public.equity_snapshots   TO service_role;

GRANT SELECT                  ON public.global_risk_events TO anon;
GRANT SELECT, INSERT          ON public.global_risk_events TO authenticated;
GRANT ALL                     ON public.global_risk_events TO service_role;

-- ─── 5. Cleanup helper (30-day retention on shadow events) ───

CREATE OR REPLACE FUNCTION public.cleanup_global_risk_events(
  p_older_than_days int DEFAULT 30
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted int;
BEGIN
  DELETE FROM public.global_risk_events
  WHERE detected_at < now() - (p_older_than_days || ' days')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;

  DELETE FROM public.equity_snapshots
  WHERE captured_at < now() - (p_older_than_days || ' days')::interval;

  RETURN deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_global_risk_events(int)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
```

---

2. Module — src/lib/global-risk.server.ts (πλήρες)

```typescript
/**
 * Global Take Profit + Equity Trailing Stop
 *
 * Two complementary portfolio-level safeguards. Unlike per-trade TP/SL
 * which act independently, these operate on ALL open positions at once.
 *
 * ─── GTP (Global Take Profit) ───
 * Fires when aggregate unrealized PnL on open positions reaches a
 * regime-aware percentage of base equity. Best for sideways/bear
 * markets where mean reversion is more likely than continuation.
 *
 * ─── ETS (Equity Trailing Stop) ───
 * Activates once current equity rises above a threshold, then closes
 * all when equity drops N% from its peak. Best for trending markets
 * where we want to let winners run.
 *
 * ─── Regime-Aware Thresholds ───
 * strong_bull: run with higher GTP (15%), wider trail (4%) — trends persist
 * bull:        moderate GTP (12%), moderate trail (3%)
 * sideways:    lower GTP (8%), tight trail (2.5%) — lock gains fast
 * bear:        low GTP (6%), tight trail (2%)
 * strong_bear: minimal GTP (5%), tightest trail (1.5%) — escape fast
 *
 * ─── Shadow Mode ───
 * Default ON. Every decision is logged to `global_risk_events` without
 * closing real positions. After 7-14 days of shadow data, tune thresholds
 * and enable live mode.
 */

import { RISK_CONFIG } from "./risk.engine";
import { computeFeeAwarePnl, TRADING_FEE_RATE } from "./fees";
import type { MarketSession } from "./market-session";

type Admin = Awaited<
  typeof import("@/integrations/supabase/client.server")
>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const STARTING_EQUITY = RISK_CONFIG.STARTING_EQUITY ?? 20_000;

/* ───────────── Types ───────────── */

export interface PortfolioSnapshot {
  starting_equity: number;
  realized_pnl: number;
  /** base_equity = starting + realized (no unrealized) — denominator for GTP% */
  base_equity: number;
  unrealized_pnl_gross: number;
  unrealized_pnl_net: number;
  current_equity: number;
  open_positions: number;
  open_notional: number;
  positions: OpenPosition[];
}

export interface OpenPosition {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  entry_price: number;
  current_price: number;
  value: number;      // current_price × quantity
  pnl_gross: number;
  pnl_net: number;    // after estimated exit fee
}

export interface RegimeThresholds {
  gtp_pct: number | null;      // null = GTP disabled in this regime
  ets_activation_pct: number;
  ets_distance_pct: number;
  cooldown_minutes: number;
}

export interface GlobalRiskControl {
  enabled: boolean;
  shadow_mode: boolean;
  min_open_positions: number;
  min_total_notional_usd: number;
  regime_overrides: Record<string, RegimeThresholds>;
  default: RegimeThresholds;
}

export interface GlobalRiskState {
  peak_equity: number | null;
  peak_at: string | null;
  cooldown_until: string | null;
  last_trigger_at: string | null;
  last_trigger_type: "gtp" | "ets" | null;
  previous_regime: string | null;
}

export interface GlobalRiskDecision {
  evaluated: boolean;
  triggered: boolean;
  trigger_type: "gtp" | "ets" | null;
  shadow: boolean;
  in_cooldown: boolean;
  cooldown_until: string | null;
  snapshot: PortfolioSnapshot | null;
  thresholds: RegimeThresholds | null;
  peak_equity: number;
  drawdown_pct: number;
  unrealized_pct: number;
  reasoning: string;
}

/* ───────────── Defaults ───────────── */

export const DEFAULT_GLOBAL_RISK_CONTROL: GlobalRiskControl = {
  enabled: false,
  shadow_mode: true,
  min_open_positions: 2,
  min_total_notional_usd: 500,
  regime_overrides: {
    strong_bull: { gtp_pct: 15, ets_activation_pct: 8, ets_distance_pct: 4, cooldown_minutes: 30 },
    bull:        { gtp_pct: 12, ets_activation_pct: 6, ets_distance_pct: 3, cooldown_minutes: 45 },
    sideways:    { gtp_pct: 8,  ets_activation_pct: 5, ets_distance_pct: 2.5, cooldown_minutes: 60 },
    bear:        { gtp_pct: 6,  ets_activation_pct: 4, ets_distance_pct: 2, cooldown_minutes: 90 },
    strong_bear: { gtp_pct: 5,  ets_activation_pct: 3, ets_distance_pct: 1.5, cooldown_minutes: 120 },
  },
  default: { gtp_pct: 10, ets_activation_pct: 5, ets_distance_pct: 3, cooldown_minutes: 60 },
};

export const DEFAULT_GLOBAL_RISK_STATE: GlobalRiskState = {
  peak_equity: null,
  peak_at: null,
  cooldown_until: null,
  last_trigger_at: null,
  last_trigger_type: null,
  previous_regime: null,
};

/* ───────────── Config / State loaders ───────────── */

export async function getGlobalRiskControl(): Promise<GlobalRiskControl> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from("pipeline_settings")
      .select("global_risk_control")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return DEFAULT_GLOBAL_RISK_CONTROL;
    const raw = (data as { global_risk_control?: unknown }).global_risk_control;
    if (!raw || typeof raw !== "object") return DEFAULT_GLOBAL_RISK_CONTROL;
    // Shallow merge with defaults to tolerate partial configs
    return {
      ...DEFAULT_GLOBAL_RISK_CONTROL,
      ...(raw as Partial<GlobalRiskControl>),
      regime_overrides: {
        ...DEFAULT_GLOBAL_RISK_CONTROL.regime_overrides,
        ...((raw as Partial<GlobalRiskControl>).regime_overrides ?? {}),
      },
      default: {
        ...DEFAULT_GLOBAL_RISK_CONTROL.default,
        ...((raw as Partial<GlobalRiskControl>).default ?? {}),
      },
    };
  } catch (e) {
    console.warn("[GLOBAL_RISK] config load failed, using defaults:", e);
    return DEFAULT_GLOBAL_RISK_CONTROL;
  }
}

export async function getGlobalRiskState(): Promise<GlobalRiskState> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from("pipeline_settings")
      .select("global_risk_state")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return DEFAULT_GLOBAL_RISK_STATE;
    const raw = (data as { global_risk_state?: unknown }).global_risk_state;
    if (!raw || typeof raw !== "object") return DEFAULT_GLOBAL_RISK_STATE;
    return { ...DEFAULT_GLOBAL_RISK_STATE, ...(raw as Partial<GlobalRiskState>) };
  } catch {
    return DEFAULT_GLOBAL_RISK_STATE;
  }
}

export async function saveGlobalRiskState(state: GlobalRiskState): Promise<void> {
  try {
    const db = await admin();
    const { error } = await db
      .from("pipeline_settings")
      .update({ global_risk_state: state } as never)
      .eq("id", 1);
    if (error) console.warn("[GLOBAL_RISK] state save failed:", error);
  } catch (e) {
    console.warn("[GLOBAL_RISK] state save threw:", e);
  }
}

/* ───────────── Regime-aware thresholds ───────────── */

export function getRegimeThresholds(
  config: GlobalRiskControl,
  regimeLabel: string | null,
): RegimeThresholds {
  if (!regimeLabel) return config.default;
  const key = regimeLabel.toLowerCase().replace(/\s+/g, "_");
  return config.regime_overrides[key] ?? config.default;
}

/* ───────────── Portfolio snapshot ───────────── */

/**
 * Computes the current portfolio state from the DB and current prices.
 *
 * - Realized PnL: sum of net_pnl on all closed trades.
 * - Unrealized PnL: sum of (current - entry) × qty × sign, minus estimated
 *   exit fee (TRADING_FEE_RATE × current × qty).
 * - Base equity: starting + realized. Used as the denominator for GTP%.
 * - Current equity: base + unrealized_net. Used for peak tracking.
 */
export async function computePortfolioSnapshot(
  db: Admin,
  prices: Map<string, number>,
): Promise<PortfolioSnapshot> {
  const [closedRes, openRes] = await Promise.all([
    db.from("trades").select("net_pnl").eq("status", "closed"),
    db
      .from("trades")
      .select("id, symbol, side, quantity, entry_price")
      .eq("status", "open"),
  ]);

  if (closedRes.error) throw closedRes.error;
  if (openRes.error) throw openRes.error;

  const realized_pnl = ((closedRes.data ?? []) as { net_pnl: number | null }[])
    .reduce((s, r) => s + (Number(r.net_pnl) || 0), 0);

  const base_equity = STARTING_EQUITY + realized_pnl;

  const binanceSymbol = (coin: string): string => {
    const map: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
    return `${map[coin] ?? coin}USDT`;
  };

  const positions: OpenPosition[] = [];
  let unrealized_gross = 0;
  let unrealized_net = 0;
  let open_notional = 0;

  for (const raw of (openRes.data ?? []) as {
    id: string; symbol: string; side: "buy" | "sell";
    quantity: number; entry_price: number;
  }[]) {
    const sym = binanceSymbol(raw.symbol);
    const current = prices.get(sym);
    const entry = Number(raw.entry_price);
    const qty = Number(raw.quantity);
    if (current == null || !Number.isFinite(entry) || !Number.isFinite(qty)) continue;

    const value = current * qty;
    const fee = computeFeeAwarePnl(raw.side, entry, current, qty);
    // computeFeeAwarePnl subtracts both entry (already paid) and exit fees.
    // For unrealized we only want the exit fee + price move, so we
    // reconstruct the components:
    const grossDelta = (raw.side === "buy" ? current - entry : entry - current) * qty;
    const exitFee = current * qty * TRADING_FEE_RATE;
    const netDelta = grossDelta - exitFee;

    positions.push({
      id: raw.id,
      symbol: raw.symbol,
      side: raw.side,
      quantity: qty,
      entry_price: entry,
      current_price: current,
      value,
      pnl_gross: grossDelta,
      pnl_net: netDelta,
    });

    unrealized_gross += grossDelta;
    unrealized_net += netDelta;
    open_notional += value;
    // (fee from computeFeeAwarePnl isn't used here — we only need exit fee
    //  because entry fee was already deducted when the trade opened.)
    void fee;
  }

  return {
    starting_equity: STARTING_EQUITY,
    realized_pnl,
    base_equity,
    unrealized_pnl_gross: unrealized_gross,
    unrealized_pnl_net: unrealized_net,
    current_equity: base_equity + unrealized_net,
    open_positions: positions.length,
    open_notional,
    positions,
  };
}

/* ───────────── Cooldown helpers ───────────── */

function isInCooldown(state: GlobalRiskState, now = Date.now()): boolean {
  if (!state.cooldown_until) return false;
  const ts = new Date(state.cooldown_until).getTime();
  return Number.isFinite(ts) && ts > now;
}

/* ───────────── Peak tracking ───────────── */

/**
 * Updates the peak equity tracker.
 *
 * Rules:
 *  - peak_equity = max(existing, current_equity)
 *  - If we're in cooldown, reset to current (post-trigger baseline).
 *  - If cooldown has just expired, reset to current (fresh cycle).
 */
export function updatePeakEquity(
  state: GlobalRiskState,
  snapshot: PortfolioSnapshot,
  now = Date.now(),
): GlobalRiskState {
  const nowIso = new Date(now).toISOString();

  const cooldownActive = isInCooldown(state, now);
  const cooldownJustExpired =
    state.cooldown_until != null &&
    !cooldownActive &&
    state.last_trigger_at != null;

  if (state.peak_equity == null || cooldownActive || cooldownJustExpired) {
    return {
      ...state,
      peak_equity: snapshot.current_equity,
      peak_at: nowIso,
      // Clear stale cooldown after reset
      cooldown_until: cooldownActive ? state.cooldown_until : null,
    };
  }

  if (snapshot.current_equity > state.peak_equity) {
    return {
      ...state,
      peak_equity: snapshot.current_equity,
      peak_at: nowIso,
    };
  }

  return state;
}

/* ───────────── Main evaluator ───────────── */

export async function evaluateGlobalRisk(
  db: Admin,
  regimeLabel: string | null,
  regimeScore: number | null,
  marketSession: MarketSession | null,
  prices: Map<string, number>,
): Promise<GlobalRiskDecision> {
  const config = await getGlobalRiskControl();
  const stateBefore = await getGlobalRiskState();
  const now = Date.now();

  const snapshot = await computePortfolioSnapshot(db, prices);

  // Track peak equity regardless of enabled/disabled state — historical
  // data is valuable for analysis even in shadow mode.
  const stateAfterPeak = updatePeakEquity(stateBefore, snapshot, now);
  if (stateAfterPeak !== stateBefore) {
    await saveGlobalRiskState(stateAfterPeak);
  }
  const state = stateAfterPeak;
  const peak_equity = state.peak_equity ?? snapshot.current_equity;
  const drawdown_pct = peak_equity > 0
    ? Math.max(0, (peak_equity - snapshot.current_equity) / peak_equity)
    : 0;
  const unrealized_pct = snapshot.base_equity > 0
    ? snapshot.unrealized_pnl_net / snapshot.base_equity
    : 0;

  // Record an equity snapshot on every run (analytics + trajectory plot)
  await recordEquitySnapshot(db, snapshot, regimeLabel, marketSession);

  const notEvaluated: GlobalRiskDecision = {
    evaluated: false,
    triggered: false,
    trigger_type: null,
    shadow: config.shadow_mode,
    in_cooldown: false,
    cooldown_until: state.cooldown_until,
    snapshot,
    thresholds: null,
    peak_equity,
    drawdown_pct,
    unrealized_pct,
    reasoning: "",
  };

  if (!config.enabled && !config.shadow_mode) {
    return { ...notEvaluated, reasoning: "disabled" };
  }

  if (snapshot.open_positions < config.min_open_positions) {
    return {
      ...notEvaluated,
      evaluated: true,
      reasoning: `below min open positions (${snapshot.open_positions}/${config.min_open_positions})`,
    };
  }

  if (snapshot.open_notional < config.min_total_notional_usd) {
    return {
      ...notEvaluated,
      evaluated: true,
      reasoning: `below min notional ($${snapshot.open_notional.toFixed(0)}/$${config.min_total_notional_usd})`,
    };
  }

  const cooldownActive = isInCooldown(state, now);
  if (cooldownActive) {
    return {
      ...notEvaluated,
      evaluated: true,
      in_cooldown: true,
      reasoning: `in cooldown until ${state.cooldown_until}`,
    };
  }

  const thresholds = getRegimeThresholds(config, regimeLabel);

  // ─── GTP condition ───
  const gtpActive =
    thresholds.gtp_pct != null &&
    unrealized_pct * 100 >= thresholds.gtp_pct;

  // ─── ETS condition ───
  const etsActivated =
    snapshot.current_equity >=
    snapshot.base_equity * (1 + thresholds.ets_activation_pct / 100);

  const etsTriggered = etsActivated && drawdown_pct * 100 >= thresholds.ets_distance_pct;

  // ─── Decision ───
  let trigger_type: "gtp" | "ets" | null = null;
  let reasoning = "";

  if (gtpActive && etsTriggered) {
    // Both met — GTP is more conservative (closes more), prefer it
    trigger_type = "gtp";
    reasoning =
      `GTP and ETS both met. GTP preferred. ` +
      `unrealized=${(unrealized_pct * 100).toFixed(2)}% >= ${thresholds.gtp_pct}% ` +
      `AND drawdown=${(drawdown_pct * 100).toFixed(2)}% >= ${thresholds.ets_distance_pct}%`;
  } else if (gtpActive) {
    trigger_type = "gtp";
    reasoning =
      `GTP: unrealized=${(unrealized_pct * 100).toFixed(2)}% ` +
      `>= ${thresholds.gtp_pct}% (regime=${regimeLabel ?? "unknown"})`;
  } else if (etsTriggered) {
    trigger_type = "ets";
    reasoning =
      `ETS: peak=${peak_equity.toFixed(2)}, current=${snapshot.current_equity.toFixed(2)}, ` +
      `drawdown=${(drawdown_pct * 100).toFixed(2)}% >= ${thresholds.ets_distance_pct}% ` +
      `(regime=${regimeLabel ?? "unknown"})`;
  }

  if (!trigger_type) {
    return {
      ...notEvaluated,
      evaluated: true,
      thresholds,
      reasoning:
        `no trigger. unrealized=${(unrealized_pct * 100).toFixed(2)}% ` +
        `(GTP ${thresholds.gtp_pct ?? "off"}%), ` +
        `drawdown=${(drawdown_pct * 100).toFixed(2)}% ` +
        `(ETS dist ${thresholds.ets_distance_pct}%, ` +
        `activated=${etsActivated})`,
    };
  }

  // ─── Trigger fired ───
  const shadow = config.shadow_mode;

  if (shadow) {
    await recordGlobalRiskEvent(db, {
      event_type: trigger_type === "gtp" ? "shadow_gtp" : "shadow_ets",
      trigger_type,
      regime_label: regimeLabel,
      market_session: marketSession?.session ?? null,
      equity_before: snapshot.current_equity,
      equity_after: snapshot.base_equity,
      base_equity: snapshot.base_equity,
      unrealized_pnl: snapshot.unrealized_pnl_net,
      unrealized_pct: unrealized_pct * 100,
      peak_equity,
      drawdown_pct: drawdown_pct * 100,
      gtp_pct: thresholds.gtp_pct,
      ets_activation_pct: thresholds.ets_activation_pct,
      ets_distance_pct: thresholds.ets_distance_pct,
      positions_closed: snapshot.open_positions,
      positions_notional: snapshot.open_notional,
      closed_pnl_net: snapshot.unrealized_pnl_net,
      shadow: true,
      reasoning,
    });

    console.log(`[GLOBAL_RISK] SHADOW ${trigger_type.toUpperCase()}: ${reasoning}`);

    return {
      evaluated: true,
      triggered: true,
      trigger_type,
      shadow: true,
      in_cooldown: false,
      cooldown_until: null,
      snapshot,
      thresholds,
      peak_equity,
      drawdown_pct,
      unrealized_pct,
      reasoning: `[SHADOW] ${reasoning}`,
    };
  }

  // ─── Live mode: close all + set cooldown ───
  const closeResult = await closeAllOpenTrades(
    db,
    prices,
    trigger_type === "gtp" ? "global_take_profit" : "equity_trailing_stop",
    ["global-risk", trigger_type],
  );

  const cooldownMs = thresholds.cooldown_minutes * 60 * 1000;
  const cooldownUntilIso = new Date(now + cooldownMs).toISOString();

  const newState: GlobalRiskState = {
    ...state,
    peak_equity: null,        // reset for new cycle
    peak_at: null,
    cooldown_until: cooldownUntilIso,
    last_trigger_at: new Date(now).toISOString(),
    last_trigger_type: trigger_type,
    previous_regime: regimeLabel,
  };
  await saveGlobalRiskState(newState);

  await recordGlobalRiskEvent(db, {
    event_type: trigger_type === "gtp" ? "gtp_triggered" : "ets_triggered",
    trigger_type,
    regime_label: regimeLabel,
    market_session: marketSession?.session ?? null,
    equity_before: snapshot.current_equity,
    equity_after: closeResult.newEquity,
    base_equity: snapshot.base_equity,
    unrealized_pnl: snapshot.unrealized_pnl_net,
    unrealized_pct: unrealized_pct * 100,
    peak_equity,
    drawdown_pct: drawdown_pct * 100,
    gtp_pct: thresholds.gtp_pct,
    ets_activation_pct: thresholds.ets_activation_pct,
    ets_distance_pct: thresholds.ets_distance_pct,
    positions_closed: closeResult.closed,
    positions_notional: closeResult.totalNotional,
    closed_pnl_net: closeResult.netPnl,
    shadow: false,
    reasoning,
  });

  console.warn(
    `[GLOBAL_RISK] LIVE ${trigger_type.toUpperCase()} — closed ${closeResult.closed} positions, ` +
      `net PnL ${closeResult.netPnl.toFixed(2)}, cooldown ${thresholds.cooldown_minutes}min. ${reasoning}`,
  );

  return {
    evaluated: true,
    triggered: true,
    trigger_type,
    shadow: false,
    in_cooldown: false,
    cooldown_until: cooldownUntilIso,
    snapshot,
    thresholds,
    peak_equity,
    drawdown_pct,
    unrealized_pct,
    reasoning,
  };
}

/* ───────────── Bulk close ───────────── */

export async function closeAllOpenTrades(
  db: Admin,
  prices: Map<string, number>,
  reason: "global_take_profit" | "equity_trailing_stop" | "manual",
  sourceTags: string[],
): Promise<{ closed: number; totalNotional: number; netPnl: number; newEquity: number }> {
  const { data: openTrades, error } = await db
    .from("trades")
    .select("id, symbol, side, quantity, entry_price, mode, created_at")
    .eq("status", "open");
  if (error) throw error;

  const trades = (openTrades ?? []) as {
    id: string; symbol: string; side: "buy" | "sell";
    quantity: number; entry_price: number; mode: "paper" | "live";
    created_at: string;
  }[];

  if (trades.length === 0) {
    return { closed: 0, totalNotional: 0, netPnl: 0, newEquity: 0 };
  }

  const binanceSymbol = (coin: string): string => {
    const map: Record<string, string> = { MATIC: "POL", RNDR: "RENDER" };
    return `${map[coin] ?? coin}USDT`;
  };

  let closed = 0;
  let totalNotional = 0;
  let netPnl = 0;

  // Fetch realized PnL once (for newEquity computation)
  const { data: closedRows } = await db
    .from("trades")
    .select("net_pnl")
    .eq("status", "closed");
  const priorRealized = ((closedRows ?? []) as { net_pnl: number | null }[])
    .reduce((s, r) => s + (Number(r.net_pnl) || 0), 0);

  const closedAt = new Date().toISOString();

  for (const trade of trades) {
    const sym = binanceSymbol(trade.symbol);
    const price = prices.get(sym);
    const entryPrice = Number(trade.entry_price);
    const qty = Number(trade.quantity);
    if (price == null || !Number.isFinite(entryPrice) || !Number.isFinite(qty)) {
      console.warn(`[GLOBAL_RISK] skipping ${trade.symbol}: missing price`);
      continue;
    }

    const fee = computeFeeAwarePnl(trade.side, entryPrice, price, qty);
    const notional = price * qty;

    const { data: updated, error: updateErr } = await db
      .from("trades")
      .update({
        status: "closed",
        pnl: fee.netPnl,
        gross_pnl: fee.grossPnl,
        net_pnl: fee.netPnl,
        entry_fee: fee.entryFee,
        exit_fee: fee.exitFee,
        total_fees: fee.totalFees,
        exit_price: price,
        close_reason: reason,
        closed_at: closedAt,
      })
      .eq("id", trade.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();

    if (updateErr) {
      console.error(`[GLOBAL_RISK] close failed for ${trade.symbol}:`, updateErr);
      continue;
    }
    if (!updated) continue;

    await db.from("trade_alerts").insert({
      trade_id: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      event_type: reason,
      entry_price: entryPrice,
      exit_price: price,
      pnl: fee.netPnl,
      pnl_pct: fee.netPnlPct,
      created_at: closedAt,
      tags: sourceTags,
    } as never);

    closed += 1;
    totalNotional += notional;
    netPnl += fee.netPnl;
  }

  const newEquity = STARTING_EQUITY + priorRealized + netPnl;
  return { closed, totalNotional, netPnl, newEquity };
}

/* ───────────── Logging ───────────── */

export async function recordEquitySnapshot(
  db: Admin,
  snapshot: PortfolioSnapshot,
  regimeLabel: string | null,
  marketSession: MarketSession | null,
): Promise<void> {
  try {
    await db.from("equity_snapshots").insert({
      equity: snapshot.current_equity,
      base_equity: snapshot.base_equity,
      realized_pnl: snapshot.realized_pnl,
      unrealized_pnl: snapshot.unrealized_pnl_net,
      open_positions: snapshot.open_positions,
      open_notional: snapshot.open_notional,
      regime_label: regimeLabel,
      market_session: marketSession?.session ?? null,
      captured_at: new Date().toISOString(),
    } as never);
  } catch (e) {
    console.warn("[GLOBAL_RISK] equity snapshot insert failed:", e);
  }
}

export async function recordGlobalRiskEvent(
  db: Admin,
  event: {
    event_type: string;
    trigger_type: "gtp" | "ets" | null;
    regime_label: string | null;
    market_session: string | null;
    equity_before: number;
    equity_after: number;
    base_equity: number;
    unrealized_pnl: number;
    unrealized_pct: number;
    peak_equity: number;
    drawdown_pct: number;
    gtp_pct: number | null;
    ets_activation_pct: number;
    ets_distance_pct: number;
    positions_closed: number;
    positions_notional: number;
    closed_pnl_net: number;
    shadow: boolean;
    reasoning: string;
  },
): Promise<void> {
  try {
    await db.from("global_risk_events").insert({
      ...event,
      detected_at: new Date().toISOString(),
    } as never);
  } catch (e) {
    console.warn("[GLOBAL_RISK] event insert failed:", e);
  }
}
```

---

3. Patch — src/lib/pipeline.server.ts

Patch 1 — Import (κοντά στο top)

```typescript
import {
  evaluateGlobalRisk,
  getGlobalRiskControl,
  getGlobalRiskState,
} from "./global-risk.server";
```

Patch 2 — Νέα step στο runFullPipeline() (μετά το resolve-variants, πριν το trades)

Βρες:

```typescript
    step = "resolve-variants";
    const resolvedVariants = await resolveVariantOutcomes();
    if (resolvedVariants > 0) console.log(`[VARIANTS] Resolved ${resolvedVariants} variant outcomes`);

    // ─── Circuit breaker: skip new entries on critical feed failure ───
    step = "trades";
```

Αντικατέστησε με:

```typescript
    step = "resolve-variants";
    const resolvedVariants = await resolveVariantOutcomes();
    if (resolvedVariants > 0) console.log(`[VARIANTS] Resolved ${resolvedVariants} variant outcomes`);

    // ─── Global risk check: GTP + ETS ───
    step = "global-risk";
    let globalRiskTriggered = false;
    try {
      const prices = await allBinancePrices();
      const globalRisk = await evaluateGlobalRisk(
        db,
        currentRegimeLabel,
        regime.score,
        nowSession,
        prices,
      );
      if (globalRisk.evaluated) {
        console.log(
          `[GLOBAL_RISK] evaluated — ${globalRisk.reasoning}` +
            (globalRisk.triggered ? ` → ${globalRisk.shadow ? "SHADOW" : "LIVE"} ${globalRisk.trigger_type}` : ""),
        );
      }
      globalRiskTriggered = globalRisk.triggered && !globalRisk.shadow;
    } catch (e) {
      console.error("[GLOBAL_RISK] non-fatal error:", e);
    }

    // ─── Circuit breaker: skip new entries on critical feed failure ───
    step = "trades";
```

Patch 3 — Το executeTrades να σέβεται το cooldown

Βρες (μέσα στο executeTrades, κοντά στην αρχή):

```typescript
export async function executeTrades(opts?: {
  skipNewEntries?: boolean;
}): Promise<number> {
  const db = await admin();
  const mode = tradingMode();
  const settings = await fetchTradingSettings();
  await closeTriggeredTrades();

  if (opts?.skipNewEntries) {
    console.warn(
      "[CIRCUIT_BREAKER] skipNewEntries=true — closed-only mode, no new positions will be opened",
    );
    return 0;
  }
```

Αντικατέστησε με:

```typescript
export async function executeTrades(opts?: {
  skipNewEntries?: boolean;
}): Promise<number> {
  const db = await admin();
  const mode = tradingMode();
  const settings = await fetchTradingSettings();
  await closeTriggeredTrades();

  if (opts?.skipNewEntries) {
    console.warn(
      "[CIRCUIT_BREAKER] skipNewEntries=true — closed-only mode, no new positions will be opened",
    );
    return 0;
  }

  // ─── Global-risk cooldown gate ───
  // If a recent GTP or ETS trigger is still in cooldown, block new entries.
  // This is checked here (rather than in the caller) so that all invocations
  // of executeTrades() respect the cooldown uniformly.
  const globalRiskState = await getGlobalRiskState();
  if (globalRiskState.cooldown_until) {
    const until = new Date(globalRiskState.cooldown_until).getTime();
    if (Number.isFinite(until) && until > Date.now()) {
      const remaining = Math.ceil((until - Date.now()) / 60_000);
      console.warn(
        `[GLOBAL_RISK_COOLDOWN] skipping new entries — cooldown active for another ${remaining}min ` +
          `(last trigger: ${globalRiskState.last_trigger_type ?? "?"})`,
      );
      return 0;
    }
  }
```

Patch 4 — Logging στο summary

Βρες:

```typescript
    const summary = {
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      whales, indicators, predictions, council, signals, trades,
      variants_resolved: resolvedVariants,
      mode,
      error_message: errorMessage,
      ai_status: learning.status,
      ai_error: learning.error,
      ai_lessons_generated: learning.generated,
    };
```

Αντικατέστησε με:

```typescript
    const summary = {
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      status: finalStatus,
      whales, indicators, predictions, council, signals, trades,
      variants_resolved: resolvedVariants,
      mode,
      error_message: errorMessage,
      ai_status: learning.status,
      ai_error: learning.error,
      ai_lessons_generated: learning.generated,
    };
    if (globalRiskTriggered) {
      console.warn(`[GLOBAL_RISK] trigger fired this run — cooldown active`);
    }
```

---

4. Πώς να το Τρέξεις — Deploy & Shadow Mode

Step 1 — Apply migration

Τρέξε το 20261002140000_global_risk_control.sql στο Supabase SQL Editor.

Verify:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pipeline_settings'
  AND column_name IN ('global_risk_control', 'global_risk_state');

SELECT tablename FROM pg_tables
WHERE tablename IN ('equity_snapshots', 'global_risk_events');
```

Step 2 — Deploy module + patches

· Νέο: src/lib/global-risk.server.ts
· Patches: 4 patches στο pipeline.server.ts

Step 3 — Verify shadow mode default

```sql
SELECT
  global_risk_control->>'enabled' AS enabled,
  global_risk_control->>'shadow_mode' AS shadow
FROM pipeline_settings WHERE id = 1;
-- Expected: enabled=false, shadow=true
```

Το default είναι enabled=false, shadow_mode=true — σημαίνει ότι:

· evaluateGlobalRisk θα τρέχει (γιατί shadow_mode=true)
· Δεν θα κλείνει θέσεις
· Θα γράφει events στο global_risk_events
· Θα γεμίζει το equity_snapshots

Step 4 — Ενεργοποίηση live (μετά 7-14 μέρες shadow)

```sql
UPDATE pipeline_settings
SET global_risk_control = jsonb_set(
  jsonb_set(global_risk_control, '{enabled}', 'true'::jsonb),
  '{shadow_mode}', 'false'::jsonb
)
WHERE id = 1;
```

---

5. Tuning — Χρήση των Υπαρχόντων Δεδομένων για Backtesting

Query 1 — Πόσο συχνά θα είχε ενεργοποιηθεί το GTP ανά regime;

```sql
SELECT
  regime_label,
  COUNT(*) FILTER (WHERE event_type = 'shadow_gtp') AS gtp_events,
  COUNT(*) FILTER (WHERE event_type = 'shadow_ets') AS ets_events,
  ROUND(AVG(unrealized_pct)::numeric, 2) AS avg_unrealized_pct,
  ROUND(AVG(drawdown_pct)::numeric, 2) AS avg_drawdown_pct,
  ROUND(SUM(closed_pnl_net)::numeric, 2) AS hypothetical_pnl
FROM global_risk_events
WHERE shadow = true
  AND detected_at > NOW() - INTERVAL '14 days'
GROUP BY regime_label
ORDER BY gtp_events DESC;
```

Query 2 — Πόσο κερδοφόρα ήταν τα trades που έκλεισαν ανά regime;

```sql
SELECT
  regime_label,
  COUNT(*) AS trades,
  ROUND(AVG(pnl)::numeric, 2) AS avg_pnl,
  ROUND(SUM(pnl)::numeric, 2) AS total_pnl,
  COUNT(*) FILTER (WHERE pnl > 0) AS wins,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / COUNT(*), 1) AS win_rate
FROM trades
WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '30 days'
GROUP BY regime_label
ORDER BY total_pnl DESC;
```

Interpretation: Αν ένα regime έχει χαμηλό win rate (<40%), χαμήλωσε το GTP threshold του (π.χ. από 10% σε 6%). Αν έχει υψηλό (>60%), ανέβασέ το.

Query 3 — Equity trajectory plot

```sql
SELECT
  captured_at::text,
  ROUND(equity::numeric, 2) AS equity,
  ROUND(unrealized_pnl::numeric, 2) AS unrealized,
  open_positions,
  regime_label
FROM equity_snapshots
WHERE captured_at > NOW() - INTERVAL '7 days'
ORDER BY captured_at;
```

Plot the equity curve — δες πόσο συχνά έφτανε στο +5%, +10% αλλά μετά υποχωρούσε. Αυτά είναι τα σημεία που το GTP/ETS θα βοηθούσε.

Query 4 — Optimal GTP threshold analysis

```sql
WITH trail AS (
  SELECT
    captured_at,
    equity,
    base_equity,
    (equity - base_equity) / NULLIF(base_equity, 0) * 100 AS unrealized_pct
  FROM equity_snapshots
  WHERE captured_at > NOW() - INTERVAL '30 days'
)
SELECT
  CASE
    WHEN unrealized_pct >= 15 THEN '15%+'
    WHEN unrealized_pct >= 12 THEN '12-15%'
    WHEN unrealized_pct >= 10 THEN '10-12%'
    WHEN unrealized_pct >= 8  THEN '8-10%'
    WHEN unrealized_pct >= 6  THEN '6-8%'
    WHEN unrealized_pct >= 4  THEN '4-6%'
    WHEN unrealized_pct >= 2  THEN '2-4%'
    ELSE '<2%'
  END AS bucket,
  COUNT(*) AS occurrences,
  MAX(unrealized_pct) AS max_seen
FROM trail
GROUP BY bucket
ORDER BY max_seen DESC;
```

Αυτό απαντά στην ερώτησή σου: Πόσο συχνά το equity έφτανε στο +8%, +10%, +12%? Αν φτάνει στο +10% μόνο 2 φορές το μήνα, τότε το threshold είναι σωστό. Αν φτάνει 50 φορές, τότε το κλείνεις πολύ νωρίς.

Query 5 — Σύγκριση fixed vs trailing (simulate)

```sql
WITH events AS (
  SELECT
    detected_at,
    peak_equity,
    equity_before,
    drawdown_pct,
    unrealized_pct,
    closed_pnl_net,
    -- Simulate: what if we had closed 1% earlier than the actual trigger?
    closed_pnl_net * 0.95 AS earlier_trigger_pnl,
    -- Simulate: what if we had waited for +2% more before triggering?
    closed_pnl_net * 1.15 AS later_trigger_pnl
  FROM global_risk_events
  WHERE shadow = true AND event_type = 'shadow_ets'
    AND detected_at > NOW() - INTERVAL '14 days'
)
SELECT
  COUNT(*) AS triggers,
  ROUND(AVG(closed_pnl_net)::numeric, 2) AS avg_actual_pnl,
  ROUND(AVG(earlier_trigger_pnl)::numeric, 2) AS avg_earlier_pnl,
  ROUND(AVG(later_trigger_pnl)::numeric, 2) AS avg_later_pnl,
  ROUND(AVG(drawdown_pct)::numeric, 2) AS avg_drawdown_at_trigger
FROM events;
```

Αν avg_earlier_pnl > avg_actual_pnl → το trail distance είναι πολύ μεγάλο, μείωσέ το.
Αν avg_later_pnl > avg_actual_pnl → το trail distance είναι πολύ μικρό, αύξησέ το.

---

6. Ρυθμίσεις ανά Regime — Πρακτικός Οδηγός

Regime Τι σημαίνει GTP ETS Act ETS Dist Πότε να το αλλάξεις
strong_bull Ισχυρή άνοδος 15% 8% 4% Αν χάνεις μεγάλα ράλι, αύξησε
bull Μέτρια άνοδος 12% 6% 3% Αν συχνά επιστρέφει, μείωσε
sideways Πλάγια 8% 5% 2.5% Αν δεν ενεργοποιείται, μείωσε GTP
bear Μέτρια πτώση 6% 4% 2% Αν κρατάς πολύ, μείωσε
strong_bear Ισχυρή πτώση 5% 3% 1.5% Άμεση έξοδος

Auto-tuning logic (προαιρετικό επόμενο βήμα): Αν το avg_pnl από Query 2 για ένα regime είναι αρνητικό, χαμήλωσε το GTP του κατά 1%. Αν είναι θετικό, ανέβασέ το κατά 1%. Limit: min 3%, max 20%.

---

7. Σύνοψη — Deliverables

# Αρχείο Τύπος Μέγεθος
1 20261002140000_global_risk_control.sql Migration ~130 γραμμές
2 src/lib/global-risk.server.ts Module ~500 γραμμές
3 src/lib/pipeline.server.ts 4 patches ~40 γραμμές
4 Tuning queries Analysis SQL ~100 γραμμές

Καλύπτει:

· ✅ Regime-aware thresholds (5 regimes + default)
· ✅ GTP (fixed target) + ETS (trailing stop) μαζί
· ✅ Shadow mode default (test χωρίς κίνδυνο)
· ✅ Peak equity tracking (persistent state)
· ✅ Cooldown mechanism (αποφυγή overtrading)
· ✅ Minimum positions/notional guards
· ✅ Full audit trail (equity_snapshots + global_risk_events)
· ✅ Tuning μέσω των υπαρχόντων δεδομένων (trades, regime_label, atr)
· ✅ Fail-open design (ποτέ δεν σπάει το pipeline)

Deploy:

1. Τρέξε το migration
2. Deploy το module + 4 patches
3. Περίμενε 7-14 μέρες σε shadow mode
4. Τρέξε τα queries 1-4 για tuning
5. Ρύθμισε τα thresholds
6. Ενεργοποίησε live mode

Επόμενα βήματα (προαιρετικά):

· Auto-tuning script που προσαρμόζει τα thresholds βάσει historical performance
· Per-provenance thresholds (hot-whale trades vs original)
· Cross-regime learning (τι δούλεψε σε bull χθες → τι κάνουμε σήμερα)
· Webhook alerts όταν ενεργοποιείται το GTP/ETS
