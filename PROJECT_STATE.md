📘 PROJECT_STATE.md — Updated

Αποθήκευσέ το στο root του repo. Αντικαθιστά το προηγούμενο.

```markdown
# Trading Command Center — PROJECT STATE

> Master document: complete history, current state, next steps.
> Update at end of every session.
>
> **Last updated:** 2026-10-02 (afternoon)
> **Session:** CoinLobster integration + MTF visibility + VWAP gate + Bybit perps removal

---

## 🎯 EXECUTIVE SUMMARY

**Σημερινές αλλαγές:**
- ✅ **CoinLobster** ως 2ος whale source (keyless, 15 CEX + DEX)
- ✅ **Bybit perps whales αφαιρέθηκαν** (noise, ambiguous direction)
- ✅ **MTF gate visibility** — `mtf_gate_rejections` table
- ✅ **VWAP regime gate** — ATR-based filtering (shadow mode)
- ✅ **Regime tagging deployed** σε production (3 columns + indexes)

| Component | Status |
|---|---|
| **Pipeline** | ✅ Healthy (50-70s duration) |
| **Technicals** | ✅ 281/run |
| **MTF Gate** | ✅ Enabled + now visible |
| **Regime Tagging** | ✅ Deployed |
| **Whale Sources** | ✅ Hyperliquid + CoinLobster (Binance 403) |
| **Auto-switch** | ✅ Chart Trader |
| **Paper mode** | ✅ Active |
| **Realized PnL** | +$244.05 |
| **Open Positions** | 7 |
| **Win Rate (real)** | 50% |
| **Profit Factor** | 1.80 |

---

## 🆕 ΣΗΜΕΡΙΝΕΣ ΑΛΛΑΓΕΣ — ΛΕΠΤΟΜΕΡΕΙΕΣ

### 1. CoinLobster Integration ✅

**Τι είναι:** Keyless REST API που δίνει **live executed whale trades** από 15 exchanges + DEX swaps.

**Endpoint:** `https://coinlobster.com/api/public/crypto-whales`

**Free tier:**
- ✅ Κάθε trade $1M+ σε CEX (live)
- ✅ DEX swaps $250K+
- ✅ Max 50 rows/call
- ✅ 60 requests/min per IP
- ✅ BTC/USD live, άλλα 15-min delayed

**Response shape (verified live):**
```json
{
  "success": true,
  "whales": [
    {
      "tradeId": "1790890099809-BingX Futures",
      "pair": "BTC/USD",
      "exchange": "BingX Futures",
      "price": 84558.6,
      "quantity_base": 13.2091,
      "quantity_quote": 1116943.00,
      "isBuy": false,
      "timestamp": 1790890099809,
      "exchangeType": "future",
      "_src": "cex"
    }
  ]
}
```

Strategy:

· 1 global fetch (top 50 across all coins)
· 5 priority fetches (BTC, ETH, SOL, XRP, DOGE)
· Σύνολο 6 HTTP requests/run (αντί 30 που θα ήταν 1 per coin)

Filtering:

· Min USD: $100,000
· Whitelist: WATCHLIST (85 coins)
· Dedup: tradeId (via source,tx_hash unique index)

Files:

· src/lib/coinlobster.server.ts (νέο)
· Patch στο pipeline.server.ts — collectCoinLobsterWhales()
· Migration: 20261002130000_coinlobster_source.sql

Sources που γράφτηκαν:

· coinlobster-cex (BingX, OKX, Bybit, Coinbase, etc.)
· coinlobster-dex (Uniswap, Aerodrome, Pancake)

---

2. Bybit Perps Whales ΑΦΑΙΡΕΘΗΚΑΝ ❌

Γιατί: Direction ambiguity.

Παράδειγμα:

· Someone buys 500K BTCUSDT perp → long opening → bullish ✅
· Someone closes short 500K BTCUSDT perp → επίσης "Buy" → δεν είναι bullish ❌

