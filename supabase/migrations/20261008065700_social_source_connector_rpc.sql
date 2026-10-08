-- P3.2.5 connector lookup RPC

create or replace function public.get_social_source_connector(p_connector_key text)
returns table (
  id uuid,
  connector_key text,
  platform text,
  cost_model text,
  login_required boolean,
  api_key_required boolean,
  subscription_required boolean,
  rate_limit_requests_per_minute integer,
  cache_ttl_seconds integer,
  enabled boolean,
  dependency_role text,
  reliability text,
  access_risk text
)
language sql
security definer
set search_path=public
as $$
  select
    c.id,c.connector_key,c.platform,c.cost_model,c.login_required,
    c.api_key_required,c.subscription_required,
    c.rate_limit_requests_per_minute,c.cache_ttl_seconds,c.enabled,
    c.dependency_role,c.reliability,c.access_risk
  from public.social_source_connectors c
  where c.connector_key=p_connector_key
  limit 1
$$;

revoke all on function public.get_social_source_connector(text)
from public, anon, authenticated;
grant execute on function public.get_social_source_connector(text) to service_role;
