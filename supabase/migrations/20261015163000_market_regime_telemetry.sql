-- Forward-only telemetry for BTC/Whale Flow divergence experiments.
-- No production trades or strategy settings are modified by this table.

CREATE TABLE IF NOT EXISTS public.market_regime_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data_status TEXT NOT NULL DEFAULT 'ok',
  btc_source TEXT,
  btc_price NUMERIC,
  btc_sma_24h NUMERIC,
  btc_return_4h_pct NUMERIC,
  btc_return_24h_pct NUMERIC,
  btc_below_sma_24h BOOLEAN,
  btc_is_downtrend BOOLEAN,
  whale_net NUMERIC NOT NULL,
  shadow_whale_net NUMERIC NOT NULL,
  tech_breadth NUMERIC NOT NULL,
  council_consensus NUMERIC NOT NULL,
  baseline_score NUMERIC NOT NULL,
  baseline_regime TEXT NOT NULL CHECK (baseline_regime IN ('bullish', 'bearish', 'sideways')),
  shadow_score NUMERIC NOT NULL,
  shadow_regime TEXT NOT NULL CHECK (shadow_regime IN ('bullish', 'bearish', 'sideways')),
  is_divergent BOOLEAN NOT NULL DEFAULT false,
  divergence_type TEXT NOT NULL DEFAULT 'none'
    CHECK (divergence_type IN ('whale_absorption_in_btc_drop', 'none')),
  entry_blocked_by_rule BOOLEAN NOT NULL DEFAULT false,
  explanation TEXT
);

CREATE INDEX IF NOT EXISTS idx_market_regime_telemetry_created_at
  ON public.market_regime_telemetry (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_regime_telemetry_divergent
  ON public.market_regime_telemetry (created_at DESC)
  WHERE is_divergent = true;

ALTER TABLE public.market_regime_telemetry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_regime_telemetry FROM anon, authenticated;
GRANT SELECT, INSERT ON public.market_regime_telemetry TO service_role;

COMMENT ON TABLE public.market_regime_telemetry IS
  'Research-only forward telemetry comparing baseline and BTC/Whale divergence shadow scores. Does not drive trading decisions.';
COMMENT ON COLUMN public.market_regime_telemetry.entry_blocked_by_rule IS
  'Counterfactual flag: true only if the shadow regime becomes bearish while baseline was not bearish. It is not a live order block.';

NOTIFY pgrst, 'reload schema';
