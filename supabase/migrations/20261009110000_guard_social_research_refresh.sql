-- Ensure historical/irrelevant social posts cannot create causal transmission links.
-- Refresh each research stage independently so one stage's failure does not suppress the others.
-- Research-only; no trading, execution, risk, signal, or V1/V2 behavior is changed.

create or replace function public.link_influential_social_transmission(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  e public.influential_social_events%rowtype;
  a text;
  n record;
  ss record;
  f record;
  score numeric;
  cls text;
  reason text;
  cnt integer := 0;
  evts integer := 0;
begin
  if current_user not in ('service_role','postgres') then
    raise exception 'service_role required';
  end if;

  select * into e from public.influential_social_events where id = p_event_id;
  if not found then raise exception 'event % not found', p_event_id; end if;

  if e.classification_status <> 'classified' then
    return jsonb_build_object('event_id',p_event_id,'status','insufficient','reason','event_not_classified','research_only',true);
  end if;

  -- Delayed and irrelevant posts remain historical records, not causal research inputs.
  if to_jsonb(e)->>'research_eligibility' is distinct from 'live_eligible' then
    update public.influential_social_events
      set market_link_status = 'insufficient_data', updated_at = now()
      where id = p_event_id;
    return jsonb_build_object('event_id',p_event_id,'status','skipped','reason','not_live_eligible','research_only',true);
  end if;

  foreach a in array coalesce(e.affected_assets,array[]::text[]) loop
    -- SELECT INTO clears its target on no match; avoid assigning NULL to an
    -- uninitialised PL/pgSQL RECORD variable before its row shape is known.
    select * into n
    from public.asset_news_events x
    where upper(x.asset)=upper(a)
      and x.event_at between e.published_at-interval '5 minutes' and e.published_at+interval '30 minutes'
    order by case when x.event_at>=e.published_at then 0 else 1 end,
             abs(extract(epoch from (x.event_at-e.published_at)))
    limit 1;

    select * into ss
    from public.asset_sentiment_snapshots x
    where upper(x.asset)=upper(a)
      and x.observed_at between e.published_at-interval '5 minutes' and e.published_at+interval '30 minutes'
    order by case when x.observed_at>=e.published_at then 0 else 1 end,
             abs(extract(epoch from (x.observed_at-e.published_at)))
    limit 1;

    select * into f
    from public.event_flow_transmissions x
    where upper(x.asset)=upper(a)
      and x.event_at between e.published_at and e.published_at+interval '4 hours'
    order by abs(extract(epoch from (x.event_at-e.published_at)))
    limit 1;

    score := 0; cls := 'post_only'; reason := 'social_event_only';
    if n.id is not null then score:=score+0.15; reason:=reason||';news_link'; end if;
    if ss.observed_at is not null and abs(coalesce(ss.shock_score,0))>0 then score:=score+0.30; reason:=reason||';sentiment_shock'; end if;
    if f.id is not null then score:=score+0.30; reason:=reason||';flow_response'; end if;
    if f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null then
      score:=score+0.15; reason:=reason||';price_response';
    end if;

    if f.id is not null and (f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null) then
      cls:='flow_to_price';
    elsif f.id is not null and ss.observed_at is not null then
      cls:='sentiment_to_flow';
    elsif ss.observed_at is not null then
      cls:='sentiment_only';
    end if;
    if ss.observed_at is not null and f.id is not null
       and (f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null) then
      cls:='full_chain';
    end if;

    insert into public.influential_social_transmission_links
      (event_id,asset,news_event_id,sentiment_snapshot_at,sentiment_shock,news_shock,
       flow_event_id,flow_shock,price_return_15m,price_return_30m,price_return_1h,price_return_4h,price_return_24h,
       latency_post_to_sentiment_minutes,latency_sentiment_to_flow_minutes,latency_post_to_flow_minutes,
       transmission_class,chain_score,chain_reason)
    values
      (p_event_id,upper(a),n.id,ss.observed_at,ss.shock_score,n.shock_score,
       f.id,f.shock_score,f.price_return_15m,f.price_return_30m,f.price_return_1h,f.price_return_4h,f.price_return_24h,
       case when ss.observed_at is not null then extract(epoch from (ss.observed_at-e.published_at))/60 end,
       case when ss.observed_at is not null and f.event_at is not null then extract(epoch from (f.event_at-ss.observed_at))/60 end,
       case when f.event_at is not null then extract(epoch from (f.event_at-e.published_at))/60 end,
       cls,least(1,score),reason)
    on conflict(event_id,asset) do update set
      news_event_id=excluded.news_event_id,
      sentiment_snapshot_at=excluded.sentiment_snapshot_at,
      sentiment_shock=excluded.sentiment_shock,
      news_shock=excluded.news_shock,
      flow_event_id=excluded.flow_event_id,
      flow_shock=excluded.flow_shock,
      price_return_15m=excluded.price_return_15m,
      price_return_30m=excluded.price_return_30m,
      price_return_1h=excluded.price_return_1h,
      price_return_4h=excluded.price_return_4h,
      price_return_24h=excluded.price_return_24h,
      latency_post_to_sentiment_minutes=excluded.latency_post_to_sentiment_minutes,
      latency_sentiment_to_flow_minutes=excluded.latency_sentiment_to_flow_minutes,
      latency_post_to_flow_minutes=excluded.latency_post_to_flow_minutes,
      transmission_class=excluded.transmission_class,
      chain_score=excluded.chain_score,
      chain_reason=excluded.chain_reason,
      observed_at=now();

    cnt:=cnt+1;
  end loop;

  select count(*) into evts
  from public.influential_social_transmission_links where event_id=p_event_id;

  -- A stored post-only row is not evidence of a market/transmission link.
  update public.influential_social_events
  set market_link_status = case
    when exists(
      select 1 from public.influential_social_transmission_links l
      where l.event_id=p_event_id
        and l.transmission_class in ('sentiment_only','sentiment_to_flow','flow_to_price','full_chain','mixed')
    ) then 'linked'
    when evts>0 then 'insufficient_data'
    else 'insufficient_data'
  end,
  updated_at=now()
  where id=p_event_id;

  return jsonb_build_object('event_id',p_event_id,'status','linked','assets',cnt,'research_only',true);
end;
$$;

revoke all on function public.link_influential_social_transmission(uuid) from public, anon, authenticated;
grant execute on function public.link_influential_social_transmission(uuid) to service_role;

create or replace function public.refresh_influential_social_research(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  r record;
  v_events integer := 0;
  v_links integer := 0;
  v_observations integer := 0;
  v_validations integer := 0;
  v_errors integer := 0;
begin
  for r in
    select e.id
    from public.influential_social_events e
    where to_jsonb(e)->>'research_eligibility' = 'live_eligible'
      and e.classification_status = 'classified'
      and e.published_at >= now()-interval '26 hours'
      and e.published_at <= now()-interval '15 minutes'
    order by e.published_at asc
    limit greatest(1,least(coalesce(p_limit,200),1000))
  loop
    v_events := v_events + 1;

    begin
      perform public.link_influential_social_transmission(r.id);
      v_links := v_links + 1;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'social transmission refresh failed for event %: %', r.id, sqlerrm;
    end;

    begin
      perform public.observe_influential_social_market_response(r.id);
      v_observations := v_observations + 1;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'social market observation refresh failed for event %: %', r.id, sqlerrm;
    end;

    begin
      perform public.validate_influential_social_transmission(r.id);
      v_validations := v_validations + 1;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'social transmission validation failed for event %: %', r.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'checked_events',v_events,
    'links_refreshed',v_links,
    'observations_refreshed',v_observations,
    'validations_refreshed',v_validations,
    'errors',v_errors,
    'research_only',true,
    'checked_at',now()
  );
end;
$$;

revoke all on function public.refresh_influential_social_research(integer) from public, anon, authenticated;
grant execute on function public.refresh_influential_social_research(integer) to service_role;
