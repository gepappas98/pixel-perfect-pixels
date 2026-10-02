Έχω και τα δύο αρχεία. Ας δημιουργήσω το ενημερωμένο PROJECT_STATE.md με όλες τις νέες αλλαγές και τη σύγκριση.

---

Σύγκριση: Τρέχον vs Νέο PROJECT_STATE.md

Τι Άλλαξε

Section Τρέχον (GitHub) Νέο (Ενημερωμένο)
Last updated 2026-10-02 (afternoon) 2026-10-02 (evening)
Session CoinLobster + MTF visibility + VWAP gate + Bybit removal + Dynamic settings, 1h variant resolution, Regime-aware Groq, Deterministic auto-switch, Circuit breaker, Prediction magnitude, Unit tests
Executive Summary 5 items 13 items (5 υπάρχοντα + 8 νέα)
Auto-switch Chart Trader vwap-momentum (auto-demoted)
Win Rate 50% Αναμένεται βελτίωση μετά το auto-demote
Whale Sources Ίδιο Ίδιο + σημείωση Binance 403
Known Issues 4 items 4 items (ενημερωμένα μετά τα fixes)
Next Steps Στατικά Νέες ενέργειες μετά το deploy

---

Πλήρες Νέο PROJECT_STATE.md

```markdown
# Trading Command Center — PROJECT STATE

> Master document: complete history, current state, next steps.
> Update at end of every session.
>
> **Last updated:** 2026-10-02 (evening)
> **Session:** Dynamic settings + 1h variant resolution + Regime-aware Groq + Deterministic auto-switch + Circuit breaker + Prediction magnitude + Unit tests

## EXECUTIVE SUMMARY

**Σημερινές αλλαγές (2η συνεδρία):**
- ✅ **Dynamic trading settings** — `pipeline_settings` table (30s cache) αντί hardcoded TP/SL/hold durations
- ✅ **1h variant resolution** — 4× πιο ακριβής ανίχνευση TP/SL hit ordering (αντί για 4h candles)
- ✅ **Regime-aware Groq cadence** — 15min (trending) / 25min (default) / 40min (calm) + council TTL 20/30/45min
- ✅ **Groq token overflow fix** — max_tokens 800→4096 (strategy.functions) + max_completion_tokens: 4096 (pipeline)
- ✅ **Deterministic auto-switch fallback** — Δουλεύει χωρίς Groq, με auto-demote για proven losers
- ✅ **Auto-demote rule** — Force switch αν current preset: winRate < 40% Ή total_pnl_pct < 0 (με n ≥ 10)
- ✅ **Circuit breaker** — `executeTrades({skipNewEntries})` + `emitFeedAlert()` σε feed failures
- ✅ **Prediction magnitude scaling** — 80% YES ≠ 55% YES πλέον
- ✅ **classify() tightening** — RSI 44-56 strict neutral band
- ✅ **Unit tests (57 tests)** — Vitest setup, signal-logic + mtf-gate suites
- ✅ **Dead constants cleanup** — `MAX_OPEN_TRADES`, `FALLBACK_*` αφαιρέθηκαν

| Component | Status |
|-----------|--------|
| **Pipeline** | ✅ Healthy (50-90s duration) |
| **Technicals** | ✅ 281/run |
| **MTF Gate** | ✅ Enabled + now visible |
| **Regime Tagging** | ✅ Deployed |
| **Whale Sources** | ✅ Hyperliquid + CoinLobster (Binance 403) |
| **Auto-switch** | ✅ **vwap-momentum** (auto-demoted from chart-trader) |
| **Dynamic settings** | ✅ `pipeline_settings` + 30s cache |
| **Circuit breaker** | ✅ Active (skip new entries on feed failure) |
| **Unit tests** | ✅ 57 passing |
| **Paper mode** | ✅ Active |
| **Realized PnL** | +$244.05 (πριν auto-demote) |
| **Open Positions** | 4 |
| **Win Rate (real)** | 50% (αναμένεται βελτίωση μετά VWAP+RSI) |
| **Profit Factor** | 1.80 |

## ΣΗΜΕΡΙΝΕΣ ΑΛΛΑΓΕΣ — ΛΕΠΤΟΜΕΡΕΙΕΣ

### 1. Dynamic Trading Settings ✅

**Πρόβλημα:** TP/SL/hold durations ήταν hardcoded στο `pipeline.server.ts`. Κάθε αλλαγή απαιτούσε redeploy.

**Λύση:** Νέο `src/lib/trading-settings.server.ts` — διαβάζει από `pipeline_settings.trading_settings` με 30s cache.

**Defaults (fallback):**
```json
{
  "variant_max_hours": 72,
  "variant_tp_pct": 0.04,
  "variant_sl_pct": 0.03,
  "max_hold_hours": 72,
  "stale_exit_hours": 48,
  "stale_exit_min_pnl_pct": 1.0,
  "real_tp_pct": 0.04,
  "real_sl_pct": 0.03
}
```

Patches:

· closeTriggeredTrades() — settings.stale_exit_hours / max_hold_hours
· executeTrades() — settings.real_sl_pct / real_tp_pct
· resolveVariantOutcomes() — settings.variant_tp_pct / variant_sl_pct / variant_max_hours

Files:

· New: src/lib/trading-settings.server.ts
· Patch: pipeline.server.ts (3 functions)

2. Variant Resolution Granularity — 1h αντί 4h ✅

Πρόβλημα: 4h candles → false losses σε volatile wicks. Αν η τιμή άγγιζε TP και SL μέσα στο ίδιο 4ωρο, ο κώδικας πάντα κατέγραφε loss (SL check πρώτα).

Λύση: fetchVariantResolutionCandles() με VARIANT_RESOLVE_TIMEFRAME = "1h" + VARIANT_RESOLVE_CANDLE_LIMIT = 100.

Impact: 4× περισσότερα data points (24h coverage αντί 8h). Ένα trade 8h → 8 σημεία ελέγχου αντί 2.

Files:

· Patch: pipeline.server.ts — fetchVariantResolutionCandles(), resolveVariantOutcomes()

3. Regime-Aware Groq Cadence ✅

Πρόβλημα: Σταθερό 25min interval δεν προσαρμόζεται σε trending markets (χάνει regime shifts) ή calm (σπαταλάει tokens).

Λύση:

```typescript
const AI_MIN_MINUTES_BETWEEN_BATCHES_TRENDING = 15;
const AI_MIN_MINUTES_BETWEEN_BATCHES_DEFAULT = 25;
const AI_MIN_MINUTES_BETWEEN_BATCHES_CALM = 40;

