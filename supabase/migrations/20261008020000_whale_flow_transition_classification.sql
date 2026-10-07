-- P1: classify raw Whale Flow state transitions as raw/candidate/confirmed.
-- Shadow-only. Does not affect signals, strategy selection, risk, or execution.

ALTER TABLE public.whale_flow_transitions
  ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'raw',
  ADD COLUMN IF NOT EXISTS confirmation_at timestamptz,
  ADD COLUMN IF NOT EXISTS persistence_snapshots integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS persistence_minutes integer,
  ADD COLUMN IF NOT EXISTS classification_reason jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.whale_flow_transitions
  DROP CONSTRAINT IF EXISTS whale_flow_transitions_classification_check;

ALTER TABLE public.whale_flow_transitions
  ADD CONSTRAINT whale_flow_transitions_classification_check
  CHECK (classification IN ('raw','candidate','confirmed'));

CREATE INDEX IF NOT EXISTS idx_whale_flow_transitions_classification
  ON public.whale_flow_transitions(classification, detected_at);

CREATE OR REPLACE FUNCTION public.refresh_whale_flow_transition_classification(p_lookback_hours integer DEFAULT 168)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE v_count integer := 0;
BEGIN
  WITH base AS (
    SELECT t.id,t.detected_at,t.delta_pp,t.new_state,s0.flow_score AS flow0
    FROM public.whale_flow_transitions t
    LEFT JOIN LATERAL (
      SELECT flow_score FROM public.whale_flow_snapshots WHERE id=t.to_snapshot_id
    ) s0 ON true
    WHERE t.detected_at >= now()-make_interval(hours=>greatest(p_lookback_hours,1))
  ),
  evidence AS (
    SELECT b.*,stats.same_state_count,stats.directional_count,stats.available_count,conf.confirm_at
    FROM base b
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE ws.dominant_state=b.new_state)::integer same_state_count,
        count(*) FILTER (WHERE sign((ws.flow_score-b.flow0))=sign(b.delta_pp) AND abs((ws.flow_score-b.flow0)*100)>=5)::integer directional_count,
        count(*)::integer available_count
      FROM public.whale_flow_snapshots ws
      WHERE ws.bucket_at>b.detected_at AND ws.bucket_at<=b.detected_at+interval '15 minutes'
    ) stats ON true
    LEFT JOIN LATERAL (
      SELECT max(ws.bucket_at) AS confirm_at
      FROM (
        SELECT ws.* FROM public.whale_flow_snapshots ws
        WHERE ws.bucket_at>b.detected_at AND ws.bucket_at<=b.detected_at+interval '15 minutes'
        ORDER BY ws.bucket_at LIMIT 3
      ) ws
      WHERE (
        SELECT count(*) FROM (
          SELECT ws2.* FROM public.whale_flow_snapshots ws2
          WHERE ws2.bucket_at>b.detected_at AND ws2.bucket_at<=b.detected_at+interval '15 minutes'
          ORDER BY ws2.bucket_at LIMIT 3
        ) first3
        WHERE first3.dominant_state=b.new_state
          AND sign((first3.flow_score-b.flow0))=sign(b.delta_pp)
          AND abs((first3.flow_score-b.flow0)*100)>=5
      )=3
    ) conf ON true
  )
  UPDATE public.whale_flow_transitions t
  SET classification=CASE WHEN abs(t.delta_pp)<5 THEN 'raw' WHEN e.confirm_at IS NOT NULL THEN 'confirmed' ELSE 'candidate' END,
    confirmation_at=e.confirm_at,
    persistence_snapshots=coalesce(e.same_state_count,0),
    persistence_minutes=CASE WHEN e.confirm_at IS NOT NULL THEN greatest(0,round(extract(epoch FROM(e.confirm_at-t.detected_at))/60.0))::integer ELSE NULL END,
    classification_reason=jsonb_build_object(
      'threshold_pp',5,
      'confirmation_required_consecutive_snapshots',3,
      'evaluation_window_minutes',15,
      'same_state_snapshots_15m',coalesce(e.same_state_count,0),
      'directional_snapshots_15m',coalesce(e.directional_count,0),
      'available_snapshots_15m',coalesce(e.available_count,0),
      'rule','candidate at >=5pp; confirmed only when the first 3 subsequent snapshots all retain the new state and directional flow >=5pp from T0'
    )
  FROM evidence e WHERE t.id=e.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_whale_flow_transition_classification(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_whale_flow_transition_classification(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.classify_whale_flow_transition_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF abs(COALESCE(NEW.delta_pp,0)) >= 5 THEN
    NEW.classification := 'candidate';
    NEW.classification_reason := jsonb_build_object('threshold_pp',5,'stage','candidate','rule','raw transition meets material shock threshold');
  ELSE
    NEW.classification := 'raw';
    NEW.classification_reason := jsonb_build_object('threshold_pp',5,'stage','raw','rule','transition below material shock threshold');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_classify_whale_flow_transition_on_insert ON public.whale_flow_transitions;
CREATE TRIGGER trg_classify_whale_flow_transition_on_insert
BEFORE INSERT ON public.whale_flow_transitions
FOR EACH ROW EXECUTE FUNCTION public.classify_whale_flow_transition_on_insert();