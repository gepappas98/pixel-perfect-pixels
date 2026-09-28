📚 Trading Command Center — Πλήρες Ιστορικό Ανάπτυξης

Ακολουθεί ένα ολοκληρωμένο αρχείο που συνοψίζει όλα όσα κάναμε στη συζήτηση. Αποθήκευσέ το ως DEVELOPMENT_HISTORY.md στο project.

---

```markdown
# Trading Command Center — Development History
> Complete record of all changes, features, and decisions from initial setup to v2.0

---

## 📋 Πίνακας Περιεχομένων

1. [Επισκόπηση Project](#1-επισκόπηση-project)
2. [Αρχιτεκτονική](#2-αρχιτεκτονική)
3. [Όλα τα Αρχεία](#3-όλα-τα-αρχεία)
4. [Bugs που Διορθώθηκαν](#4-bugs-που-διορθώθηκαν)
5. [Features που Προστέθηκαν](#5-features-που-προστέθηκαν)
6. [Database Migrations](#6-database-migrations)
7. [Deployment Order](#7-deployment-order)
8. [Environment Variables](#8-environment-variables)
9. [Known Issues / TODO](#9-known-issues--todo)
10. [Roadmap](#10-roadmap)

---

## 1. Επισκόπηση Project

**Τι είναι:** Αυτόνομο crypto trading bot με multi-source evidence aggregation.

**Stack:**
- Frontend: React 19 + TanStack Start + Tailwind CSS + shadcn/ui
- Backend: Supabase (PostgreSQL + RLS + PostgREST + Realtime)
- AI: Groq (GPT-OSS-20B) + Pollinations/DuckDuckGo (fallback)
- Data sources: Binance (spot), Hyperliquid (perps), Polymarket (prediction markets)

**Κατάσταση:** Paper mode, λειτουργικό, σε συνεχή ανάπτυξη.

**Realized PnL έως τώρα:** +$217 (1 trade, 100% win rate)
**Unrealized PnL:** ~+$310 (3 open positions)

---

## 2. Αρχιτεκτονική

### Pipeline Flow (κάθε 10 λεπτά)

```

1. collectWhaleAlerts (Hyperliquid)
2. collectExchangeWhaleAlerts (Binance)
3. collectIndicators (3 timeframes × 95 coins)
4. collectPredictions (Polymarket)
5. collectCouncilSignals (Groq AI + deterministic)
6. combineSignals (weighted scoring)
7. executeTrades (with rotation)
8. generatePostMortems (learning)