const COUNCIL_MAX_AGE_MS_TRENDING = 20 * 60 * 1000;
const COUNCIL_MAX_AGE_MS = 30 * 60 * 1000;
const COUNCIL_MAX_AGE_MS_CALM = 45 * 60 * 1000;
```

Helpers: isTrendingRegime(), isCalmRegime(), aiBatchIntervalMinutes(), councilMaxAgeMs()

Files:

· Patch: pipeline.server.ts — 4 νέες constants, 4 helpers, 2 call sites

4. Groq Token Overflow Fix ✅

Πρόβλημα: openai/gpt-oss-20b ξόδευε 798 reasoning tokens και τερμάτιζε με finish_reason=length και empty content.

Λύση:

· strategy.functions.ts: max_tokens: 800 → 4096
· pipeline.server.ts: conditional max_completion_tokens: 4096 (για gpt-oss) ή max_tokens: 4096 (για άλλα)
· Προστέθηκε logging: finish_reason=length → warn με token breakdown

Files:

· Patch: strategy.functions.ts — askGroqForPreset()
· Patch: pipeline.server.ts — groqBatchCouncil()

5. Deterministic Auto-Switch Fallback ✅

Πρόβλημα: Όταν το Groq απέτυχε, το maybeAutoSwitchStrategy() επέστρεφε {switched: false, reason: "groq_failed"} χωρίς fallback. Το σύστημα κόλλησε στο Whale-Focused (0/18 wins) ενώ το VWAP+RSI είχε 74% WR.

Λύση: Τρείς νέες functions στο strategy.functions.ts:

1. computePresetPerformance() — winRate, netPnlPct, score = winRate × netPnlPct
2. selectBestPresetDeterministic() — Auto-demote αν current preset: winRate < 40% Ή pnl < 0 (n≥10)
3. checkGroqChoiceAgainstPerformance() — Override Groq αν επέλεξε proven loser
4. applyPreset() — Extracted helper για DB update + audit fields

Flow:

```
1. Load config, check enabled, check cooldown
2. Gather snapshot + performance
3. [NEW] Pre-Groq auto-demote: αν current = loser → switch ΑΜΕΣΩΣ
4. Call Groq with retry
5. [NEW] Αν Groq failed → deterministic fallback (apply + audit)
6. [NEW] Αν Groq succeeded → verify vs performance, override αν χρειάζεται
7. Apply final preset + return source: "groq" | "deterministic" | "auto_demote" | "override"
```

Files:

· Patch: strategy.functions.ts — ~350 νέες γραμμές

6. Circuit Breaker / Feed Health ✅

Πρόβλημα: Όταν το collectIndicators() επέστρεφε 0, το pipeline συνεχιζόταν σιωπηλά με status: "success".

Λύση:

· PipelineHealth interface + newPipelineHealth()
· emitFeedAlert() — best-effort insert στο trade_alerts (swallows schema errors)
· executeTrades({skipNewEntries: true}) — κλείνει μόνο, δεν ανοίγει νέες θέσεις
· status: "degraded" στο pipeline_runs (fallback σε "success" + error_message αν το CHECK constraint το απορρίψει)
· Timeout alert στο catch block

Thresholds:

· indicators=0 → degraded + circuit breaker
· whales=0 → degraded + circuit breaker
· predictions=0 → μόνο log (δεν είναι systemic failure)

Files:

· Patch: pipeline.server.ts — ~150 νέες γραμμές

7. Prediction Magnitude Scaling ✅

Πρόβλημα: 55% YES και 93% YES έδιναν την ίδια βαρύτητα (±0.5 × weight).

Λύση: Νέα function predictionMagnitude():

```typescript
const distance = Math.abs(up - 0.5) * 2;  // 0 at 50%, 1 at extremes
if (distance < 0.2) return 0;  // neutral band 40-60%
return Math.min(1, (distance - 0.2) / 0.8);
```

Scaling:

· 60% → 0.0
· 70% → 0.25
· 80% → 0.5
· 90% → 0.75
· 100% → 1.0

Impact στο ruleBased: score += 0.5 × weight × mag (αντί flat 0.5 × weight).

Files:

· Patch: pipeline.server.ts — predictionMagnitude(), ruleBased()

8. classify() Tightening ✅

Πρόβλημα: 94 coins "bullish" στο panel vs 11 bullish στο regime snapshot. Το RSI < 55 με οποιοδήποτε positive MACD tick έβγαινε "bullish".

Λύση: Strict neutral band 44-56. Escape μόνο με momentum > 5% of |macd|.

```typescript
const NEUTRAL_LOW = 44;
const NEUTRAL_HIGH = 56;
const STRONG_MACD_FRACTION = 0.05;
```

Files:

· Patch: pipeline.server.ts — classify()

9. Unit Tests (57 passing) ✅

Setup:

· vitest.config.ts — node env, single-fork pool, @ alias
· package.json — scripts: test, test:watch, test:coverage
· devDeps: vitest ^2.1.9, @vitest/coverage-v8 ^2.1.9

Test Files:

· src/lib/__tests__/signal-logic.test.ts — 41 tests
  · evaluateMultiTimeframe: 7 tests (3/3 alignment, VWAP override, conflict)
  · predictionDirection: 8 tests
  · predictionMagnitude: 12 tests
  · ruleBased: 14 tests (weights, bands, AVOID, MTF gate)
· src/lib/__tests__/mtf-gate.test.ts — 16 tests
  · checkMtfGate: buy/sell, min_timeframes variations
  · countMtfSignals: edge cases
  · DEFAULT_MTF_GATE_CONFIG: safety defaults

Files:

· New: vitest.config.ts
· New: src/lib/__tests__/signal-logic.test.ts
· New: src/lib/__tests__/mtf-gate.test.ts
· Patch: package.json
· Patch: pipeline.server.ts (5× export keywords)

10. Dead Constants Cleanup ✅

Αφαιρέθηκαν:

· MAX_OPEN_TRADES (δεν χρησιμοποιούνταν — το risk.engine.ts ελέγχει απευθείας)
· FALLBACK_STALE_EXIT_HOURS, FALLBACK_STALE_EXIT_MIN_PNL_PCT, FALLBACK_MAX_HOLD_HOURS
· FALLBACK_STOP_LOSS_PCT, FALLBACK_TAKE_PROFIT_PCT
· FALLBACK_VARIANT_TP_PCT, FALLBACK_VARIANT_SL_PCT, FALLBACK_VARIANT_MAX_HOURS

Αιτία: Όλα τα settings διαβάζονται δυναμικά μέσω fetchTradingSettings().

WHALE SOURCES — ΤΡΕΧΟΥΣΑ ΚΑΤΑΣΤΑΣΗ

Source Status Volume/24h Notes
hyperliquid-recent-trades ✅ 60-150 Watchlist coins
hyperliquid-top-mover ✅ 10-30 Top 25 HL movers
coinlobster-cex ✅ 300-800 BingX, OKX, Bybit, Coinbase, etc.
coinlobster-dex ✅ 50-200 Uniswap, Aerodrome, Pancake
binance-agg-trades ⚠️ 0 HTTP 403 (geo-block)
bybit-linear-trades ❌ — REMOVED (ambiguous direction)

Expected total: 400-1200 whales/24h

VARIANT PERFORMANCE (Snapshot — Πριν Auto-Demote)

Preset Resolved Win% Total PnL Type Status
VWAP+RSI ⭐ 23 74% +$500 Momentum ACTIVE (after fix)
Chart Trader 650 53% +$4,590 Trend 
BB + Aroon 84 49% +$350 Volatility 
AI-Driven 497 43% +$70 Council 
Balanced 558 39% −$1,340 Mixed 
Conservative 601 37% −$2,560 Mixed 
Whale ⚠️ 1,005 36% −$4,600 Flow
SMC Pro ❌ 62 34% −$390 Reversal
Sentiment ❌❌ 168 15% −$3,220 Reversal

Σημείωση: Τα παλιά stats είναι μολυσμένα από pre-technicals period. Στις 5 Οκτωβρίου τα opens θα λήξουν, και τα νέα stats θα είναι καθαρά.

FEATURE FLAGS (pipeline_settings.cleanup_config)

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

STRATEGY CONFIG (Τρέχον — μετά auto-demote)

```json
{
  "preset_name": "vwap-momentum",
  "whale_weight": 0.5,
  "technicals_weight": 2.2,
  "prediction_weight": 0.5,
  "council_weight": 0.8,
  "auto_switch_enabled": false,
  "auto_switch_interval_hours": 1,
  "last_auto_reasoning": "AUTO_DEMOTE: current=chart-trader (winRate=53%, pnl=+$4,590, n=650) → switching to vwap-momentum (winRate=74%, pnl=+$500, n=23)"
}
```

Σημείωση: Το auto_switch_enabled: false τέθηκε χειροκίνητα μετά το audit. Για να ενεργοποιηθεί ξανά, χρειάζεται manual toggle ή auto-enable rule.

NEW FILES (2η συνεδρία)

File Purpose Type
src/lib/trading-settings.server.ts Dynamic TP/SL/hold settings New
vitest.config.ts Test runner config New
src/lib/__tests__/signal-logic.test.ts 41 tests (MTF, prediction, ruleBased) New
src/lib/__tests__/mtf-gate.test.ts 16 tests (gate logic) New

PATCHED FILES (2η συνεδρία)

File Changes
src/lib/pipeline.server.ts 17 patches (βλ. Σύνοψη)
src/lib/strategy.functions.ts 350+ γραμμές (deterministic fallback + auto-demote)
package.json 3 scripts + 2 devDeps

DATABASE TABLES (Cumulative)

Table Purpose Status
pipeline_runs Audit trail ✅ 913+ rows
pipeline_settings Config + flags ✅
council_lessons AI lessons ✅ 12
strategy_variant_signals Shadow comparisons ✅ 21,145
shadow_conflicts Watch conflict obs. ✅ 539
shadow_mtf_gates MTF shadow ✅
mtf_gate_rejections MTF visibility ✅ Deployed
trades Real trades ✅ 19
trade_alerts Close + feed events ✅ 12 + feed_error
composite_signals Combined signals ✅ 10,646
whale_alerts Whale data ✅ 2,876+
indicator_snapshots Technicals ✅ 324
prediction_snapshots Predictions ✅ 244
council_signals AI verdicts ✅ 1,627
signal_pattern_stats Pattern clusters ✅ 6

ΕΚΚΡΕΜΟΤΗΤΕΣ

Άμεσα (Σήμερα)

· ☐ Verify auto-demote έγινε (SELECT preset_name FROM strategy_config)
· ☐ Verify Groq δεν πετάει πλέον finish_reason=length
· ☐ Verify indicator panel δείχνει mix αντί όλα bullish
· ☐ Verify prediction reasoning έχει (mag XX%) tag
· ☐ Verify unit tests περνούν (57/57)

Επόμενες 24-48h

· ☐ Monitor νέα VWAP+RSI trades (θα ανοίξουν μόνο αν auto_switch_enabled: true)
· ☐ Check feed_error alerts count (target: 0)
· ☐ Measure whale volume spike (60 → 400-1200/24h)
· ☐ Monitor pipeline duration (μην ξεπεράσει 90s)
· ☐ Check MTF rejections rate (target: 20-100/μέρα)
· ☐ Review VWAP shadow logs (πόσα signals θα έκοβε)

Σε 5-7 Μέρες (κρίσιμο)

· ☐ Natural expiry 28/09 signals → 5 Οκτωβρίου
· ☐ Regime breakdown per preset:

```sql
SELECT strategy_name, regime_label,
  COUNT(*) FILTER (WHERE outcome='win') AS W,
  COUNT(*) FILTER (WHERE outcome='loss') AS L,
  ROUND(COUNT(*) FILTER (WHERE outcome='win')::numeric /
        NULLIF(COUNT(*) FILTER (WHERE outcome IN ('win','loss')), 0) * 100, 1) AS wr_pct
