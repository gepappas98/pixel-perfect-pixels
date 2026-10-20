-- Optimize archive readiness checks with a single required-source pass.
-- Preserve the production JSON contract, validation behavior, SECURITY DEFINER,
-- search_path, and the function's existing ACL (CREATE OR REPLACE keeps grants).
CREATE OR REPLACE FUNCTION public.get_research_archive_status(
  p_raw_hours integer DEFAULT 72,
  p_derived_hours integer DEFAULT 168
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  raw_cutoff timestamptz := now() - make_interval(hours => p_raw_hours);
  derived_cutoff timestamptz := now() - make_interval(hours => p_derived_hours);
  v_total bigint := 0;
  v_archived bigint := 0;
  v_missing bigint := 0;
  v_by_table jsonb := '{}'::jsonb;
BEGIN
  IF p_raw_hours < 24 OR p_derived_hours < p_raw_hours THEN
    RAISE EXCEPTION 'Invalid retention windows';
  END IF;

  WITH required AS MATERIALIZED (
    SELECT 'asset_price_snapshots'::text AS source_table, s.id::text AS source_id
      FROM public.asset_price_snapshots s WHERE s.observed_at < raw_cutoff
    UNION ALL SELECT 'asset_flow_snapshots', s.id::text
      FROM public.asset_flow_snapshots s WHERE s.bucket_at < raw_cutoff
    UNION ALL SELECT 'asset_sentiment_snapshots', s.id::text
      FROM public.asset_sentiment_snapshots s WHERE s.observed_at < raw_cutoff
    UNION ALL SELECT 'asset_news_events', s.id::text
      FROM public.asset_news_events s WHERE s.event_at < raw_cutoff
    UNION ALL SELECT 'event_flow_transmissions', s.id::text
      FROM public.event_flow_transmissions s WHERE s.event_at < derived_cutoff
    UNION ALL SELECT 'whale_flow_shock_followups', s.id::text
      FROM public.whale_flow_shock_followups s WHERE s.shock_at < derived_cutoff
    UNION ALL SELECT 'whale_flow_transition_context', s.id::text
      FROM public.whale_flow_transition_context s WHERE s.created_at < derived_cutoff
    UNION ALL SELECT 'whale_flow_transitions', s.id::text
      FROM public.whale_flow_transitions s WHERE s.created_at < derived_cutoff
    UNION ALL SELECT 'whale_flow_snapshots', s.id::text
      FROM public.whale_flow_snapshots s WHERE s.created_at < derived_cutoff
  ),
  evidence_keys AS MATERIALIZED (
    SELECT e.source_table, e.source_id
    FROM public.research_evidence e
    GROUP BY e.source_table, e.source_id
  ),
  checked AS MATERIALIZED (
    SELECT r.source_table, r.source_id, (e.source_id IS NOT NULL) AS archived
    FROM required r
    LEFT JOIN evidence_keys e
      ON e.source_table = r.source_table
     AND e.source_id = r.source_id
  ),
  totals AS (
    SELECT count(*)::bigint AS eligible,
           count(*) FILTER (WHERE archived)::bigint AS archived,
           count(*) FILTER (WHERE NOT archived)::bigint AS missing
    FROM checked
  ),
  per_table AS (
    SELECT source_table,
           count(*)::bigint AS eligible,
           count(*) FILTER (WHERE archived)::bigint AS archived,
           count(*) FILTER (WHERE NOT archived)::bigint AS missing
    FROM checked GROUP BY source_table
  )
  SELECT totals.eligible, totals.archived, totals.missing,
         coalesce((SELECT jsonb_object_agg(
           p.source_table,
           jsonb_build_object('eligible',p.eligible,'archived',p.archived,'missing',p.missing)
         ) FROM per_table p), '{}'::jsonb)
    INTO v_total, v_archived, v_missing, v_by_table
  FROM totals;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_missing = 0 THEN 'ready' ELSE 'incomplete' END,
    'eligible_sources', v_total,
    'archived_sources', v_archived,
    'missing_sources', v_missing,
    'last_archive_at', (SELECT max(captured_at) FROM public.research_evidence),
    'raw_cutoff', raw_cutoff,
    'derived_cutoff', derived_cutoff,
    'by_table', v_by_table,
    'delete_enabled', coalesce(
      (SELECT allow_source_delete FROM public.research_archive_control WHERE id = 1), false
    ),
    'archive_enabled', coalesce(
      (SELECT allow_archive FROM public.research_archive_control WHERE id = 1), false
    )
  );
END;
$function$;