Αποτέλεσμα: Το Whale signal γινόταν θορυβώδες — εξηγεί το 36% WR.

Τι αφαιρέθηκε:

· bybitRecentTrades() function
· BybitTrade interface
· Fallback logic στο collectExchangeWhaleAlerts()

Τι διατηρήθηκε:

· Bybit candles fallback (για technicals) — το bybitPublicGet() παραμένει

Αντικατάσταση: CoinLobster CEX feed (spot + futures, unambiguous direction).

---

3. MTF Gate Visibility ✅

Πρόβλημα: Το MTF gate απέρριπτε signals, αλλά δεν φαινόταν πουθενά.

```typescript
if (!mtfGateDecision.passed) {
  recommendation = "hold";
  // ...
}
// ...
if (result.recommendation === "hold") continue;  // ← ΔΕΝ γράφεται στη βάση!
```

Λύση: Νέα table mtf_gate_rejections.

Schema:

```sql
CREATE TABLE mtf_gate_rejections (
  id uuid PRIMARY KEY,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  score numeric,
  confidence numeric,
  mtf_bull_count int NOT NULL,
  mtf_bear_count int NOT NULL,
  mtf_neutral_count int NOT NULL,
  reject_reason text,
  regime_label text,
  detected_at timestamptz NOT NULL DEFAULT now()
);
```

Γιατί: Χωρίς αυτό, δεν ξέρουμε αν το gate δουλεύει.

Migration: 20261002120000_mtf_gate_rejections.sql

---

4. VWAP Regime Gate ✅

Πρόβλημα: Το VWAP+RSI preset κατέρρεε σε volatile περιόδους (16% WR σε bearish batch).

Λύση: ATR-based filter.

Logic:

```typescript
if (presetName === "vwap-momentum") {
  // ... υπάρχον confirmation logic ...
  
  const atrPct = Number(primaryRaw?.["atr_pct"] ?? 0);
  const isHighVol = atrPct > vwapGate.atr_pct_threshold;
  
  if (isHighVol) {
    if (vwapGate.enabled) continue;      // Hard skip
    else console.log("[VWAP_GATE_SHADOW]", ...);  // Shadow mode
  }
}
```

Config:

```json
{
  "vwap_regime_gate": {
    "enabled": false,
    "shadow_mode": true,
    "atr_pct_threshold": 2.5
  }
}
```

ATR Helper: Νέα συνάρτηση computeAtrPct() στο pipeline.server.ts.

ATR αποθηκεύεται: Στο indicator_snapshots.raw.atr_pct.

---

5. Regime Tagging — Deployed ✅

Τι κάνει: Αποθηκεύει regime_label (strong_bull / bull / sideways / bear / strong_bear) σε:

· strategy_variant_signals
· composite_signals
· trades

Files:

· Migration: 20261001150000_regime_labels.sql
· New: src/lib/regime-snapshot.ts

Formula:

```
score = whaleNet × 0.3 + techBreadth × 0.4 + predConsensus × 0.2 + councilConsensus × 0.1
```

Verify:

```sql
SELECT regime_label, COUNT(*) 
FROM strategy_variant_signals
WHERE created_at > now() - interval '24 hours'
GROUP BY regime_label;
```

---

📊 WHALE SOURCES — ΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ

Source Status Volume/24h Notes
hyperliquid-recent-trades ✅ 60-150 Watchlist coins
hyperliquid-top-mover ✅ 10-30 Top 25 HL movers
coinlobster-cex 🆕 300-800 BingX, OKX, Bybit, Coinbase, etc.
coinlobster-dex 🆕 50-200 Uniswap, Aerodrome, Pancake
binance-agg-trades 🔴 0 HTTP 403 (geo-block)
bybit-linear-trades ❌ — REMOVED (noise)

Expected total: 400-1200 whales/24h (αντί 60 πριν).

---

📊 VARIANT PERFORMANCE (Snapshot)

