-- Whale Flow History / Transition layer
-- Observational only. Does not alter signal scoring or execution.

CREATE TABLE IF NOT EXISTS public.whale_flow_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_at timestamptz NOT NULL,
  sample_size integer NOT NULL,
  accumulation_usd numeric NOT NULL DEFAULT 0,
  distribution_usd numeric NOT NULL DEFAULT 0,
  total_usd numeric NOT NULL DEFAULT 0,
  accumulation_pct numeric NOT NULL DEFAULT 0,
  neutral_pct numeric NOT NULL DEFAULT 100,
  distribution_pct numeric NOT NULL DEFAULT 0,
  flow_score numeric NOT NULL DEFAULT 0,
  dominant_state text NOT NULL CHECK (dominant_state IN ('accumulation','neutral','distribution')),
  source text NOT NULL DEFAULT 'whale_alerts_latest_12',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_at)
);

CREATE INDEX IF NOT EXISTS idx_whale_flow_snapshots_bucket
  ON public.whale_flow_snapshots (bucket_at DESC);

CREATE TABLE IF NOT EXISTS public.whale_flow_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_snapshot_id uuid NOT NULL REFERENCES public.whale_flow_snapshots(id) ON DELETE CASCADE,
  to_snapshot_id uuid NOT NULL REFERENCES public.whale_flow_snapshots(id) ON DELETE CASCADE,
  previous_state text NOT NULL CHECK (previous_state IN ('accumulation','neutral','distribution')),
  new_state text NOT NULL CHECK (new_state IN ('accumulation','neutral','distribution')),
  detected_at timestamptz NOT NULL,
  delta_score numeric NOT NULL,
  delta_pp numeric NOT NULL,
  velocity_pp_per_hour numeric,
  transition_speed text NOT NULL CHECK (transition_speed IN ('smooth','accelerating','violent')),
  trigger_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_snapshot_id, to_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_whale_flow_transitions_detected
  ON public.whale_flow_transitions (detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_whale_flow_transitions_state
  ON public.whale_flow_transitions (new_state, detected_at DESC);

GRANT SELECT ON public.whale_flow_snapshots TO anon, authenticated;
GRANT SELECT ON public.whale_flow_transitions TO anon, authenticated;
GRANT ALL ON public.whale_flow_snapshots TO service_role;
GRANT ALL ON public.whale_flow_transitions TO service_role;

ALTER TABLE public.whale_flow_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whale_flow_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read whale_flow_snapshots" ON public.whale_flow_snapshots;
CREATE POLICY "public read whale_flow_snapshots"
  ON public.whale_flow_snapshots FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public read whale_flow_transitions" ON public.whale_flow_transitions;
CREATE POLICY "public read whale_flow_transitions"
  ON public.whale_flow_transitions FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.record_whale_flow_snapshot(p_as_of timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bucket timestamptz := date_trunc('minute', p_as_of);
  v_inserted integer;
  v_snapshot public.whale_flow_snapshots%ROWTYPE;
  v_prev public.whale_flow_snapshots%ROWTYPE;
  v_buy numeric := 0;
  v_sell numeric := 0;
  v_total numeric := 0;
  v_acc_pct numeric := 0;
  v_dist_pct numeric := 0;
  v_neutral_pct numeric := 100;
  v_score numeric := 0;
  v_state text := 'neutral';
  v_hours numeric;
  v_velocity numeric;
  v_speed text;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'accumulation' THEN usd_value ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'distribution' THEN usd_value ELSE 0 END), 0),
    COALESCE(SUM(usd_value), 0),
    COUNT(*)::integer
  INTO v_buy, v_sell, v_total, v_inserted
  FROM (
    SELECT direction, usd_value
    FROM public.whale_alerts
    WHERE created_at <= p_as_of
    ORDER BY created_at DESC
    LIMIT 12
  ) q;

  IF v_inserted = 0 OR v_total <= 0 THEN
    RETURN;
  END IF;

  -- Directional imbalance becomes Accumulation/Distribution share;
  -- the remaining share is Neutral. This is descriptive, not a trading rule.
  v_score := GREATEST(-1, LEAST(1, (v_buy - v_sell) / NULLIF(v_total, 0)));
  v_acc_pct := ROUND(GREATEST(0, v_score) * 100, 2);
  v_dist_pct := ROUND(GREATEST(0, -v_score) * 100, 2);
  v_neutral_pct := ROUND(GREATEST(0, 100 - v_acc_pct - v_dist_pct), 2);

  IF v_acc_pct > v_dist_pct AND v_acc_pct > v_neutral_pct THEN
    v_state := 'accumulation';
  ELSIF v_dist_pct > v_acc_pct AND v_dist_pct > v_neutral_pct THEN
    v_state := 'distribution';
  ELSE
    v_state := 'neutral';
  END IF;

  INSERT INTO public.whale_flow_snapshots (
    bucket_at, sample_size, accumulation_usd, distribution_usd, total_usd,
    accumulation_pct, neutral_pct, distribution_pct, flow_score, dominant_state
  )
  VALUES (
    v_bucket, v_inserted, v_buy, v_sell, v_total,
    v_acc_pct, v_neutral_pct, v_dist_pct, v_score, v_state
  )
  ON CONFLICT (bucket_at) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN;
  END IF;

  SELECT * INTO v_snapshot
  FROM public.whale_flow_snapshots
  WHERE bucket_at = v_bucket;

  SELECT * INTO v_prev
  FROM public.whale_flow_snapshots
  WHERE bucket_at < v_bucket
  ORDER BY bucket_at DESC
  LIMIT 1;

  IF NOT FOUND OR v_prev.dominant_state = v_snapshot.dominant_state THEN
    RETURN;
  END IF;

  v_hours := GREATEST(EXTRACT(EPOCH FROM (v_snapshot.bucket_at - v_prev.bucket_at)) / 3600.0, 0.0167);
  v_velocity := ABS(v_snapshot.flow_score - v_prev.flow_score) * 100 / v_hours;

  IF v_velocity >= 15 THEN
    v_speed := 'violent';
  ELSIF v_velocity >= 5 THEN
    v_speed := 'accelerating';
  ELSE
    v_speed := 'smooth';
  END IF;

  INSERT INTO public.whale_flow_transitions (
    from_snapshot_id, to_snapshot_id, previous_state, new_state,
    detected_at, delta_score, delta_pp, velocity_pp_per_hour,
    transition_speed, trigger_candidates
  )
  VALUES (
    v_prev.id, v_snapshot.id, v_prev.dominant_state, v_snapshot.dominant_state,
    v_snapshot.bucket_at, v_snapshot.flow_score - v_prev.flow_score,
    (v_snapshot.flow_score - v_prev.flow_score) * 100,
    ROUND(v_velocity, 2), v_speed,
    jsonb_build_array(
      jsonb_build_object('type','whale_flow_imbalance','delta_pp',
        ROUND((v_snapshot.flow_score - v_prev.flow_score) * 100, 2)),
      jsonb_build_object('type','sell_usd','value',v_snapshot.distribution_usd),
      jsonb_build_object('type','buy_usd','value',v_snapshot.accumulation_usd)
    )
  )
  ON CONFLICT (from_snapshot_id, to_snapshot_id) DO NOTHING;