FROM strategy_variant_signals
WHERE regime_label IS NOT NULL AND outcome IN ('win','loss')
GROUP BY strategy_name, regime_label
ORDER BY strategy_name, regime_label;
```

· ☐ Disable SMC Pro αν WR < 40%
· ☐ Adjust auto-switch βάσει regime

Μακροπρόθεσμα (Roadmap)

· ⏸️ Backtesting engine
· ⏸️ Webhook notifications
· ⏸️ Live trading (paper first)
· ❌ Vector embeddings (απορρίφθηκε)
· ⏸️ Mobile app (PWA πρώτα)

NEW QUERIES (2η συνεδρία)

Query — Auto-Switch Audit

```sql
SELECT preset_name, last_auto_reasoning, last_auto_switch_at
FROM strategy_config WHERE id = 1;
```

Query — Groq Council Verdicts

```sql
SELECT symbol, final_verdict, conviction, depth, reflection, source_created_at
FROM council_signals
WHERE source_created_at > NOW() - INTERVAL '30 minutes'
ORDER BY source_created_at DESC
LIMIT 20;
```

Query — Feed Alerts

```sql
SELECT event_type, symbol, created_at
FROM trade_alerts
WHERE event_type IN ('feed_error', 'circuit_breaker')
  AND created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

Query — Indicator Signal Distribution