Preset Resolved Win% Total PnL Type
Chart Trader 🏆 650 53% +$4,590 Trend
VWAP+RSI 194 41% +$690 Momentum
BB + Aroon 84 49% +$350 Volatility
Balanced 558 39% −$1,340 Mixed
Conservative 601 37% −$2,560 Mixed
AI-Driven 497 43% +$70 Council
Whale ⚠️ 1,005 36% −$4,600 Flow
SMC Pro ❌ 62 34% −$390 Reversal
Sentiment ❌❌ 168 15% −$3,220 Reversal

Σημείωση: Τα παλιά stats (28/09 - 30/09) είναι μολυσμένα από pre-technicals period. Στις 5 Οκτωβρίου τα opens θα λήξουν, και τα νέα stats θα είναι καθαρά.

---

🛠️ FILES & INFRASTRUCTURE

Νέα Αρχεία (Σήμερα)

File Purpose
src/lib/coinlobster.server.ts CoinLobster keyless client

Νέα Migrations (Σήμερα)

File Purpose
20261002120000_mtf_gate_rejections.sql MTF gate visibility
20261002130000_coinlobster_source.sql Whale source index

Patches (Σήμερα)

· pipeline.server.ts — CoinLobster integration, MTF rejection logging, VWAP gate, computeAtrPct(), Bybit perps removal

Backend Files (Cumulative)

File Purpose Status
src/lib/pipeline.server.ts Κύριο pipeline ✅ Updated
src/lib/coinlobster.server.ts 🆕 CoinLobster client ✅ Deployed
src/lib/mtf-gate.ts MTF confirmation ✅
src/lib/regime-snapshot.ts Regime computation ✅
src/lib/watch-conflict.ts Hard conflict ✅ Shadow
src/lib/cleanup-config.server.ts Feature flags ✅
src/lib/error-serialize.ts Error handling ✅
src/lib/strategy.functions.ts Auto-switch ✅
src/lib/market-regime.functions.ts Regime panel ✅
src/lib/diagnostic.functions.ts Diagnostics ✅

Migrations (Cumulative)

File Purpose
20250925130000_pipeline_fixes.sql pipeline_runs, pipeline_settings
20250925150000_trades_dedup.sql one-open-per-symbol
20250928130000_council_learning.sql council_lessons
20250928140000_strategy_config.sql strategy_config
20250928150000_auto_switch.sql Auto-switch columns
20250928170000_strategy_variants.sql Variant signals table
20260929150000_cleanup_flags.sql cleanup_config column
20260929160000_shadow_conflicts.sql shadow_conflicts table
20261001120000_mtf_confirmation_gate.sql MTF gate + shadow table
20261001150000_regime_labels.sql Regime tagging
20261002120000_mtf_gate_rejections.sql 🆕 MTF visibility
20261002130000_coinlobster_source.sql 🆕 Whale index

---

⚙️ FEATURE FLAGS (pipeline_settings.cleanup_config)

```json
{
  "watch_conflict_fix": { "enabled": false, "shadow_mode": true },
  "regime_panel_fix": { "enabled": false, "shadow_mode": true },
  "auto_switch_retry": { "enabled": false, "max_retries": 3, "backoff_ms": 2000 },
  "error_serialization": { "enabled": true },
  "mtf_confirmation_gate": { "enabled": true, "shadow_mode": false, "min_timeframes": 2 },
  "vwap_regime_gate": { "enabled": false, "shadow_mode": true, "atr_pct_threshold": 2.5 }
}
```

Strategy Config

```json
{
  "preset_name": "chart-trader",
  "whale_weight": 0.5,
  "technicals_weight": 2.0,
  "prediction_weight": 0.5,
  "council_weight": 0.5,
  "auto_switch_enabled": true,
  "auto_switch_interval_hours": 1
}
```

---

📈 DATABASE TABLES (Cumulative)

