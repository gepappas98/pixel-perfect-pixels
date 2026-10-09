-- Mature social research observations only when the requested horizon has elapsed
-- and the corresponding market snapshots actually exist.
-- Research-only: no trading signals, execution, risk, V1/V2, or trades are changed.

create or replace function public.observe_influential_social_market_response(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  e public.influential_social_events%rowtype;
  a text;
  h text;
  v_event_at timestamptz;
  v_target_at timestamptz;
  v_tolerance interval;
  v_pre_sent numeric;
  v_post_sent numeric;
  v_pre_price numeric;
  v_post_price numeric;
  v_pre_flow numeric;
  v_post_flow numeric;
  v_sd numeric;
  v_ps numeric;
  v_fd numeric;
  v_score numeric;
  v_class text;
  v_reason text;
  v_count integer := 0;
  v_skipped_immature integer := 0;
begin
  select * into e
  from public.influential_social_events
  where id = p_event_id;

  if not found then
    raise exception 'influential social event % not found', p_event_id;
  end if;

  if e.classification_status <> 'classified'
     or e.crypto_relevance not in ('high','medium')
     or cardinality(coalesce(e.affected_assets,array[]::text[])) = 0 then
    update public.influential_social_events
    set market_link_status = 'insufficient_data', updated_at = now()
    where id = p_event_id;
    return jsonb_build_object('event_id',p_event_id,'status','insufficient','reason','event_not_crypto_classified','research_only',true);
  end if;

  -- Never use delayed ingestion as causal evidence. The historical record stays,
  -- but only events explicitly eligible for live research enter this observer.
  if to_jsonb(e)->>'research_eligibility' is distinct from 'live_eligible' then
    return jsonb_build_object('event_id',p_event_id,'status','skipped','reason','not_live_eligible','research_only',true);
  end if;

  v_event_at := e.published_at;

  foreach a in array e.affected_assets loop
    foreach h in array array['15m','30m','1h','4h','24h'] loop
      v_target_at := v_event_at + case h
        when '15m' then interval '15 minutes'
        when '30m' then interval '30 minutes'
        when '1h' then interval '1 hour'
        when '4h' then interval '4 hours'
        else interval '24 hours'
      end;

      if now() < v_target_at then
        v_skipped_immature := v_skipped_immature + 1;
        continue;
      end if;

      v_tolerance := case when h in ('15m','30m') then interval '10 minutes'
                          when h in ('1h','4h') then interval '5 minutes'
                          else interval '10 minutes' end;

      v_pre_sent := null; v_post_sent := null;
      v_pre_price := null; v_post_price := null;
      v_pre_flow := null; v_post_flow := null;

      select s.sentiment_score into v_pre_sent
      from public.asset_sentiment_snapshots s
      where upper(s.asset)=upper(a)
        and s.observed_at between v_event_at-interval '10 minutes' and v_event_at
      order by s.observed_at desc limit 1;

      select p.price into v_pre_price
      from public.asset_price_snapshots p
      where upper(p.asset)=upper(a)
        and p.observed_at between v_event_at-interval '10 minutes' and v_event_at
      order by p.observed_at desc limit 1;

      select f.flow_score into v_pre_flow
      from public.asset_flow_snapshots f
      where upper(f.asset)=upper(a)
        and f.bucket_at between v_event_at-interval '10 minutes' and v_event_at
      order by f.bucket_at desc limit 1;

      select s.sentiment_score into v_post_sent
      from public.asset_sentiment_snapshots s
      where upper(s.asset)=upper(a)
        and s.observed_at between v_target_at-v_tolerance and v_target_at+v_tolerance
      order by abs(extract(epoch from (s.observed_at-v_target_at))) limit 1;

      select p.price into v_post_price
      from public.asset_price_snapshots p
      where upper(p.asset)=upper(a)
        and p.observed_at between v_target_at-v_tolerance and v_target_at+v_tolerance
      order by abs(extract(epoch from (p.observed_at-v_target_at))) limit 1;

      select f.flow_score into v_post_flow
      from public.asset_flow_snapshots f
      where upper(f.asset)=upper(a)
        and f.bucket_at between v_target_at-v_tolerance and v_target_at+v_tolerance
      order by abs(extract(epoch from (f.bucket_at-v_target_at))) limit 1;

      -- No outcome row is created until at least the post-horizon price exists.
      -- The periodic sweep retries missing endpoints rather than freezing NULLs.
      if v_post_price is null then
        continue;
      end if;

      v_sd := case when v_pre_sent is not null and v_post_sent is not null then v_post_sent-v_pre_sent end;
      v_ps := case when v_pre_price is not null and v_post_price is not null and v_pre_price<>0 then v_post_price/v_pre_price-1 end;
      v_fd := case when v_pre_flow is not null and v_post_flow is not null then v_post_flow-v_pre_flow end;
      v_score := least(1,greatest(0,coalesce(abs(v_sd),0)*0.35+coalesce(abs(v_ps),0)*8*0.40+coalesce(abs(v_fd),0)*0.25));

      if v_pre_price is null then v_class:='insufficient'; v_reason:='missing_pre_event_price';
      elsif v_score>=0.80 then v_class:='market_moving'; v_reason:='large_post_event_response';
      elsif v_score>=0.55 then v_class:='major_response'; v_reason:='strong_post_event_response';
      elsif v_score>=0.30 then v_class:='notable_response'; v_reason:='measurable_post_event_response';
      elsif v_score>0 then v_class:='weak_response'; v_reason:='small_post_event_response';
      else v_class:='insufficient'; v_reason:='no_measurable_response'; end if;

      insert into public.influential_social_market_observations
        (event_id,asset,horizon,sentiment_before,sentiment_after,sentiment_delta,
         price_before,price_after,price_return,flow_before,flow_after,flow_delta,
         evidence_class,evidence_score,evidence_reason,observed_at)
      values
        (p_event_id,upper(a),h,v_pre_sent,v_post_sent,v_sd,
         v_pre_price,v_post_price,v_ps,v_pre_flow,v_post_flow,v_fd,
         v_class,round(v_score,4),v_reason,now())
      on conflict(event_id,asset,horizon) do update set
        sentiment_before=coalesce(excluded.sentiment_before,influential_social_market_observations.sentiment_before),
        sentiment_after=coalesce(excluded.sentiment_after,influential_social_market_observations.sentiment_after),
        sentiment_delta=coalesce(excluded.sentiment_delta,influential_social_market_observations.sentiment_delta),
        price_before=coalesce(excluded.price_before,influential_social_market_observations.price_before),
        price_after=coalesce(excluded.price_after,influential_social_market_observations.price_after),
        price_return=coalesce(excluded.price_return,influential_social_market_observations.price_return),
        flow_before=coalesce(excluded.flow_before,influential_social_market_observations.flow_before),
        flow_after=coalesce(excluded.flow_after,influential_social_market_observations.flow_after),
        flow_delta=coalesce(excluded.flow_delta,influential_social_market_observations.flow_delta),
        evidence_class=excluded.evidence_class,
        evidence_score=excluded.evidence_score,
        evidence_reason=excluded.evidence_reason,
        observed_at=now();

      v_count := v_count + 1;
    end loop;
  end loop;

  update public.influential_social_events
  set market_link_status = case
    when exists(select 1 from public.influential_social_market_observations o where o.event_id=p_event_id and o.evidence_class in ('market_moving','major_response','notable_response')) then 'linked'
    when exists(select 1 from public.influential_social_market_observations o where o.event_id=p_event_id and o.price_return is not null) then 'no_response'
    else 'insufficient_data' end,
    updated_at = now()
  where id=p_event_id;

  return jsonb_build_object(
    'event_id',p_event_id,'status','observed','observations_upserted',v_count,
    'immature_horizons_skipped',v_skipped_immature,'research_only',true
  );
end;
$$;

revoke all on function public.observe_influential_social_market_response(uuid) from public, anon, authenticated;
grant execute on function public.observe_influential_social_market_response(uuid) to service_role;

-- Revisit recent, timely social events so matured horizons can be filled after
-- snapshots arrive. Both functions are idempotent/upsert-based and research-only.
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
      perform public.observe_influential_social_market_response(r.id);
      v_observations := v_observations + 1;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'social research refresh failed for event %: %', r.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('checked_events',v_events,'links_refreshed',v_links,
    'observations_refreshed',v_observations,'errors',v_errors,'research_only',true,'checked_at',now());
end;
$$;

revoke all on function public.refresh_influential_social_research(integer) from public, anon, authenticated;
grant execute on function public.refresh_influential_social_research(integer) to service_role;

-- Keep one named five-minute sweep; safe to rerun if a prior job exists.
do $$
declare v_job_id bigint;
begin
  if to_regnamespace('cron') is not null then
    select jobid into v_job_id from cron.job where jobname='refresh-influential-social-research' limit 1;
    if v_job_id is not null then
      perform cron.unschedule(v_job_id);
    end if;
    perform cron.schedule(
      'refresh-influential-social-research',
      '*/5 * * * *',
      'select public.refresh_influential_social_research(200);'
    );
  end if;
end;
$$;