EXCEPTION
  WHEN OTHERS THEN
    -- History is strictly fail-open: never break whale ingestion.
    RAISE WARNING '[WHALE_FLOW_HISTORY] non-fatal: %', SQLERRM;
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.record_whale_flow_snapshot(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_whale_flow_snapshot(timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.capture_whale_flow_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.record_whale_flow_snapshot(NEW.created_at);
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING '[WHALE_FLOW_HISTORY_TRIGGER] non-fatal: %', SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_whale_flow_history ON public.whale_alerts;
CREATE TRIGGER trg_capture_whale_flow_history
AFTER INSERT ON public.whale_alerts
FOR EACH ROW
EXECUTE FUNCTION public.capture_whale_flow_history();

REVOKE ALL ON FUNCTION public.capture_whale_flow_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_whale_flow_history() TO service_role;

-- Backfill a bounded seven-day history from the existing whale_alerts feed.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT date_trunc('minute', created_at) AS bucket_at
    FROM public.whale_alerts
    WHERE created_at >= now() - interval '7 days'
    ORDER BY bucket_at
  LOOP
    PERFORM public.record_whale_flow_snapshot(r.bucket_at);
  END LOOP;
END $$;

-- Reconstruct transition events from the backfilled snapshots.
INSERT INTO public.whale_flow_transitions (
  from_snapshot_id, to_snapshot_id, previous_state, new_state,
  detected_at, delta_score, delta_pp, velocity_pp_per_hour,
  transition_speed, trigger_candidates
)
SELECT
  p.id,
  s.id,
  p.dominant_state,
  s.dominant_state,
  s.bucket_at,
  s.flow_score - p.flow_score,
  (s.flow_score - p.flow_score) * 100,
  ROUND(
    ABS(s.flow_score - p.flow_score) * 100 /
    GREATEST(EXTRACT(EPOCH FROM (s.bucket_at - p.bucket_at)) / 3600.0, 0.0167),
    2
  ),
  CASE
    WHEN ABS(s.flow_score - p.flow_score) * 100 /
      GREATEST(EXTRACT(EPOCH FROM (s.bucket_at - p.bucket_at)) / 3600.0, 0.0167) >= 15 THEN 'violent'
    WHEN ABS(s.flow_score - p.flow_score) * 100 /
      GREATEST(EXTRACT(EPOCH FROM (s.bucket_at - p.bucket_at)) / 3600.0, 0.0167) >= 5 THEN 'accelerating'
    ELSE 'smooth'
  END,
  jsonb_build_array(
    jsonb_build_object('type','whale_flow_imbalance','delta_pp',
      ROUND((s.flow_score - p.flow_score) * 100, 2)),
    jsonb_build_object('type','sell_usd','value',s.distribution_usd),
    jsonb_build_object('type','buy_usd','value',s.accumulation_usd)
  )
FROM public.whale_flow_snapshots s
JOIN LATERAL (
  SELECT *
  FROM public.whale_flow_snapshots x
  WHERE x.bucket_at < s.bucket_at
  ORDER BY x.bucket_at DESC
  LIMIT 1
) p ON true
WHERE s.bucket_at >= now() - interval '7 days'
  AND s.dominant_state <> p.dominant_state
ON CONFLICT (from_snapshot_id, to_snapshot_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'whale_flow_snapshots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whale_flow_snapshots;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'whale_flow_transitions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.whale_flow_transitions;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
