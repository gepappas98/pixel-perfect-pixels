-- Full-history V3 benchmark aggregate for the read-only Observatory.
-- Applied to canonical source project yckewtpfttvwiptmmrfq as migration 20261024040348.
-- RLS remains enforced: SECURITY INVOKER; this function performs SELECT/aggregation only.

CREATE INDEX IF NOT EXISTS research_cases_v3_mtf_benchmark_idx
ON public.research_cases (strategy, outcome, resolved_at DESC)
INCLUDE (net_pnl, entry_at, created_at)
WHERE cohort = 'V3'
  AND source_table = 'strategy_variant_signals'
  AND scorer_version = 'v3-mtf-aligned'
  AND fingerprint LIKE 'v3|%';

CREATE OR REPLACE FUNCTION public.observatory_v3_benchmark_summary()
RETURNS TABLE (
  strategy text,
  total_cases bigint,
  resolved_cases bigint,
  win_count bigint,
  loss_count bigint,
  expired_count bigint,
  open_count bigint,
  win_rate_pct numeric,
  avg_resolved_net_pnl numeric,
  sum_resolved_net_pnl numeric,
  pnl_unit text,
  first_resolved_at timestamptz,
  last_resolved_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  SELECT
    rc.strategy,
    count(*)::bigint AS total_cases,
    count(*) FILTER (WHERE rc.outcome IN ('win','loss','expired'))::bigint AS resolved_cases,
    count(*) FILTER (WHERE rc.outcome = 'win')::bigint AS win_count,
    count(*) FILTER (WHERE rc.outcome = 'loss')::bigint AS loss_count,
    count(*) FILTER (WHERE rc.outcome = 'expired')::bigint AS expired_count,
    count(*) FILTER (WHERE rc.outcome = 'open')::bigint AS open_count,
    round(
      100.0 * count(*) FILTER (WHERE rc.outcome = 'win')
      / NULLIF(count(*) FILTER (WHERE rc.outcome IN ('win','loss')), 0),
      2
    ) AS win_rate_pct,
    round(avg(rc.net_pnl) FILTER (WHERE rc.outcome IN ('win','loss','expired'))::numeric, 6) AS avg_resolved_net_pnl,
    round(sum(rc.net_pnl) FILTER (WHERE rc.outcome IN ('win','loss','expired'))::numeric, 6) AS sum_resolved_net_pnl,
    min(rc.pnl_unit) FILTER (WHERE rc.net_pnl IS NOT NULL) AS pnl_unit,
    min(rc.resolved_at) FILTER (WHERE rc.outcome IN ('win','loss','expired')) AS first_resolved_at,
    max(rc.resolved_at) FILTER (WHERE rc.outcome IN ('win','loss','expired')) AS last_resolved_at
  FROM public.research_cases rc
  WHERE rc.cohort = 'V3'
    AND rc.source_table = 'strategy_variant_signals'
    AND rc.scorer_version = 'v3-mtf-aligned'
    AND rc.fingerprint LIKE 'v3|%'
  GROUP BY rc.strategy
  ORDER BY rc.strategy;
$function$;

REVOKE ALL ON FUNCTION public.observatory_v3_benchmark_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observatory_v3_benchmark_summary() TO anon, authenticated;
