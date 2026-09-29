-- Consolidated Lovable Cloud fixes.
-- Idempotent by design so it is safe to apply to an existing database.
BEGIN;

-- Keep database constraints aligned with the pipeline's supported close reasons.
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_close_reason_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN (
    'stop_loss', 'take_profit', 'manual', 'stale_exit', 'expired',
    'rotated_out', 'duplicate_cleanup'
  ));

ALTER TABLE public.trade_alerts DROP CONSTRAINT IF EXISTS trade_alerts_event_type_check;
ALTER TABLE public.trade_alerts ADD CONSTRAINT trade_alerts_event_type_check
  CHECK (event_type IN (
    'stop_loss', 'take_profit', 'manual', 'stale_exit', 'expired',
    'rotated_out', 'duplicate_cleanup'
  ));

-- Shadow-mode diagnostics emitted by combineSignals.
CREATE TABLE IF NOT EXISTS public.shadow_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  current_recommendation text NOT NULL,
  would_be_recommendation text NOT NULL,
  score numeric,
  confidence numeric,
  reasoning text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_conflicts_time
  ON public.shadow_conflicts (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_conflicts_symbol
  ON public.shadow_conflicts (symbol, detected_at DESC);
ALTER TABLE public.shadow_conflicts ENABLE ROW LEVEL SECURITY;

-- The application pipeline owns trade closing; remove the legacy DB closer.
DROP FUNCTION IF EXISTS public.check_and_close_trades();

-- Exclude duplicate cleanup rows from portfolio performance calculations.
CREATE OR REPLACE FUNCTION public.get_portfolio_summary()
RETURNS TABLE (
  open_count bigint, open_notional numeric, closed_count bigint, realized_pnl numeric,
  win_rate_pct numeric, win_count bigint, loss_count bigint, gross_profit numeric, gross_loss numeric,
  profit_factor numeric, avg_win_usd numeric, avg_loss_usd numeric, last_24h_closed bigint, last_24h_pnl numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH open_stats AS (
    SELECT count(*) AS open_count,
      coalesce(sum(entry_price * quantity), 0) AS open_notional
    FROM public.trades WHERE status = 'open'
  ),
  closed_stats AS (
    SELECT count(*) AS closed_count, coalesce(sum(pnl), 0) AS realized_pnl,
      count(*) FILTER (WHERE pnl > 0) AS win_count,
      count(*) FILTER (WHERE pnl < 0) AS loss_count,
      coalesce(sum(pnl) FILTER (WHERE pnl > 0), 0) AS gross_profit,
      coalesce(abs(sum(pnl) FILTER (WHERE pnl < 0)), 0) AS gross_loss,
      coalesce(avg(pnl) FILTER (WHERE pnl > 0), 0) AS avg_win,
      coalesce(avg(pnl) FILTER (WHERE pnl < 0), 0) AS avg_loss
    FROM public.trades
    WHERE status = 'closed'
      AND (close_reason IS NULL OR close_reason <> 'duplicate_cleanup')
  ),
  recent AS (
    SELECT count(*) AS last_24h_closed, coalesce(sum(pnl), 0) AS last_24h_pnl
    FROM public.trades
    WHERE status = 'closed' AND closed_at >= now() - interval '24 hours'
      AND (close_reason IS NULL OR close_reason <> 'duplicate_cleanup')
  )
  SELECT os.open_count, os.open_notional, cs.closed_count, cs.realized_pnl,
    CASE WHEN cs.closed_count > 0
      THEN round((cs.win_count::numeric / cs.closed_count) * 100, 2) ELSE 0 END,
    cs.win_count, cs.loss_count, cs.gross_profit, cs.gross_loss,
    CASE WHEN cs.gross_loss > 0 THEN round((cs.gross_profit / cs.gross_loss)::numeric, 2) ELSE NULL END,
    round(cs.avg_win::numeric, 2), round(cs.avg_loss::numeric, 2),
    r.last_24h_closed, r.last_24h_pnl
  FROM open_stats os, closed_stats cs, recent r;
$$;
GRANT EXECUTE ON FUNCTION public.get_portfolio_summary() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- price_at and cleanup_config are supplied by their dedicated migrations.
-- This migration intentionally does not duplicate those ALTER TABLE statements.
