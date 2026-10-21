-- Avoid rewriting every recent transition on each 5-minute Event Flow collection.
-- Recompute the same classification fields, but issue UPDATE only when a field changes.
-- This preserves the existing classification rules and return value (rows actually updated).
CREATE OR REPLACE FUNCTION public.refresh_whale_flow_transition_classification(
  p_lookback_hours integer DEFAULT 168
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  WITH base AS (
    SELECT t.id,t.detected_at,t.delta_pp,t.new_state,s0.flow_score AS flow0
    FROM public.whale_flow_transitions t
    LEFT JOIN LATERAL (
      SELECT flow_score
      FROM public.whale_flow_snapshots
      WHERE id=t.to_snapshot_id
    ) s0 ON true
    WHERE t.detected_at >= now()-make_interval(hours=>greatest(p_lookback_hours,1))
  ),
  evidence AS (
    SELECT b.*,stats.same_state_count,stats.directional_count,stats.available_count,conf.confirm_at
    FROM base b
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE ws.dominant_state=b.new_state)::integer same_state_count,
        count(*) FILTER (
          WHERE sign((ws.flow_score-b.flow0))=sign(b.delta_pp)
            AND abs((ws.flow_score-b.flow0)*100)>=5
        )::integer directional_count,
        count(*)::integer available_count
      FROM public.whale_flow_snapshots ws
      WHERE ws.bucket_at>b.detected_at
        AND ws.bucket_at<=b.detected_at+interval '15 minutes'
    ) stats ON true
    LEFT JOIN LATERAL (
      SELECT max(ws.bucket_at) AS confirm_at
      FROM (
        SELECT ws.*
        FROM public.whale_flow_snapshots ws
        WHERE ws.bucket_at>b.detected_at
          AND ws.bucket_at<=b.detected_at+interval '15 minutes'
        ORDER BY ws.bucket_at
        LIMIT 3
      ) ws
      WHERE (
        SELECT count(*)
        FROM (
          SELECT ws2.*
          FROM public.whale_flow_snapshots ws2
          WHERE ws2.bucket_at>b.detected_at
            AND ws2.bucket_at<=b.detected_at+interval '15 minutes'
          ORDER BY ws2.bucket_at
          LIMIT 3
        ) first3
        WHERE first3.dominant_state=b.new_state
          AND sign((first3.flow_score-b.flow0))=sign(b.delta_pp)
          AND abs((first3.flow_score-b.flow0)*100)>=5
      )=3
    ) conf ON true
  ),
  calculated AS (
    SELECT e.*,
      CASE WHEN abs(e.delta_pp)<5 THEN 'raw'
           WHEN e.confirm_at IS NOT NULL THEN 'confirmed'
           ELSE 'candidate' END AS next_classification,
      e.confirm_at AS next_confirmation_at,
      coalesce(e.same_state_count,0) AS next_persistence_snapshots,
      CASE WHEN e.confirm_at IS NOT NULL
        THEN greatest(0,round(extract(epoch FROM(e.confirm_at-e.detected_at))/60.0))::integer
        ELSE NULL END AS next_persistence_minutes,
      jsonb_build_object(
        'threshold_pp',5,
        'confirmation_required_consecutive_snapshots',3,
        'evaluation_window_minutes',15,
        'same_state_snapshots_15m',coalesce(e.same_state_count,0),
        'directional_snapshots_15m',coalesce(e.directional_count,0),
        'available_snapshots_15m',coalesce(e.available_count,0),
        'rule','candidate at >=5pp; confirmed only when the first 3 subsequent snapshots all retain the new state and directional flow >=5pp from T0'
      ) AS next_classification_reason
    FROM evidence e
  )
  UPDATE public.whale_flow_transitions t
  SET classification=c.next_classification,
      confirmation_at=c.next_confirmation_at,
      persistence_snapshots=c.next_persistence_snapshots,
      persistence_minutes=c.next_persistence_minutes,
      classification_reason=c.next_classification_reason
  FROM calculated c
  WHERE t.id=c.id
    AND ROW(t.classification,t.confirmation_at,t.persistence_snapshots,t.persistence_minutes,t.classification_reason)
        IS DISTINCT FROM
        ROW(c.next_classification,c.next_confirmation_at,c.next_persistence_snapshots,c.next_persistence_minutes,c.next_classification_reason);

  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_whale_flow_transition_classification(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_whale_flow_transition_classification(integer)
  TO service_role;

-- The transition-context trigger filters by observed_at without constraining asset.
-- The existing (asset, observed_at) index cannot efficiently serve that global time-window predicate.
CREATE INDEX IF NOT EXISTS idx_asset_sentiment_observed_at
  ON public.asset_sentiment_snapshots (observed_at DESC);
