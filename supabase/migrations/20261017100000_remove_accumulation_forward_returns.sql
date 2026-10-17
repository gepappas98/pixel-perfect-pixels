-- Accumulation is now an entry-time factor in signal-combiner.
-- Forward 24h/72h labels are not used for entries and are intentionally removed
-- to stop recurring price lookups and avoid retaining unnecessary research data.
-- Preserve all existing accumulation feature observations and all paper trades.

DROP INDEX IF EXISTS public.idx_accum_shadow_maturity;

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
    avg_volume20,volume_ratio,ma20,ma50,support20,resistance20,breakout_confirmed,price
  )
  SELECT
    i.id,
    regexp_replace(i.symbol,'USDT$',''),
    capture_clock.observed_at,
    i.timeframe,
    NULLIF(i.raw->'accumulation'->>'score','')::numeric,
    i.raw->'accumulation'->>'status',
    NULLIF(i.raw->'accumulation'->>'obv','')::numeric,
    NULLIF(i.raw->'accumulation'->>'obvChangePct20','')::numeric,
    CASE WHEN p24.obv IS NOT NULL AND capture_clock.observed_at > p24.observed_at
      THEN (NULLIF(i.raw->'accumulation'->>'obv','')::numeric-p24.obv) /
           GREATEST(EXTRACT(epoch FROM (capture_clock.observed_at-p24.observed_at))/86400.0,0.25)
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
    i.price
  FROM public.indicator_snapshots i
  CROSS JOIN (SELECT statement_timestamp() AS observed_at) capture_clock
  LEFT JOIN LATERAL (
    SELECT o.observed_at,o.price,o.obv
    FROM public.accumulation_shadow_observations o
    WHERE o.asset=regexp_replace(i.symbol,'USDT$','')
      AND o.observed_at BETWEEN capture_clock.observed_at-interval '32 hours'
                            AND capture_clock.observed_at-interval '20 hours'
      AND o.obv IS NOT NULL
    ORDER BY abs(extract(epoch FROM (capture_clock.observed_at-o.observed_at)))
    LIMIT 1
  ) p24 ON true
  WHERE i.timeframe='1d'
    AND i.created_at >= statement_timestamp()-make_interval(hours=>greatest(p_lookback_hours,1))
    AND jsonb_typeof(i.raw->'accumulation')='object'
    AND i.price IS NOT NULL
    -- One observation per asset per 15 minutes; keep only features used for live research.
    AND NOT EXISTS (
      SELECT 1 FROM public.accumulation_shadow_observations recent
      WHERE recent.asset=regexp_replace(i.symbol,'USDT$','')
        AND recent.observed_at >= capture_clock.observed_at-interval '15 minutes'
        AND recent.observed_at < capture_clock.observed_at
    )
  ON CONFLICT(source_indicator_id,observed_at) DO UPDATE SET
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

ALTER TABLE public.accumulation_shadow_observations
  DROP COLUMN IF EXISTS return_24h_pct,
  DROP COLUMN IF EXISTS return_72h_pct;