Table Purpose Status
pipeline_runs Audit trail ✅ 913+ rows
pipeline_settings Config + flags ✅
council_lessons AI lessons ✅ 12
strategy_variant_signals Shadow comparisons ✅ 21,145
shadow_conflicts Watch conflict obs. ✅ 539
shadow_mtf_gates MTF shadow ✅
mtf_gate_rejections 🆕 MTF visibility ✅ Deployed
trades Real trades ✅ 19
trade_alerts Close events ✅ 12
composite_signals Combined signals ✅ 10,646
whale_alerts Whale data ✅ 2,876+
indicator_snapshots Technicals ✅ 324
prediction_snapshots Predictions ✅ 244
council_signals AI verdicts ✅ 1,627
signal_pattern_stats Pattern clusters ✅ 6

---

🎯 ΕΚΚΡΕΜΟΤΗΤΕΣ

Άμεσα (Σήμερα)

☐ Verify CoinLobster γράφει rows (μετά 15 λεπτά)
☐ Verify MTF rejections γράφονται
☐ Verify VWAP shadow logs
☐ Verify bybit-linear-trades δεν γράφει πια

Επόμενες 24-48h

☐ Measure whale volume spike (60 → 400-1200/24h)
☐ Monitor pipeline duration (μην ξεπεράσει 90s)
☐ Check MTF rejections rate (target: 20-100/μέρα)
☐ Review VWAP shadow logs (πόσα signals θα έκοβε)

Σε 5-7 Μέρες (κρίσιμο)

☐ Natural expiry 28/09 signals → 5 Οκτωβρίου
☐ Regime breakdown per preset:
  ```sql
  SELECT strategy_name, regime_label,
    COUNT(*) FILTER (WHERE outcome='win') AS W,
    COUNT(*) FILTER (WHERE outcome='loss') AS L
  FROM strategy_variant_signals
  WHERE regime_label IS NOT NULL AND outcome IN ('win','loss')
  GROUP BY strategy_name, regime_label;
  ```
☐ Disable SMC Pro αν WR < 40% (ακόμη)
☐ Adjust auto-switch βάσει regime

Μακροπρόθεσμα (Roadmap)

· ⏸️ Backtesting engine
· ⏸️ Webhook notifications
· ⏸️ Live trading (paper first)
· ❌ Vector embeddings (απορρίφθηκε)
· ⏸️ Mobile app (PWA πρώτα)

---

🔑 QUICK REFERENCE

Diagnostic URLs

```
https://aicombined-trading-command-center.lovable.app/api/diagnostic
https://aicombined-trading-command-center.lovable.app/api/diagnostic?type=shadow
```

Query — Whale Sources

```sql
SELECT source, COUNT(*), ROUND(AVG(usd_value)::numeric, 0) AS avg_usd,
  MAX(created_at)::text AS latest
FROM whale_alerts
WHERE created_at > now() - interval '30 minutes'
GROUP BY source
ORDER BY total DESC;
```

Query — MTF Rejections

```sql
SELECT symbol, side,
  mtf_bull_count || 'B·' || mtf_bear_count || 'B·' || mtf_neutral_count || 'N' AS pattern,
  reject_reason, regime_label, detected_at::text
FROM mtf_gate_rejections
ORDER BY detected_at DESC LIMIT 20;
```

Query — Regime Breakdown (Day 5+)

```sql
SELECT strategy_name, regime_label,
  COUNT(*) FILTER (WHERE outcome='win') AS W,
  COUNT(*) FILTER (WHERE outcome='loss') AS L,
  ROUND(
    COUNT(*) FILTER (WHERE outcome='win')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE outcome IN ('win','loss')), 0) * 100, 1
  ) AS wr_pct
FROM strategy_variant_signals
WHERE regime_label IS NOT NULL AND outcome IN ('win','loss')
GROUP BY strategy_name, regime_label
ORDER BY strategy_name, regime_label;
```

