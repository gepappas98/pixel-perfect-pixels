-- Research-only maturation pass for the Social -> Sentiment -> Whale -> Price chain.
-- Re-evaluates existing influential social events at the 4h and 24h evidence windows.
-- Does not modify trading signals, strategy selection, risk, execution, or trades.

CREATE OR REPLACE FUNCTION public.refresh_mature_influential_social_transmissions(
  p_lookback_hours integer DEFAULT 168
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event record;
  v_processed integer := 0;
  v_failed integer := 0;
  v_examined integer := 0;
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  FOR v_event IN
    SELECT e.id
    FROM public.influential_social_events e
    WHERE e.published_at <= now() - interval '3 hours'
      AND e.published_at >= now() - make_interval(hours => greatest(1,p_lookback_hours))
      AND e.classification_status = 'classified'
      AND e.crypto_relevance IN ('high','medium')
      AND coalesce(cardinality(e.affected_assets),0) > 0
      AND (
        e.published_at > now() - interval '5 hours'
        OR e.published_at BETWEEN now() - interval '25 hours'
                                   AND now() - interval '23 hours'
      )
    ORDER BY e.published_at
    LIMIT 100
  LOOP
    v_examined := v_examined + 1;
    BEGIN
      PERFORM public.process_influential_social_event(v_event.id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING '[SOCIAL_CHAIN_REFRESH] event % failed: %', v_event.id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'examined', v_examined,
    'processed', v_processed,
    'failed', v_failed,
    'research_only', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_mature_influential_social_transmissions(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_mature_influential_social_transmissions(integer)
  TO service_role;