```

### Decision Logic

| Source | Max Score | Weight (default) |
|---|---|---|
| Whale Flow | ±1.0 | 1.0 |
| Technicals (MTF) | ±1.69 | 1.0 |
| Predictions | ±0.5 | 1.0 |
| AI Council | ±0.75 | 1.0 |
| **Total** | **±3.94** | user-tunable |

**Thresholds:**
- Buy if score ≥ 1.5
- Sell if score ≤ −1.5
- Watch if |score| < 1.5 with ≥ 2 signals
- Hold if |score| < 0.5 (dropped from feed)

### Risk Management

| Rule | Value |
|---|---|
| Max risk per trade | 0.25% equity |
| Max portfolio risk | 2.0% equity |
| Daily loss limit | 2.0% (Athens TZ) |
| Max open positions | 8 |
| Stop loss | −3% |
| Take profit | +4% |
| Symbol cooldown | 15 min |

---

## 3. Όλα τα Αρχεία

### Backend / Server

| Αρχείο | Ρόλος |
|---|---|
| `src/lib/pipeline.server.ts` | Κύριο pipeline — whales, technicals, council, signals, trades |
| `src/lib/pipeline.functions.ts` | Server functions για run/status/health |
| `src/lib/risk.engine.ts` | Risk management + position sizing |
| `src/lib/fees.ts` | Fee-aware PnL calculation |
| `src/lib/council-learning.ts` | Post-mortem generation + RAG retrieval |
| `src/lib/strategy.presets.ts` | Client-safe strategy presets |
| `src/lib/strategy.functions.ts` | Server functions για strategy config |
| `src/lib/market-regime.functions.ts` | Market regime detector |
| `src/lib/admin.functions.ts` | Reset data + clear stale signals |
| `src/lib/schedule.functions.ts` | Auto-run interval config |
| `src/lib/ai-risk.functions.ts` | AI Risk Summary (Groq) |
| `src/lib/trading-types.ts` | TypeScript types |

### Frontend Components

| Component | Ρόλος |
|---|---|
| `SignalFeed.tsx` | Deduplicated signals (per symbol) |
| `WhalePanel.tsx` | Live whale prints |
| `IndicatorPanel.tsx` | Technicals (4h, deduplicated) |
| `PredictionPanel.tsx` | Top prediction markets by volume |
| `CouncilPanel.tsx` | AI council verdicts |
| `RegimePanel.tsx` | Market regime + strategy suggestion |
| `StrategyPanel.tsx` | User-tunable weights + presets |
| `LessonsPanel.tsx` | Post-mortem lessons |
| `AIRiskSummary.tsx` | Ad-hoc AI query |
| `CronHealthPanel.tsx` | Pipeline monitoring + errors |
| `PortfolioPanel.tsx` | Aggregate metrics |
| `TradesPanel.tsx` | Open positions + live PnL |
| `TradeAlertsPanel.tsx` | Closed positions history |
| `SupportDeveloper.tsx` | BTC tip section |

### Routes

| Route | Ρόλος |
|---|---|
| `src/routes/index.tsx` | Main dashboard |
| `src/routes/about.tsx` | Bilingual guide page |

### Migrations

| Migration | Ρόλος |
|---|---|
| `20250925130000_pipeline_fixes.sql` | pipeline_runs, pipeline_settings, indicator_snapshots unique |
| `20250925140000_ai_risk_summary.sql` | ai_summary_requests (deprecated) |
| `20250925150000_trades_dedup.sql` | trades one-open-per-symbol index |
| `20250928130000_council_learning.sql` | council_lessons table |
| `20250928140000_strategy_config.sql` | strategy_config table |

---

## 4. Bugs που Διορθώθηκαν

### 🔴 Critical (αρχικά)

| # | Bug | Fix |
|---|---|---|
| 1 | Technicals frozen για 4h (ignoreDuplicates) | `ignoreDuplicates: false` + `created_at: now()` |
| 2 | Hegseth cleanup σε κάθε run | Αφαιρέθηκε εντελώς |
| 3 | Pipeline Health error (missing table) | `pipeline_runs` migration |
| 4 | HL cache poison | `ts: 0` στο catch, όχι empty cache |
| 5 | Signal Feed spam (100+ hold 0%) | Skip `hold && confidence === 0` |
| 6 | HOLD 100% conviction | `conviction = 0` για HOLD |

### 🟡 Substantial

| # | Bug | Fix |
|---|---|---|
| 7 | Prediction semantic inversion | `predictionDirection()` με regex |
| 8 | Fingerprint volatile timestamps | Αφαιρέθηκαν από fingerprint |
| 9 | Live trades never closed | Extended closeTriggeredTrades |
| 10 | Sequential price fetch (N calls) | Batch `/ticker/price` |
| 11 | Duplicate trades (race condition) | Partial unique index |
| 12 | Portfolio summary missing | RPC function |
| 13 | HL HTTP 500 (unsupported coins) | Universe filtering |
| 14 | SignalFeed limit 15 → missed open | Direct query with `.eq("status", "open")` |
| 15 | Regime reasoning wrong count | `techBear` instead of `techBull` |
| 16 | Watch spam (20+ signals) | Require ≥ 2 signals |

### 🟢 Minor

| # | Bug | Fix |
|---|---|---|
| 17 | Sequential pMap → timeout | Concurrency 10-15 |
| 18 | Watch panel 4h only (multi-TF) | Filter `timeframe === "4h"` |
| 19 | Quantity validation | `Number.isFinite` check |
| 20 | Trades never age out | Stale 48h + expired 7d |

---

## 5. Features που Προστέθηκαν

### Core Features

- ✅ **Multi-source signal aggregation** (whale + techs + predictions + AI)
- ✅ **Multi-timeframe technicals** (4h + 1h + 1d confluence)
- ✅ **AI Council** via Groq (batched, rate-limited)
- ✅ **Deterministic fallback** for council
- ✅ **Signal rotation** (close weakest for stronger new signal)
- ✅ **Time-based exits** (stale 48h, expired 7d)
- ✅ **Fee-aware PnL** everywhere

### Learning System

- ✅ **Post-mortem generation** after each closed trade
- ✅ **RAG retrieval** — lessons fed back into AI prompts
- ✅ **Outcome tagging** (win/loss/breakeven)

### Regime & Strategy

- ✅ **Market Regime detector** — reads whole market
- ✅ **6 presets**: Balanced, Whale, Chart, Sentiment, AI, Conservative
- ✅ **User-tunable weights** with save to DB
- ✅ **Auto-suggest strategy** based on regime

### Protection

- ✅ **PIN-protected** Run Pipeline (server-side)
- ✅ **PIN-protected** Reset Data (preserves trades + lessons)
- ✅ **Atomic pipeline lock** (unique index on running state)
- ✅ **Atomic trade lock** (one open per symbol)

### UI/UX

- ✅ **Deduplicated Signal Feed** (one row per symbol)
- ✅ **Full timestamps** in Closed Positions
- ✅ **Copy-to-clipboard** BTC tip address
- ✅ **About page** — bilingual EN
- ✅ **Multiple warning/error panels**

---

## 6. Database Migrations

### Πλήρης λίστα (χρονολογική σειρά)

```sql
-- 1. 20250925130000_pipeline_fixes.sql
CREATE TABLE pipeline_runs (...)
CREATE TABLE pipeline_settings (...)
ALTER TABLE indicator_snapshots ADD CONSTRAINT unique (symbol, timeframe)

