-- Research-only read path for dashboard early-warning alerts.
-- The underlying research_alerts table remains service-role-only.

create or replace function public.get_research_alerts(p_limit integer default 20)
returns table (
  id uuid,
  alert_type text,
  severity text,
  asset text,
  source text,
  event_id uuid,
  event_at timestamptz,
  detected_at timestamptz,
  message text,
  evidence jsonb,
  acknowledged boolean,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select
    ra.id,
    ra.alert_type,
    ra.severity,
    ra.asset,
    ra.source,
    ra.event_id,
    ra.event_at,
    ra.detected_at,
    ra.message,
    ra.evidence,
    ra.acknowledged,
    ra.created_at
  from public.research_alerts ra
  where ra.acknowledged = false
    and ra.detected_at >= now() - interval '24 hours'
  order by ra.detected_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function public.get_research_alerts(integer) from public, anon, authenticated;
grant execute on function public.get_research_alerts(integer) to anon, authenticated;
