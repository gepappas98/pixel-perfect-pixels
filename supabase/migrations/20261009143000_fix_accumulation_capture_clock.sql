-- Use capture time as the observation timestamp.
-- indicator_snapshots is a mutable current-state table; its created_at is not a reliable
-- clock for repeated research observations. This migration keeps the experiment shadow-only.

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

  -- Only attempt forward-return lookups once each horizon can have matured.
  UPDATE public.accumulation_shadow_observations o
  SET
    return_24h_pct = COALESCE(o.return_24h_pct, (
      SELECT (aps.price - o.price) / NULLIF(o.price, 0) * 100
      FROM public.asset_price_snapshots aps
      WHERE aps.asset = o.asset AND aps.source = 'binance-spot'
        AND aps.observed_at BETWEEN o.observed_at + interval '23 hours' AND o.observed_at + interval '25 hours'
      ORDER BY abs(extract(epoch FROM (aps.observed_at - (o.observed_at + interval '24 hours'))))
      LIMIT 1
    )),
    return_72h_pct = COALESCE(o.return_72h_pct, (
      SELECT (aps.price - o.price) / NULLIF(o.price, 0) * 100
      FROM public.asset_price_snapshots aps
      WHERE aps.asset = o.asset AND aps.source = 'binance-spot'
        AND aps.observed_at BETWEEN o.observed_at + interval '71 hours' AND o.observed_at + interval '73 hours'
      ORDER BY abs(extract(epoch FROM (aps.observed_at - (o.observed_at + interval '72 hours'))))
      LIMIT 1
    ))
  WHERE (o.return_24h_pct IS NULL AND o.observed_at <= statement_timestamp() - interval '23 hours')
     OR (o.return_72h_pct IS NULL AND o.observed_at <= statement_timestamp() - interval '71 hours');

  INSERT INTO public.accumulation_shadow_observations (
    source_indicator_id,asset,observed_at,timeframe,score,status,obv,obv_change_pct20,
    obv_slope_per_day,obv_price_divergence,cmf20,atr_pct,atr_compression_pct,volume,
    avg_volume20,volume_ratio,ma20,ma50,support20,resistance20,breakout_confirmed,price,
    return_24h_pct,return_72h_pct)
  SELECT i.id,
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
    i.price,
    CASE WHEN f24.price IS NOT NULL THEN (f24.price-i.price)/NULLIF(i.price,0)*100 END,
    CASE WHEN f72.price IS NOT NULL THEN (f72.price-i.price)/NULLIF(i.price,0)*100 END
  FROM public.indicator_snapshots i
  CROSS JOIN (SELECT statement_timestamp() AS observed_at) capture_clock
  LEFT JOIN LATERAL (
    SELECT o.observed_at,o.price,o.obv
    FROM public.accumulation_shadow_observations o
    WHERE o.asset=regexp_replace(i.symbol,'USDT$','')
      AND o.observed_at BETWEEN capture_clock.observed_at-interval '32 hours'
                            AND capture_clock.observed_at-interval '20 hours'
      AND o.obv IS NOT NULL
    ORDER BY abs(extract(epoch FROM (capture_clock.observed_at-o.observed_at))) LIMIT 1
  ) p24 ON true
  LEFT JOIN LATERAL (
    SELECT aps.price FROM public.asset_price_snapshots aps
    WHERE aps.asset=regexp_replace(i.symbol,'USDT$','') AND aps.source='binance-spot'
      AND aps.observed_at BETWEEN capture_clock.observed_at+interval '23 hours'
                              AND capture_clock.observed_at+interval '25 hours'
    ORDER BY abs(extract(epoch FROM (aps.observed_at-(capture_clock.observed_at+interval '24 hours')))) LIMIT 1
  ) f24 ON true
  LEFT JOIN LATERAL (
    SELECT aps.price FROM public.asset_price_snapshots aps
    WHERE aps.asset=regexp_replace(i.symbol,'USDT$','') AND aps.source='binance-spot'
      AND aps.observed_at BETWEEN capture_clock.observed_at+interval '71 hours'
                              AND capture_clock.observed_at+interval '73 hours'
    ORDER BY abs(extract(epoch FROM (aps.observed_at-(capture_clock.observed_at+interval '72 hours')))) LIMIT 1
  ) f72 ON true
  WHERE i.timeframe='1d'
    AND i.created_at >= statement_timestamp()-make_interval(hours=>greatest(p_lookback_hours,1))
    AND jsonb_typeof(i.raw->'accumulation')='object'
    AND i.price IS NOT NULL
    -- One observation per asset per 15 minutes, based on observation time, not source-row time.
    AND NOT EXISTS (
      SELECT 1 FROM public.accumulation_shadow_observations recent
      WHERE recent.asset=regexp_replace(i.symbol,'USDT$','')
        AND recent.observed_at >= capture_clock.observed_at-interval '15 minutes'
        AND recent.observed_at < capture_clock.observed_at
    )
  ON CONFLICT(source_indicator_id,observed_at) DO UPDATE SET
    return_24h_pct=COALESCE(public.accumulation_shadow_observations.return_24h_pct,EXCLUDED.return_24h_pct),
    return_72h_pct=COALESCE(public.accumulation_shadow_observations.return_72h_pct,EXCLUDED.return_72h_pct),
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
