-- DRAFT ONLY: non-destructive database routine retirement; promote to supabase/migrations only after the prep migration is applied and new frontend/Edge code is deployed.
-- Do not execute directly from docs.
-- Non-destructive retirement of prediction-market database dependencies; historical data is retained.

-- Final database routine retirement migration starts below.
CREATE OR REPLACE FUNCTION public.analyze_whale_waves_by_market_regime(p_hours integer DEFAULT 168)
RETURNS TABLE(
  regime text,
  wave text,
  n bigint,
  avg_delta_pp numeric,
  avg_return_15m_pct numeric,
  avg_return_30m_pct numeric,
  avg_return_1h_pct numeric,
  avg_return_4h_pct numeric,
  positive_1h_pct numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
WITH turns AS (
  SELECT id, detected_at, delta_pp
  FROM public.whale_flow_turns
  WHERE detected_at >= now() - make_interval(hours => greatest(p_hours, 1))
), scored AS (
  SELECT t.*,
    coalesce((
      SELECT CASE
        WHEN sum(CASE WHEN direction IN ('accumulation','distribution') THEN usd_value ELSE 0 END) > 0
        THEN (
          sum(CASE WHEN direction='accumulation' THEN usd_value ELSE 0 END)
          - sum(CASE WHEN direction='distribution' THEN usd_value ELSE 0 END)
        ) / sum(CASE WHEN direction IN ('accumulation','distribution') THEN usd_value ELSE 0 END)
        ELSE 0 END
      FROM public.whale_alerts w
      WHERE w.created_at BETWEEN t.detected_at - interval '6 hours' AND t.detected_at
    ), 0) AS whale_net,
    coalesce((
      SELECT (
        sum(CASE WHEN signal='bullish' THEN 1 ELSE 0 END)
        - sum(CASE WHEN signal='bearish' THEN 1 ELSE 0 END)
      )::numeric / nullif(count(*),0)
      FROM (
        SELECT DISTINCT ON (symbol) symbol, signal
        FROM public.indicator_snapshots
        WHERE timeframe='4h'
          AND created_at BETWEEN t.detected_at - interval '6 hours' AND t.detected_at
        ORDER BY symbol, created_at DESC
      ) x
    ), 0) AS tech_breadth,
    coalesce((
      SELECT (
        sum(CASE WHEN final_verdict='BUY' THEN 1 ELSE 0 END)
        - sum(CASE WHEN final_verdict='SELL' THEN 1 ELSE 0 END)
      )::numeric / nullif(sum(CASE WHEN final_verdict IN ('BUY','SELL') THEN 1 ELSE 0 END),0)
      FROM (
        SELECT DISTINCT ON (symbol) symbol, final_verdict
        FROM public.council_signals
        WHERE source_created_at BETWEEN t.detected_at - interval '30 minutes' AND t.detected_at
        ORDER BY symbol, source_created_at DESC
      ) c
    ), 0) AS council_consensus
  FROM turns t
), labeled AS (
  SELECT *,
    whale_net * .375 + tech_breadth * .5 + council_consensus * .125 AS score
  FROM scored
), regimes AS (
  SELECT *,
    CASE WHEN score >= .5 THEN 'strong_bull'
         WHEN score >= .15 THEN 'bull'
         WHEN score <= -.5 THEN 'strong_bear'
         WHEN score <= -.15 THEN 'bear'
         ELSE 'sideways' END AS regime
  FROM labeled
), priced AS (
  SELECT r.*, p0.price AS p0, p15.price AS p15, p30.price AS p30, p60.price AS p60, p240.price AS p240
  FROM regimes r
  LEFT JOIN LATERAL (
    SELECT price FROM public.asset_price_snapshots
    WHERE asset='BTC' AND observed_at<=r.detected_at
    ORDER BY observed_at DESC LIMIT 1
  ) p0 ON true
  LEFT JOIN LATERAL (
    SELECT price FROM public.asset_price_snapshots
    WHERE asset='BTC' AND observed_at>=r.detected_at+interval '15 minutes'
    ORDER BY observed_at LIMIT 1
  ) p15 ON true
  LEFT JOIN LATERAL (
    SELECT price FROM public.asset_price_snapshots
    WHERE asset='BTC' AND observed_at>=r.detected_at+interval '30 minutes'
    ORDER BY observed_at LIMIT 1
  ) p30 ON true
  LEFT JOIN LATERAL (
    SELECT price FROM public.asset_price_snapshots
    WHERE asset='BTC' AND observed_at>=r.detected_at+interval '1 hour'
    ORDER BY observed_at LIMIT 1
  ) p60 ON true
  LEFT JOIN LATERAL (
    SELECT price FROM public.asset_price_snapshots
    WHERE asset='BTC' AND observed_at>=r.detected_at+interval '4 hours'
    ORDER BY observed_at LIMIT 1
  ) p240 ON true
)
SELECT regime,
  CASE WHEN delta_pp>0 THEN 'bullish_wave' ELSE 'bearish_wave' END AS wave,
  count(*)::bigint AS n,
  round(avg(delta_pp)::numeric,1) AS avg_delta_pp,
  round(avg(CASE WHEN p15 IS NOT NULL THEN (p15/p0-1)*100 END)::numeric,3) AS avg_return_15m_pct,
  round(avg(CASE WHEN p30 IS NOT NULL THEN (p30/p0-1)*100 END)::numeric,3) AS avg_return_30m_pct,
  round(avg(CASE WHEN p60 IS NOT NULL THEN (p60/p0-1)*100 END)::numeric,3) AS avg_return_1h_pct,
  round(avg(CASE WHEN p240 IS NOT NULL THEN (p240/p0-1)*100 END)::numeric,3) AS avg_return_4h_pct,
  round(100*avg(CASE WHEN p60 IS NOT NULL THEN CASE WHEN p60>p0 THEN 1.0 ELSE 0.0 END END)::numeric,1) AS positive_1h_pct
FROM priced
WHERE p0 IS NOT NULL
GROUP BY regime, wave
ORDER BY CASE regime WHEN 'strong_bear' THEN 1 WHEN 'bear' THEN 2 WHEN 'sideways' THEN 3 WHEN 'bull' THEN 4 WHEN 'strong_bull' THEN 5 ELSE 6 END, wave;
$function$;

CREATE OR REPLACE FUNCTION public.capture_whale_flow_transition_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_at timestamptz := NEW.detected_at;
  v_window interval := make_interval(mins => 15);
BEGIN
  INSERT INTO public.whale_flow_transition_context (
    transition_id, captured_at, lookback_minutes,
    indicator_context, signal_context, sentiment_context, news_context, data_quality
  )
  VALUES (
    NEW.id,
    v_at,
    15,
    jsonb_build_object(
      'available', true,
      'window_start', v_at - v_window,
      'window_end', v_at,
      'samples', (SELECT count(*) FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at),
      'bullish', (SELECT count(*) FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(i.signal,''))='bullish'),
      'bearish', (SELECT count(*) FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(i.signal,''))='bearish'),
      'neutral', (SELECT count(*) FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(i.signal,''))='neutral'),
      'timeframes', (SELECT coalesce(jsonb_object_agg(x.timeframe,x.n),'{}'::jsonb) FROM (SELECT i.timeframe,count(*) n FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at GROUP BY i.timeframe) x)
    ),
    jsonb_build_object(
      'available', true,
      'samples', (SELECT count(*) FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at),
      'buy', (SELECT count(*) FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(s.recommendation,''))='buy'),
      'sell', (SELECT count(*) FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(s.recommendation,''))='sell'),
      'hold', (SELECT count(*) FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at AND lower(coalesce(s.recommendation,''))='hold'),
      'avg_confidence', (SELECT round(avg(s.confidence)::numeric,4) FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at),
      'regimes', (SELECT coalesce(jsonb_object_agg(x.regime_label,x.n),'{}'::jsonb) FROM (SELECT coalesce(nullif(s.regime_label,''),'unknown') regime_label,count(*) n FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at GROUP BY coalesce(nullif(s.regime_label,''),'unknown')) x)
    ),
    jsonb_build_object(
      'available', exists(SELECT 1 FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at),
      'window_start', v_at-v_window,
      'window_end', v_at,
      'samples', (SELECT count(*) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at),
      'assets', (SELECT count(DISTINCT s.asset) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at),
      'avg_score', (SELECT round(avg(s.sentiment_score)::numeric,4) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at),
      'bullish', (SELECT count(*) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at AND coalesce(s.sentiment_score,0)>0.15),
      'bearish', (SELECT count(*) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at AND coalesce(s.sentiment_score,0)<-0.15),
      'neutral', (SELECT count(*) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at AND coalesce(s.sentiment_score,0) BETWEEN -0.15 AND 0.15),
      'latest_at', (SELECT max(s.observed_at) FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at)
    ) || CASE WHEN exists(SELECT 1 FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at) THEN '{}'::jsonb ELSE jsonb_build_object('reason','No sentiment snapshots in the transition lookback window') END,
    jsonb_build_object(
      'available', exists(SELECT 1 FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at),
      'window_start', v_at-v_window,
      'window_end', v_at,
      'samples', (SELECT count(*) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at),
      'assets', (SELECT count(DISTINCT n.asset) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at),
      'avg_score', (SELECT round(avg(n.sentiment_score)::numeric,4) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at),
      'bullish', (SELECT count(*) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at AND coalesce(n.sentiment_score,0)>0.15),
      'bearish', (SELECT count(*) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at AND coalesce(n.sentiment_score,0)<-0.15),
      'neutral', (SELECT count(*) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at AND coalesce(n.sentiment_score,0) BETWEEN -0.15 AND 0.15),
      'latest_at', (SELECT max(n.event_at) FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at),
      'sources', (SELECT coalesce(jsonb_agg(x.source),'[]'::jsonb) FROM (SELECT DISTINCT n.source FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at) x)
    ) || CASE WHEN exists(SELECT 1 FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at) THEN '{}'::jsonb ELSE jsonb_build_object('reason','No news events in the transition lookback window') END,
    CASE
      WHEN exists(SELECT 1 FROM public.indicator_snapshots i WHERE i.created_at BETWEEN v_at-v_window AND v_at)
        OR exists(SELECT 1 FROM public.composite_signals s WHERE s.created_at BETWEEN v_at-v_window AND v_at)
        OR exists(SELECT 1 FROM public.asset_sentiment_snapshots s WHERE s.observed_at BETWEEN v_at-v_window AND v_at)
        OR exists(SELECT 1 FROM public.asset_news_events n WHERE n.event_at BETWEEN v_at-v_window AND v_at)
      THEN 'partial'
      ELSE 'whale_only'
    END
  )
  ON CONFLICT (transition_id) DO UPDATE SET
    indicator_context = excluded.indicator_context,
    signal_context = excluded.signal_context,
    sentiment_context = excluded.sentiment_context,
    news_context = excluded.news_context,
    data_quality = excluded.data_quality;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[WHALE_FLOW_CONTEXT] capture failed for transition %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_whale_wave_research_readiness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total integer := 0;
  v_bear integer := 0;
  v_sideways integer := 0;
  v_bull integer := 0;
  v_1h integer := 0;
  v_ready boolean := false;
  v_alert_id uuid;
