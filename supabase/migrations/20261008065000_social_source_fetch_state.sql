-- P3.2.5 persistent social source fetch state + rate-limit/circuit-breaker helpers

create table if not exists public.social_source_fetch_state (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references public.social_source_connectors(id) on delete cascade,
  source_id uuid references public.influential_social_sources(id) on delete cascade,
  resource_key text not null,
  last_requested_at timestamptz,
  next_allowed_at timestamptz,
  cache_expires_at timestamptz,
  last_success_at timestamptz,
  last_http_status integer,
  last_rate_limit_remaining integer,
  last_rate_limit_reset timestamptz,
  last_retry_after_seconds integer,
  consecutive_failures integer not null default 0,
  circuit_state text not null default 'closed' check (circuit_state in ('closed','open')),
  last_error_code text,
  last_error_message text,
  updated_at timestamptz not null default now(),
  unique (connector_id, resource_key)
);

create index if not exists idx_social_source_fetch_state_due
  on public.social_source_fetch_state (next_allowed_at);

create index if not exists idx_social_source_fetch_state_source
  on public.social_source_fetch_state (source_id, resource_key);

alter table public.social_source_fetch_state enable row level security;

create or replace function public.claim_social_source_fetch(
  p_connector_id uuid,
  p_source_id uuid,
  p_resource_key text,
  p_cache_ttl_seconds integer default 3600,
  p_min_interval_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.social_source_fetch_state;
  v_now timestamptz := now();
begin
  if current_user <> 'service_role' then
    raise exception 'service_role_only';
  end if;

  insert into public.social_source_fetch_state (connector_id, source_id, resource_key)
  values (p_connector_id, p_source_id, p_resource_key)
  on conflict (connector_id, resource_key) do nothing;

  select *
  into v_row
  from public.social_source_fetch_state
  where connector_id = p_connector_id
    and resource_key = p_resource_key
  for update;

  if v_row.circuit_state = 'open'
     and v_row.next_allowed_at is not null
     and v_row.next_allowed_at > v_now then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'circuit_open',
      'next_allowed_at', v_row.next_allowed_at
    );
  end if;

  if v_row.next_allowed_at is not null and v_row.next_allowed_at > v_now then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'next_allowed_at', v_row.next_allowed_at
    );
  end if;

  if v_row.cache_expires_at is not null and v_row.cache_expires_at > v_now then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'cache',
      'cache_expires_at', v_row.cache_expires_at
    );
  end if;

  update public.social_source_fetch_state
  set last_requested_at = v_now,
      next_allowed_at = v_now + make_interval(secs => greatest(1, p_min_interval_seconds)),
      cache_expires_at = v_now + make_interval(secs => greatest(1, p_cache_ttl_seconds)),
      updated_at = v_now
  where id = v_row.id;

  return jsonb_build_object(
    'allowed', true,
    'claimed_at', v_now,
    'next_allowed_at', v_now + make_interval(secs => greatest(1, p_min_interval_seconds))
  );
end;
$$;

revoke all on function public.claim_social_source_fetch(uuid, uuid, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_social_source_fetch(uuid, uuid, text, integer, integer)
to service_role;

create or replace function public.record_social_source_fetch_result(
  p_connector_id uuid,
  p_resource_key text,
  p_http_status integer,
  p_status text,
  p_rate_limit_remaining integer default null,
  p_rate_limit_reset_seconds integer default null,
  p_retry_after_seconds integer default null,
  p_error_code text default null,
  p_error_message text default null,
  p_cache_ttl_seconds integer default 3600
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_success boolean := p_status = 'ok';
  v_next timestamptz;
begin
  if current_user <> 'service_role' then
    raise exception 'service_role_only';
  end if;

  v_next := case
    when p_retry_after_seconds is not null
      then v_now + make_interval(secs => greatest(1, p_retry_after_seconds))
    when p_rate_limit_reset_seconds is not null
      then v_now + make_interval(secs => greatest(1, p_rate_limit_reset_seconds))
    when v_success
      then v_now + make_interval(secs => greatest(1, p_cache_ttl_seconds))
    else v_now + interval '15 minutes'
  end;

  update public.social_source_fetch_state
  set last_http_status = p_http_status,
      last_rate_limit_remaining = p_rate_limit_remaining,
      last_rate_limit_reset = case
        when p_rate_limit_reset_seconds is not null
        then v_now + make_interval(secs => greatest(0, p_rate_limit_reset_seconds))
        else last_rate_limit_reset
      end,
      last_retry_after_seconds = p_retry_after_seconds,
      last_success_at = case when v_success then v_now else last_success_at end,
      consecutive_failures = case when v_success then 0 else consecutive_failures + 1 end,
      circuit_state = case
        when v_success then 'closed'
        when consecutive_failures + 1 >= 3 then 'open'
        else circuit_state
      end,
      next_allowed_at = v_next,
      cache_expires_at = case when v_success then v_next else cache_expires_at end,
      last_error_code = case when v_success then null else p_error_code end,
      last_error_message = case when v_success then null else left(p_error_message, 1000) end,
      updated_at = v_now
  where connector_id = p_connector_id
    and resource_key = p_resource_key;
end;
$$;

revoke all on function public.record_social_source_fetch_result(
  uuid, text, integer, text, integer, integer, integer, text, text, integer
) from public, anon, authenticated;
grant execute on function public.record_social_source_fetch_result(
  uuid, text, integer, text, integer, integer, integer, text, text, integer
) to service_role;
