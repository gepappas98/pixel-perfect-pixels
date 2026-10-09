-- Fix retry cache so failed social-source fetches can retry at next_allowed_at.
-- Preserve service-role guard, Retry-After handling, rate-limit handling and circuit breaker.
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
      cache_expires_at = case when v_success then v_next else null end,
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
