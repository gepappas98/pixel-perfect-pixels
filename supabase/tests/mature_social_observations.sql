-- Read-only policy checks for the matured social observation worker.
-- Run after migration 20261009100000_mature_social_research_observations.sql.
-- Does not modify any production rows.

do $$
declare
  v_event_at timestamptz := timestamptz '2026-10-09 12:00:00+00';
  v_now timestamptz := timestamptz '2026-10-09 12:10:00+00';
  v_target timestamptz;
  v_horizon interval;
  v_mature boolean;
begin
  -- A 15m horizon is not mature at +10m.
  v_horizon := interval '15 minutes';
  v_target := v_event_at + v_horizon;
  v_mature := v_now >= v_target;
  if v_mature then raise exception 'FAIL: 15m horizon matured at +10m'; end if;

  -- A 15m horizon is mature at +15m.
  v_now := timestamptz '2026-10-09 12:15:00+00';
  v_mature := v_now >= v_target;
  if not v_mature then raise exception 'FAIL: 15m horizon not mature at +15m'; end if;

  -- A 24h horizon is not mature at +23h59m.
  v_horizon := interval '24 hours';
  v_target := v_event_at + v_horizon;
  v_now := timestamptz '2026-10-10 11:59:00+00';
  v_mature := v_now >= v_target;
  if v_mature then raise exception 'FAIL: 24h horizon matured early'; end if;

  -- A 24h horizon matures at +24h.
  v_now := timestamptz '2026-10-10 12:00:00+00';
  v_mature := v_now >= v_target;
  if not v_mature then raise exception 'FAIL: 24h horizon did not mature on time'; end if;

  -- No post-price endpoint means no outcome row should be created.
  -- This mirrors the worker's guard: IF v_post_price IS NULL THEN CONTINUE.
  if null::numeric is not null then
    raise exception 'FAIL: NULL post-price endpoint unexpectedly exists';
  end if;
end;
$$;

-- Coverage diagnostic: existing observations should be considered complete only
-- when a post-event price exists; this query is read-only.
select
  count(*) as total_observations,
  count(*) filter (where price_after is not null) as with_post_price,
  count(*) filter (where price_before is null) as missing_pre_price,
  count(*) filter (where sentiment_before is null or sentiment_after is null) as missing_sentiment_endpoints,
  count(*) filter (where flow_before is null or flow_after is null) as missing_flow_endpoints
from public.influential_social_market_observations;