BEGIN
  WITH turns AS (
    SELECT id, detected_at, delta_pp
    FROM public.whale_flow_turns
    WHERE detected_at >= now() - interval '30 days'
  ), scored AS (
    SELECT t.*,
      coalesce((
        SELECT CASE WHEN sum(CASE WHEN direction IN ('accumulation','distribution') THEN usd_value ELSE 0 END)>0
          THEN (sum(CASE WHEN direction='accumulation' THEN usd_value ELSE 0 END)-sum(CASE WHEN direction='distribution' THEN usd_value ELSE 0 END))
             / sum(CASE WHEN direction IN ('accumulation','distribution') THEN usd_value ELSE 0 END)
          ELSE 0 END
        FROM public.whale_alerts w
        WHERE w.created_at BETWEEN t.detected_at-interval '6 hours' AND t.detected_at
      ),0) AS whale_net,
      coalesce((
        SELECT (sum(CASE WHEN signal='bullish' THEN 1 ELSE 0 END)-sum(CASE WHEN signal='bearish' THEN 1 ELSE 0 END))::numeric/nullif(count(*),0)
        FROM (
          SELECT DISTINCT ON (symbol) symbol, signal
          FROM public.indicator_snapshots
          WHERE timeframe='4h' AND created_at BETWEEN t.detected_at-interval '6 hours' AND t.detected_at
          ORDER BY symbol, created_at DESC
        ) x
      ),0) AS tech_breadth,
      coalesce((
        SELECT (sum(CASE WHEN final_verdict='BUY' THEN 1 ELSE 0 END)-sum(CASE WHEN final_verdict='SELL' THEN 1 ELSE 0 END))::numeric
               / nullif(sum(CASE WHEN final_verdict IN ('BUY','SELL') THEN 1 ELSE 0 END),0)
        FROM (
          SELECT DISTINCT ON (symbol) symbol, final_verdict
          FROM public.council_signals
          WHERE source_created_at BETWEEN t.detected_at-interval '30 minutes' AND t.detected_at
          ORDER BY symbol, source_created_at DESC
        ) c
      ),0) AS council_consensus
    FROM turns t
  ), labeled AS (
    SELECT *,
      whale_net*.375 + tech_breadth*.5 + council_consensus*.125 AS score
    FROM scored
  ), regimes AS (
    SELECT *,
      CASE WHEN score>=.5 THEN 'strong_bull'
           WHEN score>=.15 THEN 'bull'
           WHEN score<=-.5 THEN 'strong_bear'
           WHEN score<=-.15 THEN 'bear'
           ELSE 'sideways' END AS regime
    FROM labeled
  ), usable AS (
    SELECT r.*, p0.price AS p0, p60.price AS p60
    FROM regimes r
    JOIN LATERAL (
      SELECT price FROM public.asset_price_snapshots
      WHERE asset='BTC' AND observed_at<=r.detected_at
      ORDER BY observed_at DESC LIMIT 1
    ) p0 ON true
    LEFT JOIN LATERAL (
      SELECT price FROM public.asset_price_snapshots
      WHERE asset='BTC' AND observed_at>=r.detected_at+interval '1 hour'
      ORDER BY observed_at LIMIT 1
    ) p60 ON true
  )
  SELECT count(*)::integer,
    count(*) FILTER (WHERE regime='bear')::integer,
    count(*) FILTER (WHERE regime='sideways')::integer,
    count(*) FILTER (WHERE regime='bull')::integer,
    count(*) FILTER (WHERE p60 IS NOT NULL)::integer
  INTO v_total, v_bear, v_sideways, v_bull, v_1h
  FROM usable;

  v_ready := v_total>=30 AND v_bear>=10 AND v_sideways>=5 AND v_1h>=ceil(v_total*.80);

  IF v_ready AND NOT EXISTS (
    SELECT 1 FROM public.research_alerts
    WHERE alert_type='WHALE_WAVE_REGIME_DATA_READY'
      AND created_at>=now()-interval '30 days'
  ) THEN
    INSERT INTO public.research_alerts (
      alert_type,severity,asset,source,event_id,event_at,detected_at,message,evidence,acknowledged
    ) VALUES (
      'WHALE_WAVE_REGIME_DATA_READY','info',null,'research-readiness',null,now(),now(),
      'Enough regime-aware whale-wave data has accumulated. Resume the regime/wave study now.',
      jsonb_build_object(
        'research_only',true,
        'total_usable_waves',v_total,
        'bear_waves',v_bear,
        'sideways_waves',v_sideways,
        'bull_waves',v_bull,
        'one_hour_price_coverage',v_1h,
        'one_hour_price_coverage_pct',round(100.0*v_1h/nullif(v_total,0),1),
        'minimum_total',30,'minimum_bear',10,'minimum_sideways',5,
        'minimum_1h_coverage_pct',80,
        'next_step','analyze_whale_waves_by_market_regime'
      ),false
    ) RETURNING id INTO v_alert_id;
  END IF;

  RETURN jsonb_build_object(
    'ready',v_ready,
    'alert_created',v_alert_id IS NOT NULL,
    'alert_id',v_alert_id,
    'total_usable_waves',v_total,
    'bear_waves',v_bear,
    'sideways_waves',v_sideways,
    'bull_waves',v_bull,
    'one_hour_price_coverage',v_1h,
    'one_hour_price_coverage_pct',round(100.0*v_1h/nullif(v_total,0),1),
    'thresholds',jsonb_build_object('total',30,'bear',10,'sideways',5,'one_hour_coverage_pct',80)
  );
END;
$function$;

-- Remove the now-unused conflict feature flag from persisted JSON configuration.
UPDATE public.pipeline_settings
SET cleanup_config = cleanup_config - 'watch_conflict_fix'
WHERE cleanup_config ? 'watch_conflict_fix';

-- Historical-retention rule:
-- Do NOT delete or rewrite prediction-era research records during this rollout.
-- Keep composite_signals.entry_context_snapshot, prediction_snapshot_id,
-- strategy_config.prediction_weight, pipeline_runs.predictions,
-- whale_flow_transition_context.prediction_context, and prediction_snapshots intact.
-- Active application code no longer reads these fields or collects new Polymarket data.
-- This preserves audit/replay history and foreign-key traceability.
-- The prediction_snapshots table and its old relationships can be archived or removed
-- only in a separate, explicitly approved future task after an export/recovery plan.