Enable VWAP Gate (αν shadow δείχνει καλά)

```sql
UPDATE pipeline_settings
SET cleanup_config = jsonb_set(
  jsonb_set(cleanup_config, '{vwap_regime_gate,enabled}', 'true'::jsonb),
  '{vwap_regime_gate,shadow_mode}', 'false'::jsonb
) WHERE id = 1;
```

Rollback Commands

```sql
-- Disable MTF gate
UPDATE pipeline_settings
SET cleanup_config = jsonb_set(cleanup_config, '{mtf_confirmation_gate,enabled}', 'false'::jsonb)
WHERE id = 1;

-- Restore chart-trader
UPDATE strategy_config
SET whale_weight = 0.5, technicals_weight = 2.0,
    prediction_weight = 0.5, council_weight = 0.5,
    preset_name = 'chart-trader'
WHERE id = 1;
```

---

🛡️ SAFETY RULES

Πάντα:

· ✅ Feature flag για κάθε νέα λογική
· ✅ Shadow mode πρώτα, enable μετά
· ✅ Rollback = 1 UPDATE
· ✅ Fail-open logic (μην χάνεις signals)

Ποτέ:

· ❌ Αλλαγή thresholds (0.5/1.5) χωρίς shadow testing
· ❌ Enable flag πριν δεις shadow data
· ❌ Αλλαγή risk parameters χωρίς λόγο
· ❌ Αφαίρεση cron jobs που δουλεύουν

---

🎯 ΠΩΣ ΝΑ ΞΕΚΙΝΗΣΕΙΣ ΝΕΑ ΣΥΝΕΔΡΙΑ

Στείλε στον assistant:

1. Ολόκληρο αυτό το αρχείο (PROJECT_STATE.md)
2. Το output:
   ```sql
   -- 1. Whale sources
   SELECT source, COUNT(*), MAX(created_at)::text
   FROM whale_alerts WHERE created_at > now() - interval '1 hour'
   GROUP BY source ORDER BY source;
   
   -- 2. Regime distribution
   SELECT regime_label, COUNT(*)
   FROM strategy_variant_signals
   WHERE created_at > now() - interval '24 hours'
   GROUP BY regime_label;
   
   -- 3. MTF rejections
   SELECT COUNT(*) FROM mtf_gate_rejections
   WHERE detected_at > now() - interval '24 hours';
   
   -- 4. Pipeline duration
   SELECT started_at::text, ROUND(duration_ms/1000.0,1) AS sec,
     whales, indicators, signals, variants_resolved, status
   FROM pipeline_runs ORDER BY started_at DESC LIMIT 5;
   ```
3. Τι θέλεις — π.χ.:
   · «Το VWAP shadow έκοψε πολλά; Enable?»
   · «Δες regime breakdown»
   · «Fix Binance 403 με proxy»

---

📝 CHECKLIST — End of Session

☐ Update Last updated date
☐ Update Executive Summary
☐ Update Whale Sources
☐ Update Variant Performance
☐ Update Known Issues
☐ Commit: docs: update PROJECT_STATE.md — [session]

---

Generated: 2026-10-02
Next session: Send this file + latest queries output.

```

---

## 🚀 Commit

```bash
git add PROJECT_STATE.md
git commit -m "docs: update PROJECT_STATE.md — CoinLobster, MTF visibility, VWAP gate, Bybit perps removal"
git push
```

---

📋 Σύνοψη Τιμής Αλλαγών

Κατηγορία Count
Νέα αρχεία 1 (coinlobster.server.ts)
Νέα migrations 2
Patches pipeline ~10
Νέα features 4 (CoinLobster, MTF visibility, VWAP gate, ATR helper)
Αφαιρέθηκαν 3 (bybitRecentTrades, BybitTrade, bybit fallback)
Whale volume 60 → 400-1200/24h
HTTP requests/run 101 → 101 (ίδιο, +6 CoinLobster)

🎯
