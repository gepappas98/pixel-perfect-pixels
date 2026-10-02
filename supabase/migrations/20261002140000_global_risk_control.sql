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
