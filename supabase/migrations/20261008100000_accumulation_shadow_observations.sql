-- Research-only accumulation / CREDIA observation layer.
-- Does not write to trades, composite_signals, strategy selection, risk, or execution.

CREATE TABLE IF NOT EXISTS public.accumulation_shadow_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_indicator_id uuid NOT NULL UNIQUE REFERENCES public.indicator_snapshots(id) ON DELETE CASCADE,
  asset text NOT NULL,
  observed_at timestamptz NOT NULL,
  timeframe text NOT NULL CHECK (timeframe = '1d'),
  score numeric,
  status text,
  obv numeric,
  obv_change_pct20 numeric,
  obv_slope_per_day numeric,
  obv_price_divergence text,
  cmf20 numeric,
  atr_pct numeric,
  atr_compression_pct numeric,
  volume numeric,
  avg_volume20 numeric,
  volume_ratio numeric,
  ma20 numeric,
  ma50 numeric,
  support20 numeric,
  resistance20 numeric,
  breakout_confirmed boolean,
  price numeric NOT NULL,
  return_24h_pct numeric,
  return_72h_pct numeric,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accum_shadow_asset_time
  ON public.accumulation_shadow_observations(asset, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_accum_shadow_score
  ON public.accumulation_shadow_observations(score DESC);
CREATE INDEX IF NOT EXISTS idx_accum_shadow_status
  ON public.accumulation_shadow_observations(status);

ALTER TABLE public.accumulation_shadow_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accumulation_shadow_service_role
  ON public.accumulation_shadow_observations;

CREATE POLICY accumulation_shadow_service_role
  ON public.accumulation_shadow_observations
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.capture_accumulation_shadow_observations(
  p_lookback_hours integer DEFAULT 168
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  INSERT INTO public.accumulation_shadow_observations (
    source_indicator_id,asset,observed_at,timeframe,score,status,obv,obv_change_pct20,
    obv_slope_per_day,obv_price_divergence,cmf20,atr_pct,atr_compression_pct,volume,
    avg_volume20,volume_ratio,ma20,ma50,support20,resistance20,breakout_confirmed,price,
    return_24h_pct,return_72h_pct)
  SELECT i.id,regexp_replace(i.symbol,'USDT$',''),i.created_at,i.timeframe,
    NULLIF(i.raw->'accumulation'->>'score','')::numeric,
    i.raw->'accumulation'->>'status',
    NULLIF(i.raw->'accumulation'->>'obv','')::numeric,
    NULLIF(i.raw->'accumulation'->>'obvChangePct20','')::numeric,
    CASE WHEN p24.obv IS NOT NULL AND i.created_at>p24.created_at
      THEN (NULLIF(i.raw->'accumulation'->>'obv','')::numeric-p24.obv)/
           GREATEST(EXTRACT(epoch FROM(i.created_at-p24.created_at))/86400.0,0.25)
      ELSE NULL END,
    CASE
      WHEN p24.obv IS NULL OR p24.price IS NULL OR i.price IS NULL THEN 'insufficient'
      WHEN (i.price-p24.price)/NULLIF(p24.price,0)>0.01
       AND (NULLIF(i.raw->'accumulation'->>'obv','')::numeric-p24.obv)<0 THEN 'bearish_divergence'
      WHEN (i.price-p24.price)/NULLIF(p24.price,0)<-0.01
       AND (NULLIF(i.raw->'accumulation'->>'obv','')::numeric-p24.obv)>0 THEN 'bullish_divergence'
      ELSE 'none' END,
    NULLIF(i.raw->'accumulation'->>'cmf20','')::numeric,
    NULLIF(i.raw->'accumulation'->>'atrPct','')::numeric,
    NULLIF(i.raw->'accumulation'->>'atrCompressionPct','')::numeric,
    NULLIF(i.raw->'accumulation'->>'volume','')::numeric,
    NULLIF(i.raw->'accumulation'->>'avgVolume20','')::numeric,
    NULLIF(i.raw->'accumulation'->>'volumeRatio','')::numeric,
    NULLIF(i.raw->'accumulation'->>'ma20','')::numeric,
    NULLIF(i.raw->'accumulation'->>'ma50','')::numeric,
    NULLIF(i.raw->'accumulation'->>'support20','')::numeric,
    NULLIF(i.raw->'accumulation'->>'resistance20','')::numeric,
    COALESCE((i.raw->'accumulation'->>'breakoutConfirmed')::boolean,false),
    i.price,
    CASE WHEN f24.price IS NOT NULL THEN (f24.price-i.price)/NULLIF(i.price,0)*100 END,
    CASE WHEN f72.price IS NOT NULL THEN (f72.price-i.price)/NULLIF(i.price,0)*100 END
  FROM public.indicator_snapshots i
  LEFT JOIN LATERAL (
    SELECT s.created_at,s.price,NULLIF(s.raw->'accumulation'->>'obv','')::numeric AS obv
    FROM public.indicator_snapshots s
    WHERE s.symbol=i.symbol AND s.timeframe='1d'
      AND s.created_at BETWEEN i.created_at-interval '32 hours' AND i.created_at-interval '20 hours'
      AND jsonb_typeof(s.raw->'accumulation')='object'
    ORDER BY abs(extract(epoch FROM(i.created_at-s.created_at))) LIMIT 1
  ) p24 ON true
  LEFT JOIN LATERAL (
    SELECT aps.price FROM public.asset_price_snapshots aps
    WHERE aps.asset=regexp_replace(i.symbol,'USDT$','') AND aps.source='binance-spot'
      AND aps.observed_at BETWEEN i.created_at+interval '23 hours' AND i.created_at+interval '25 hours'
    ORDER BY abs(extract(epoch FROM(aps.observed_at-(i.created_at+interval '24 hours')))) LIMIT 1
  ) f24 ON true
  LEFT JOIN LATERAL (
    SELECT aps.price FROM public.asset_price_snapshots aps
    WHERE aps.asset=regexp_replace(i.symbol,'USDT$','') AND aps.source='binance-spot'
      AND aps.observed_at BETWEEN i.created_at+interval '71 hours' AND i.created_at+interval '73 hours'
    ORDER BY abs(extract(epoch FROM(aps.observed_at-(i.created_at+interval '72 hours')))) LIMIT 1
  ) f72 ON true
  WHERE i.timeframe='1d'
    AND i.created_at>=now()-make_interval(hours=>greatest(p_lookback_hours,1))
    AND jsonb_typeof(i.raw->'accumulation')='object' AND i.price IS NOT NULL
  ON CONFLICT(source_indicator_id) DO UPDATE SET
    return_24h_pct=EXCLUDED.return_24h_pct,
    return_72h_pct=EXCLUDED.return_72h_pct,
    obv_slope_per_day=EXCLUDED.obv_slope_per_day,
    obv_price_divergence=EXCLUDED.obv_price_divergence,
    captured_at=now();

  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_accumulation_shadow_observations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_accumulation_shadow_observations(integer)
  TO service_role;
