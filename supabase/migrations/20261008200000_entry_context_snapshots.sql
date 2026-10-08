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

ALTER TABLE public.entry_context_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.entry_context_snapshots FROM anon, authenticated;
GRANT ALL ON TABLE public.entry_context_snapshots TO service_role;
