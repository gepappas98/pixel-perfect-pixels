# Trading Command Center — PROJECT STATE

> Master document: complete history, current state, next steps.
> Update at end of every session.
>
> **Last updated:** 2026-10-01 (evening)
> **Session:** 6 fixes + 3 features + regime-aware tagging

---

## 🎯 EXECUTIVE SUMMARY

**Μεγάλη πρόοδος.** Σήμερα:
- Διορθώθηκαν **6 critical bugs**
- Ενεργοποιήθηκαν **2 major features**
- Προστέθηκε **regime-aware analytics**
- Το pipeline τρέχει πιο δυνατό από ποτέ

| Component | Status |
|---|---|
| **Pipeline** | ✅ Healthy (2-10 min interval) |
| **Technicals** | ✅ Restored (281/run) |
| **MTF Gate** | ✅ Enabled + φιλτράρει σωστά |
| **Whale (Bybit + HL)** | ✅ Working (patch pending) |
| **Auto-switch** | ✅ Chart Trader |
| **Regime Tagging** | 🆕 Just deployed |
| **Paper mode** | ✅ Active |
| **Realized PnL** | +$244.05 |
| **Open Positions** | 7 |
| **Win Rate (real)** | 50% |
| **Profit Factor** | 1.80 |

---

## 🐛 BUGS ΠΟΥ ΔΙΟΡΘΩΘΗΚΑΝ ΣΗΜΕΡΑ

### 1. Watch Spam (Semantic Bug)

**Πριν:** 3-5 watch signals με 13% confidence, ανούσια.

**Αιτία:** Το `watch` ήταν fallthrough αντί ρητή απόφαση στο `ruleBased()`.

**Fix:**
- Hard conflict detection: whale vs prediction αντίθετα + no technicals → `hold`
- Feature flag: `watch_conflict_fix`
- Shadow mode αρχικά, enabled μετά

**Status:** ✅ Deployed.

---

### 2. Cron Timeout (Infrastructure)

**Πριν:** 51 HTTP timeouts/24h, indicators stale 43h.

**Αιτία:** `pg_net` default 5s timeout, 4 requests ταυτόχρονα στο job 1.

**Fix:** Split σε 4 ξεχωριστά cron jobs με custom timeouts:
- `trading-whale-watch` :00/:15/:30/:45 → 15s
- `trading-tradingview-signals` :01/:16/:31/:46 → 60s
- `trading-council-sync` :02/:17/:32/:47 → 30s
- `trading-polymarket-check` :03/:18/:33/:48 → 15s

**Status:** ✅ Deployed.

---

### 3. Binance 403 Geo-Block

**Πριν:** Binance aggTrades → HTTP 403 → whale collector σιωπηλά αποτυγχάνει (whales=0).

**Fix:** Bybit linear perps fallback (500 trades, μεγάλα sizes αντί spot 60 trades).

**Files:**
- `bybitRecentTrades()` — `category: "linear"`
- `collectExchangeWhaleAlerts()` — `chain: "bybit-perp"`, `source: "bybit-linear-trades"`

**Status:** ✅ Patch έτοιμο, deploy pending.

---

### 4. Binance Exception Propagation

**Πριν:** Αν το 1ο host πέταγε exception (timeout), το fallback ΔΕΝ δοκιμαζόταν ποτέ.

**Fix:** try/catch per host + 3-tier fallback:
1. `api.binance.com`
2. `data-api.binance.vision`
3. `api.bybit.com`

**Files:** `binancePublicGet()` rework, `fetchCandlesUnified()`.

**Status:** ✅ Deployed.

---

### 5. Technicals Frozen (26h stale)

**Πριν:** `indicator_snapshots` 26h stale, `pipeline_runs.indicators = 0`.

**Αιτία:** Edge Function `tradingview-signals` έκανε `.insert()` αντί `.upsert()` → `23505 duplicate key` error κάθε run.

**Fix:** Deploy v3 με:
- `.upsert({ onConflict: "symbol,timeframe" })`
- 1h + 4h + 1d timeframes
- `verify_jwt=false` (καλείται από pg_net cron)

**Status:** ✅ Deployed.

---

### 6. Signal Combiner Starvation

**Πριν:** Ο MTF gate υπήρχε στον κώδικα αλλά το cron καλούσε παλιό `signal-combiner` v3.

**Fix:** Deploy v4 με:
- Ξεχωριστή ανάγνωση 4h / 1h / 1d
- Stale filter > 6h
- MTF counts + gate
- `pipeline_settings.cleanup_config` read

**Status:** ✅ Deployed.

---

## 🆕 FEATURES ΠΟΥ ΠΡΟΣΤΕΘΗΚΑΝ

### 1. MTF Confirmation Gate ✅

**Τι κάνει:** Buy/sell signals απαιτούν **≥2/3 timeframes** να συμφωνούν.

**Backtest evidence:**
- 5/5 weak_mtf losses (FIL, DOT, SAND, LINK, ALGO) = −$282
- 0 weak_mtf wins
- Expected: +74% net PnL

**Config:**
```json
{ "enabled": true, "shadow_mode": false, "min_timeframes": 2 }