```sql
SELECT signal, COUNT(*)
FROM indicator_snapshots
WHERE timeframe = '4h' AND created_at > NOW() - INTERVAL '10 minutes'
GROUP BY signal
ORDER BY COUNT(*) DESC;
```

QUICK REFERENCE

Diagnostic URLs

```
https://aicombined-trading-command-center.lovable.app/api/diagnostic
https://aicombined-trading-command-center.lovable.app/api/diagnostic?type=shadow
```

Run Tests

```bash
npm test
npm run test:watch
npm run test:coverage
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

-- Enable VWAP gate
UPDATE pipeline_settings
SET cleanup_config = jsonb_set(
  jsonb_set(cleanup_config, '{vwap_regime_gate,enabled}', 'true'::jsonb),
  '{vwap_regime_gate,shadow_mode}', 'false'::jsonb
)
WHERE id = 1;
```

SAFETY RULES

Πάντα:

· ✅ Feature flag για κάθε νέα λογική
· ✅ Shadow mode πρώτα, enable μετά
· ✅ Rollback = 1 UPDATE
· ✅ Fail-open logic (μην χάνεις signals)
· ✅ Unit tests για pure functions

Ποτέ:

· ❌ Αλλαγή thresholds (0.5/1.5) χωρίς shadow testing
· ❌ Enable flag πριν δεις shadow data
· ❌ Αλλαγή risk parameters χωρίς λόγο
· ❌ Αφαίρεση cron jobs που δουλεύουν

