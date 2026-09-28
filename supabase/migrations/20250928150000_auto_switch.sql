-- ══════════════════════════════════════════════════════════════
-- Auto-Adaptive Strategy
-- Adds columns to strategy_config for AI-driven preset switching.
-- The pipeline calls an AI (Groq) on a schedule (1-24h) and lets it
-- pick the best strategy preset for the current market state.
-- ══════════════════════════════════════════════════════════════

-- 1. Master switch — disabled by default (user must opt-in)
alter table strategy_config
  add column if not exists auto_switch_enabled boolean not null default false;

-- 2. How often the AI re-evaluates (in hours)
--    Range: 1 to 24 hours
alter table strategy_config
  add column if not exists auto_switch_interval_hours integer not null default 4
    check (auto_switch_interval_hours >= 1 and auto_switch_interval_hours <= 24);

-- 3. Timestamp of the last AI-driven switch
--    Used for cooldown enforcement (min 30 min between checks)
alter table strategy_config
  add column if not exists last_auto_switch_at timestamptz;

-- 4. Human-readable reasoning from the AI's last decision
--    Shown in the StrategyPanel UI for full transparency
alter table strategy_config
  add column if not exists last_auto_reasoning text;

-- 5. Force PostgREST schema cache reload so the new columns
--    are visible to the frontend immediately
notify pgrst, 'reload schema';
