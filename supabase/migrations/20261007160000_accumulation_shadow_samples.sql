-- Accumulation / breakout experiment.
-- Shadow-only: no writes to trades, composite execution, or Shadow V2 positions.
-- First external instrument: CrediaBank (CREDIA.AT), daily Yahoo Finance candles.

CREATE TABLE IF NOT EXISTS public.accumulation_shadow_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument text NOT NULL,
  display_symbol text NOT NULL,
  asset_class text NOT NULL DEFAULT 'equity',
  timeframe text NOT NULL,
  data_source text NOT NULL,
  candle_time timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  price numeric NOT NULL,
  ma20 numeric NULL,
  ma50 numeric NULL,
  cmf20 numeric NULL,
  obv numeric NULL,
  obv_change_pct20 numeric NULL,
  atr14 numeric NULL,
  atr_pct numeric NULL,
  atr_compression_pct numeric NULL,
  volume numeric NULL,
  avg_volume20 numeric NULL,
  volume_ratio numeric NULL,
  support20 numeric NULL,
  resistance20 numeric NULL,
  breakout_confirmed boolean NOT NULL DEFAULT false,
  accumulation_score numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'NEUTRAL'
    CHECK (status IN ('NEUTRAL','ACCUMULATION_WATCH','BREAKOUT_CONFIRMED')),
  outcome_1d_pct numeric NULL,
  outcome_3d_pct numeric NULL,
  outcome_5d_pct numeric NULL,
  outcome_1d_price numeric NULL,
  outcome_3d_price numeric NULL,
  outcome_5d_price numeric NULL,
  resolved_at timestamptz NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instrument, timeframe, candle_time)
);

CREATE INDEX IF NOT EXISTS idx_accum_shadow_instrument_time
  ON public.accumulation_shadow_samples (instrument, timeframe, candle_time DESC);

CREATE INDEX IF NOT EXISTS idx_accum_shadow_status
  ON public.accumulation_shadow_samples (status, candle_time DESC);

ALTER TABLE public.accumulation_shadow_samples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accumulation_shadow_public_read
  ON public.accumulation_shadow_samples;

CREATE POLICY accumulation_shadow_public_read
  ON public.accumulation_shadow_samples
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.accumulation_shadow_samples
  FROM anon, authenticated;

GRANT SELECT ON public.accumulation_shadow_samples TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.accumulation_shadow_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accumulation_shadow_touch_updated_at
  ON public.accumulation_shadow_samples;

CREATE TRIGGER trg_accumulation_shadow_touch_updated_at
BEFORE UPDATE ON public.accumulation_shadow_samples
FOR EACH ROW
EXECUTE FUNCTION public.accumulation_shadow_touch_updated_at();

NOTIFY pgrst, 'reload schema';
