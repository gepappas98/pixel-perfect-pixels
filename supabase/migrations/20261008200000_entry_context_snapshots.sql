-- Immutable research snapshot captured at every successful trade Open.
-- Service-role only: the snapshot may contain raw upstream inputs.

CREATE TABLE IF NOT EXISTS public.entry_context_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id uuid NOT NULL UNIQUE REFERENCES public.trades(id) ON DELETE CASCADE,
  composite_signal_id uuid NULL REFERENCES public.composite_signals(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entry_context_snapshots_captured_at
  ON public.entry_context_snapshots (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_context_snapshots_symbol
  ON public.entry_context_snapshots (symbol, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_context_snapshots_composite_signal_id
  ON public.entry_context_snapshots (composite_signal_id);

ALTER TABLE public.entry_context_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.entry_context_snapshots FROM anon, authenticated;
GRANT ALL ON TABLE public.entry_context_snapshots TO service_role;


-- Integrity hardening: guarantee a placeholder snapshot exists atomically with every trade.
-- The execution layer upgrades this row to capture_status=complete after collecting upstream context.

CREATE OR REPLACE FUNCTION public.ensure_entry_context_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.entry_context_snapshots (
    trade_id,
    composite_signal_id,
    symbol,
    captured_at,
    snapshot
  )
  VALUES (
    NEW.id,
    NEW.composite_signal_id,
    NEW.symbol,
    COALESCE(NEW.created_at, now()),
    jsonb_build_object(
      'schema_version', 2,
      'capture_status', 'pending',
      'captured_at', COALESCE(NEW.created_at, now()),
      'trade', jsonb_build_object(
        'id', NEW.id,
        'composite_signal_id', NEW.composite_signal_id,
        'symbol', NEW.symbol,
        'side', NEW.side,
        'quantity', NEW.quantity,
        'entry_price', NEW.entry_price,
        'stop_loss', NEW.stop_loss,
        'take_profit', NEW.take_profit,
        'mode', NEW.mode,
        'status', NEW.status,
        'entry_fee', NEW.entry_fee,
        'exchange_order_id', NEW.exchange_order_id,
        'regime_label', NEW.regime_label,
        'market_session', NEW.market_session,
        'source_tags', NEW.source_tags,
        'created_at', NEW.created_at
      )
    )
  )
  ON CONFLICT (trade_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trades_entry_context_snapshot ON public.trades;

CREATE TRIGGER trg_trades_entry_context_snapshot
AFTER INSERT ON public.trades
FOR EACH ROW
EXECUTE FUNCTION public.ensure_entry_context_snapshot();