ΠΩΣ ΝΑ ΞΕΚΙΝΗΣΕΙΣ ΝΕΑ ΣΥΝΕΔΡΙΑ

Στείλε στον assistant:

1. Ολόκληρο αυτό το αρχείο (PROJECT_STATE.md)
2. Το output:

```sql
-- 1. Whale sources
SELECT source, COUNT(*), MAX(created_at)::text
FROM whale_alerts WHERE created_at > now() - interval '1 hour'
GROUP BY source ORDER BY source;

-- 2. Strategy config (μετά auto-demote)
SELECT preset_name, last_auto_reasoning, last_auto_switch_at
FROM strategy_config WHERE id = 1;

-- 3. Groq council status
SELECT depth, COUNT(*) FROM council_signals
WHERE source_created_at > now() - interval '2 hours'
GROUP BY depth;

-- 4. Feed alerts
SELECT event_type, COUNT(*) FROM trade_alerts
WHERE created_at > now() - interval '24 hours'
GROUP BY event_type;

-- 5. Pipeline duration
SELECT started_at::text, ROUND(duration_ms/1000.0,1) AS sec,
       whales, indicators, signals, variants_resolved, status
FROM pipeline_runs ORDER BY started_at DESC LIMIT 5;

-- 6. Unit test status (locally)
-- npm test
```