-- 2. 20250925150000_trades_dedup.sql
CREATE UNIQUE INDEX trades_one_open_per_symbol ON trades (symbol) WHERE status = 'open'
CREATE VIEW portfolio_summary AS (...)

-- 3. 20250928130000_council_learning.sql
CREATE TABLE council_lessons (...)
ALTER TABLE trades ADD COLUMN post_mortem_generated boolean

-- 4. 20250928140000_strategy_config.sql
CREATE TABLE strategy_config (...)
INSERT INTO strategy_config (id) VALUES (1)
```

Optional (αν χρειαστεί)

```sql
-- Fee columns στο trades
ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_price numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS gross_pnl numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS net_pnl numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_fee numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_fee numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS total_fees numeric;

-- RPC functions
CREATE FUNCTION get_portfolio_summary() RETURNS TABLE (...)
```

---

7. Deployment Order

Πρώτη εγκατάσταση (fresh setup)

```
1. Apply migrations (all 4 in order)
2. Create files (backend):
   - src/lib/risk.engine.ts
   - src/lib/fees.ts
   - src/lib/trading-types.ts
   - src/lib/strategy.presets.ts
   - src/lib/strategy.functions.ts
   - src/lib/council-learning.ts
   - src/lib/market-regime.functions.ts
   - src/lib/admin.functions.ts
   - src/lib/pipeline.functions.ts
   - src/lib/pipeline.server.ts
3. Create components (frontend):
   - All panels in src/components/trading/
   - src/routes/index.tsx
   - src/routes/about.tsx
4. Rebuild + deploy
5. Run pipeline manually (PIN: 5155)
```

Κατά την ενημέρωση υπάρχουσας εγκατάστασης

```
1. Apply only the NEW migrations
2. Replace changed files (see section 3)
3. Rebuild + deploy
4. Test in this order:
   - Regime panel refreshes
   - Strategy panel loads config
   - Run pipeline with PIN works
   - Reset data with PIN works
```

---

8. Environment Variables

```env
# Required
SUPABASE_URL=<your-supabase-url>
SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

# Trading
TRADING_MODE=paper           # paper | live
ENABLE_LIVE_TRADING=false    # safety flag
BINANCE_API_KEY=             # required only for live
BINANCE_API_SECRET=          # required only for live

