-- Persistent, deduplicated alarms for open positions that appear due to exit but remain open.
-- The watchdog never closes trades; it only records/clears alarms.
CREATE TABLE IF NOT EXISTS public.trade_position_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text NOT NULL UNIQUE,
  trade_id uuid NULL REFERENCES public.trades(id) ON DELETE SET NULL,
  symbol text NULL,
  alert_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  message text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trade_position_alerts_active_idx
  ON public.trade_position_alerts (status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS trade_position_alerts_trade_idx
  ON public.trade_position_alerts (trade_id, last_seen_at DESC);
ALTER TABLE public.trade_position_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read position watchdog alerts" ON public.trade_position_alerts;
CREATE POLICY "Public read position watchdog alerts"
  ON public.trade_position_alerts FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.trade_position_alerts FROM anon, authenticated, public;
GRANT SELECT ON public.trade_position_alerts TO anon, authenticated;
GRANT ALL ON public.trade_position_alerts TO service_role;
