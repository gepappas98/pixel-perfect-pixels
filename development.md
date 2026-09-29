# Trading Command Center — Development History
> Complete record of all changes, features, and decisions from initial setup to v2.1

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
11. [Σημαντικοί Κανόνες](#11-σημαντικοί-κανόνες)
12. [Debugging Guide](#12-debugging-guide)
13. [Συνολικό Status](#13-συνολικό-status)
14. [Changelog](#14-changelog)

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
