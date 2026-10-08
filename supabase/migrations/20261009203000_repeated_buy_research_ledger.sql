-- Append-only research ledger for sequential BUY observations and concentration counterfactual.
CREATE TABLE IF NOT EXISTS public.repeated_buy_research_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_at timestamptz NOT NULL DEFAULT now(),
  composite_signal_id uuid REFERENCES public.composite_signals(id) ON DELETE SET NULL,
  signal_fingerprint text,
  symbol text NOT NULL,
  recommendation text NOT NULL,
  confidence numeric,
  signal_reasoning text,
  signal_price numeric,
  signal_created_at timestamptz,
  research_decision text NOT NULL DEFAULT 'pending',
  research_reason text,
  trade_id uuid REFERENCES public.trades(id) ON DELETE SET NULL,
  entry_at timestamptz,
  entry_price numeric,
  entry_quantity numeric,
  entry_notional numeric,
  entry_fee numeric NOT NULL DEFAULT 0,
  exit_at timestamptz,
  exit_price numeric,
  gross_pnl numeric,
  total_fees numeric,
  net_pnl numeric,
  markout_15m_price numeric,
  markout_15m_at timestamptz,
  markout_15m_pct numeric,
  markout_1h_price numeric,
  markout_1h_at timestamptz,
  markout_1h_pct numeric,
  markout_4h_price numeric,
  markout_4h_at timestamptz,
  markout_4h_pct numeric,
  markout_24h_price numeric,
  markout_24h_at timestamptz,
  markout_24h_pct numeric,
  markout_72h_price numeric,
  markout_72h_at timestamptz,
  markout_72h_pct numeric,
  limited_position_decision text,
  limited_position_reason text,
  limited_position_trade_id uuid REFERENCES public.trades(id) ON DELETE SET NULL,
  limited_position_entry_price numeric,
  limited_position_entry_at timestamptz,
  limited_position_markout_15m_pct numeric,
  limited_position_markout_1h_pct numeric,
  limited_position_markout_4h_pct numeric,
  limited_position_markout_24h_pct numeric,
  limited_position_markout_72h_pct numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_repeated_buy_ledger_symbol_observed
  ON public.repeated_buy_research_ledger(symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_repeated_buy_ledger_signal
  ON public.repeated_buy_research_ledger(composite_signal_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_repeated_buy_ledger_pending_markouts
  ON public.repeated_buy_research_ledger(observed_at)
  WHERE recommendation = 'buy';
ALTER TABLE public.repeated_buy_research_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repeated_buy_ledger_service_role_all ON public.repeated_buy_research_ledger;
CREATE POLICY repeated_buy_ledger_service_role_all
  ON public.repeated_buy_research_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.repeated_buy_research_ledger TO service_role;
COMMENT ON TABLE public.repeated_buy_research_ledger IS
  'Observational ledger for every BUY evaluation; tracks actual research execution, fixed-horizon markouts and a one-open-position-per-symbol counterfactual. Does not control execution.';
