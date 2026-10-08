-- Free-first social source probe policy.
-- No ingestion is performed here. Collectors must honor this policy and must
-- never bypass authentication, bot protection, access controls, or rate limits.

create table if not exists public.social_source_probe_runs (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.social_source_connectors(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('ok','blocked','rate_limited','timeout','parse_error','error','skipped')),
  http_status integer,
  response_bytes integer,
  posts_found integer not null default 0,
  parser_version text,
  latency_ms integer,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_social_source_probe_runs_connector_time
on public.social_source_probe_runs (connector_id, started_at desc);

alter table public.social_source_probe_runs enable row level security;
revoke all on public.social_source_probe_runs from anon, authenticated;
grant select on public.social_source_probe_runs to service_role;

create or replace function public.get_social_source_probe_policy(p_connector_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.social_source_connectors%rowtype;
begin
  select * into c from public.social_source_connectors where connector_key = p_connector_key;
  if not found then raise exception 'Unknown social connector: %', p_connector_key; end if;

  return jsonb_build_object(
    'connector_key', c.connector_key,
    'platform', c.platform,
    'allowed', (
      c.enabled and c.cost_model = 'free'
      and not c.login_required
      and not c.api_key_required
      and not c.subscription_required
    ),
    'max_requests_per_minute', coalesce(c.rate_limit_requests_per_minute, 0),
    'cache_ttl_seconds', c.cache_ttl_seconds,
    'dependency_role', c.dependency_role,
    'reliability', c.reliability,
    'access_risk', c.access_risk
  );
end;
$$;

revoke all on function public.get_social_source_probe_policy(text) from public, anon, authenticated;
grant execute on function public.get_social_source_probe_policy(text) to service_role;