# AI
GROQ_API_KEY=<your-groq-key>
GROQ_MODEL=openai/gpt-oss-20b
```

Σημείωση: Το PIN 5155 είναι hardcoded στο server-side code (pipeline.functions.ts + admin.functions.ts). Αλλάξτε το πριν production.

---

9. Known Issues / TODO

🟡 Πρέπει να λυθούν

☐ Council Lessons = 0 — Θα γεμίσει όταν κλείσουν trades. Ο BONK είναι +6.44%, θα κλείσει στο επόμενο run.
☐ Watch spam — Κάποια low-conviction watch signals περνούν ακόμα. Θα μπορούσε να αυξηθεί το threshold.
☐ AI council 97 HOLD — Αναμενόμενο σε sideways market. Θα βελτιωθεί όταν τρέντ.
☐ Strategy preset persistence — Λειτουργεί, αλλά το UI κάνει refresh μόνο όταν ανοίγει το panel.

🟢 Cosmetic

☐ "0 whale prints · 0 technicals" στο header — Δείχνει νέα inserts, όχι fetched count.
☐ Stale signals στο feed — Παλιά signals μένουν μέχρι να λήξουν (30 min freshness).
☐ Αρίθμηση trades — Το TradeAlertsPanel δείχνει max 20.

🔵 Future Enhancements

☐ Vector embeddings για cross-symbol lessons
☐ Backtesting engine
☐ Multi-timeframe confirmation (4h + 1h + 1d — έχει ήδη υλοποιηθεί)
☐ Live trading mode activation
☐ Mobile app
☐ Expanded watchlist (200+ coins)

---

10. Roadmap

Phase 1 (Ολοκληρωμένο ✅)

· Core pipeline
· Multi-source signals
· Risk management
· Basic UI

Phase 2 (Ολοκληρωμένο ✅)

· Multi-timeframe
· Learning system
· Signal rotation
· Time-based exits
· Market regime
· Custom strategies
· PIN protection

Phase 3 (Σε εξέλιξη 🚧)

· Vector embeddings για lessons
· Backtesting engine
· Adaptive strategy switching

Phase 4 (Μελλοντικό)

· Live trading με strict safety gates
· Mobile app
· Multi-user support
· Webhook notifications

---

11. Σημαντικοί Κανόνες

Όταν αλλάζεις κάτι στο pipeline:

1. Ποτέ μην αφαιρέσεις το pipeline_runs insert — είναι atomic mutex
2. Ποτέ μην αφαιρέσεις το trades_one_open_per_symbol index — προστατεύει από duplicates
3. Πάντα έλεγξε το error_message όταν αποτυγχάνει pipeline
4. Πάντα τρέξε σε paper mode πρώτα
5. Ποτέ μην αγγίξεις τα pipeline_settings manually — χρησιμοποίησε το UI

Όταν αλλάζεις strategy weights:

· Οι αλλαγές δεν αλλάζουν τα thresholds (buy=1.5, sell=−1.5)
· Αλλάζουν το max score για confidence calculation
· Επηρεάζουν μόνο το composite signal, όχι τις πηγές

Όταν αλλάζεις risk parameters:

· Πολύ σημαντικό — επηρεάζουν κάθε νέο trade
· Άλλαξε τα μόνο στο risk.engine.ts, όχι inline
· Μετά την αλλαγή, τρέξε 1-2 κύκλους παρακολούθησης

---

12. Debugging Guide

Pipeline failed

```
1. Δες Pipeline Health → Recent Errors
2. Το error έχει format: [step: <name>] <message>
3. Βρες το step name στο runFullPipeline
4. Διόρθωσε το αντίστοιχο collect* function
```

Trades δεν ανοίγουν

```
1. Δες server logs για [RISK_REJECTED]
2. Portfolio risk cap → δες Portfolio Summary
3. Daily loss limit → Athens timezone check
4. Max positions → δες open count
```

Signals δεν εμφανίζονται

```
1. Δες Composite Signals panel — είναι κενό;
2. Δες Council Panel — έχεις verdicts;
3. Δες Technicals — έχεις indicators;
4. Αν 1+ από τα 2 τελευταία έχει δεδομένα → check combineSignals logs
```

---

13. Συνολικό Status

Μέρος Status
Pipeline ✅ Λειτουργικό
Data collection ✅ 4 sources
Signal generation ✅ Weighted, thresholded
Risk management ✅ 5-layer protection
Trade execution ✅ Paper mode
Learning loop 🟡 Περιμένει first closed trade
Regime detector ✅ Λειτουργικό
Strategy config ✅ Λειτουργικό
UI/UX ✅ 14 panels
Documentation ✅ This file + About page

---

14. Contact & Support

Developer Email: gepappas98@gmail.com
BTC Tips: bc1q0d0ccaxuw065ezdulr68azp2fjhc0avaqf0pyz

Σημείωση: Για να συνεχίσουμε σε νέο chat, απλά στείλε αυτό το αρχείο + όποιο panel θέλεις να δουλέψουμε.

---

15. Changelog

v2.0 — Current

· Multi-timeframe analysis
· Learning system (post-mortems + RAG)
· Signal rotation
· Time-based exits
· Market regime detector
· Custom strategy presets
· PIN protection
· About page
· Support developer

v1.0 — Initial

· Basic pipeline
· Single timeframe
· Simple signal combination
· Paper mode
· Core panels

---

Τέλος αρχείου.

Generated: 2026-09-28
For the next session: send this file and we continue where we left off.

```

---

## 📌 Πώς να το χρησιμοποιήσεις

1. **Αντίγραψε** όλο το markdown block πιο πάνω
2. **Αποθήκευσέ το** ως `DEVELOPMENT_HISTORY.md` στο root του project
3. **Commit** στο GitHub:
   ```bash
   git add DEVELOPMENT_HISTORY.md
   git commit -m "docs: complete development history v2.0"
   git push
```

🎯 Για την επόμενη συνεδρία

Όταν ανοίξεις νέα συζήτηση (γιατί αυτή φτάνει στο όριο), απλά:

1. Στείλε το DEVELOPMENT_HISTORY.md (ή ένα link στο GitHub)
2. Πες μου τι θέλεις να δουλέψουμε — π.χ.:
   · «Συνέχισε από Phase 3: vector embeddings»
   · «Ο BONK έκλεισε, θέλω να δω τι έμαθε»
   · «Το pipeline έχει αυτό το error: [μήνυμα]»
3. Θα έχω πλήρη εικόνα από την αρχή

✅ Τι διασφαλίζεται

Κατηγορία Πληροφορία
Αρχεία Όλα τα paths + ρόλοι
Bugs Όλα τα 20 + fixes
Features 25+ καταγεγραμμένα
Migrations 4 με χρονολογική σειρά
Env vars Πλήρης λίστα
Debugging 3 common scenarios
Roadmap 4 phases
Contact Email + BTC address

Τίποτα δεν χάνεται. 🎯
