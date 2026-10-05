-- Shadow V2 persistent execution-policy rehearsal.
-- Intentionally isolated from public.trades and strategy_variant_signals.

CREATE TABLE IF NOT EXISTS public.shadow_v2_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  signal_id uuid NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  signal_created_at timestamptz NOT NULL,
  entry_timestamp timestamptz NOT NULL,
  entry_price numeric NOT NULL,
  take_profit_price numeric NOT NULL,
  stop_loss_price numeric NOT NULL,
  expiry_timestamp timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  exit_timestamp timestamptz NULL,
  exit_price numeric NULL,
  exit_reason text NULL CHECK (exit_reason IS NULL OR exit_reason IN ('TP','SL','EXPIRED')),
  gross_pnl_usd numeric NOT NULL DEFAULT 0,
  entry_fee_usd numeric NOT NULL DEFAULT 0,
  exit_fee_usd numeric NOT NULL DEFAULT 0,
  fees_usd numeric NOT NULL DEFAULT 0,
  net_pnl_usd numeric NOT NULL DEFAULT 0,
  gross_pnl_pct numeric NOT NULL DEFAULT 0,
  fees_pct numeric NOT NULL DEFAULT 0,
  net_pnl_pct numeric NOT NULL DEFAULT 0,
  ambiguous_intrabar boolean NOT NULL DEFAULT false,
  ambiguity_reason text NULL,
  performance_mode text NOT NULL DEFAULT 'DEDUPLICATED'
    CHECK (performance_mode IN ('RAW','EXECUTABLE','DEDUPLICATED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_v2_open_symbol
  ON public.shadow_v2_positions (symbol, status)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_shadow_v2_created_at
  ON public.shadow_v2_positions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shadow_v2_expiry
  ON public.shadow_v2_positions (expiry_timestamp)
  WHERE status = 'OPEN';

ALTER TABLE public.shadow_v2_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shadow_v2_public_read ON public.shadow_v2_positions;
CREATE POLICY shadow_v2_public_read
  ON public.shadow_v2_positions
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.shadow_v2_positions
  FROM anon, authenticated;

GRANT SELECT ON public.shadow_v2_positions TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.shadow_v2_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shadow_v2_touch_updated_at
  ON public.shadow_v2_positions;

CREATE TRIGGER trg_shadow_v2_touch_updated_at
BEFORE UPDATE ON public.shadow_v2_positions
FOR EACH ROW
EXECUTE FUNCTION public.shadow_v2_touch_updated_at();

NOTIFY pgrst, 'reload schema';