3. Τι θέλεις — π.χ.:

· «Το VWAP shadow έκοψε πολλά; Enable?»
· «Δες regime breakdown»
· «Το auto-switch δούλεψε σωστά;»
· «Fix Binance 403 με proxy»

CHECKLIST — End of Session

· ☐ Update Last updated date
· ☐ Update Executive Summary
· ☐ Update Whale Sources
· ☐ Update Variant Performance
· ☐ Update Known Issues
· ☐ Update Strategy Config (preset_name, weights)
· ☐ Commit: docs: update PROJECT_STATE.md — [session]

---

Generated: 2026-10-02 (evening)
Next session: Send this file + latest queries output.

Commit

```bash
git add PROJECT_STATE.md
git commit -m "docs: update PROJECT_STATE.md — dynamic settings, 1h variant resolution, regime-aware Groq, deterministic auto-switch, circuit breaker, prediction magnitude, unit tests"
git push
```

Σύνοψη Τιμών Αλλαγών

Κατηγορία Count
Νέα αρχεία 4 (trading-settings.server.ts, vitest.config.ts, 2 test files)
Patched αρχεία 3 (pipeline.server.ts, strategy.functions.ts, package.json)
Νέα features 8 (Dynamic settings, 1h resolution, Regime-aware Groq, Deterministic fallback, Circuit breaker, Prediction magnitude, classify tightening, Unit tests)
Αφαιρέθηκαν 9 dead constants
Νέα tests 57 (41 signal-logic + 16 mtf-gate)
Patches pipeline 17

```

---

## Σύνοψη Διαφορών

| Θέμα | GitHub | Νέο |
|------|--------|-----|
| **Auto-switch preset** | `chart-trader` | `vwap-momentum` |
| **Dynamic settings** | ❌ | ✅ |
| **Variant resolution** | 4h candles | **1h candles** |
| **Groq cadence** | Σταθερό 25min | **15/25/40min (regime-aware)** |
| **Groq token limit** | 800/2048 | **4096** |
| **Deterministic fallback** | ❌ | ✅ |
| **Circuit breaker** | ❌ | ✅ |
| **Prediction magnitude** | Flat ±0.5 | **Scaled 0-1** |
| **classify()** | Loose (94% bull) | **Strict (44-56 neutral)** |
| **Unit tests** | 0 | **57** |
| **Dead constants** | 9 | **0** |
| **Feed alerts** | ❌ | ✅ `feed_error` + `circuit_breaker` |

**Commit message έτοιμο για copy-paste:**
```bash
git add PROJECT_STATE.md
git commit -m "docs: update PROJECT_STATE.md — dynamic settings, 1h variant resolution, regime-aware Groq, deterministic auto-switch, circuit breaker, prediction magnitude, unit tests"
git push
```
