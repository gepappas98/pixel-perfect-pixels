create table if not exists public.influential_social_market_observations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.influential_social_events(id) on delete cascade,
  asset text not null,
  horizon text not null check (horizon in ('15m','30m','1h','4h','24h')),
  sentiment_before numeric,
  sentiment_after numeric,
  sentiment_delta numeric,
  sentiment_shock numeric,
  price_before numeric,
  price_after numeric,
  price_return numeric,
  flow_before numeric,
  flow_after numeric,
  flow_delta numeric,
  observed_at timestamptz not null default now(),
  evidence_class text not null default 'insufficient'
    check (evidence_class in ('insufficient','weak_response','notable_response','major_response','market_moving')),
  evidence_score numeric check (evidence_score between 0 and 1),
  evidence_reason text,
  created_at timestamptz not null default now(),
  unique(event_id, asset, horizon)
);

create index if not exists idx_social_market_obs_event
  on public.influential_social_market_observations(event_id, horizon);
create index if not exists idx_social_market_obs_asset_time
  on public.influential_social_market_observations(asset, observed_at desc);

alter table public.influential_social_market_observations enable row level security;
revoke all on public.influential_social_market_observations from anon, authenticated;
grant select, insert, update, delete on public.influential_social_market_observations to service_role;

create or replace function public.observe_influential_social_market_response(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 e public.influential_social_events%rowtype;
 a text; h text; v_event_at timestamptz;
 v_pre_sent numeric; v_post_sent numeric; v_pre_price numeric; v_post_price numeric;
 v_pre_flow numeric; v_post_flow numeric; v_sd numeric; v_ps numeric; v_fd numeric;
 v_score numeric; v_class text; v_reason text; v_count integer:=0;
begin
 select * into e from public.influential_social_events where id=p_event_id;
 if not found then raise exception 'influential social event % not found',p_event_id; end if;

 if e.classification_status <> 'classified'
    or e.crypto_relevance not in ('high','medium')
    or cardinality(coalesce(e.affected_assets,array[]::text[]))=0 then
   update public.influential_social_events set market_link_status='insufficient',updated_at=now() where id=p_event_id;
   return jsonb_build_object('event_id',p_event_id,'status','insufficient','reason','event_not_crypto_classified');
 end if;

 v_event_at:=e.published_at;

 foreach a in array e.affected_assets loop
  foreach h in array array['15m','30m','1h','4h','24h'] loop
   v_pre_sent:=null; v_post_sent:=null; v_pre_price:=null; v_post_price:=null; v_pre_flow:=null; v_post_flow:=null;

   select s.sentiment_score into v_pre_sent from public.asset_sentiment_snapshots s
   where upper(s.asset)=upper(a) and s.observed_at between v_event_at-interval '10 minutes' and v_event_at
   order by s.observed_at desc limit 1;
   select p.price into v_pre_price from public.asset_price_snapshots p
   where upper(p.asset)=upper(a) and p.observed_at between v_event_at-interval '10 minutes' and v_event_at
   order by p.observed_at desc limit 1;
   select t.baseline_flow_score into v_pre_flow from public.event_flow_transmissions t
   where upper(t.asset)=upper(a) and t.event_at between v_event_at-interval '10 minutes' and v_event_at+interval '10 minutes'
   order by abs(extract(epoch from(t.event_at-v_event_at))) limit 1;

   if h='15m' then
    select s.sentiment_score into v_post_sent from public.asset_sentiment_snapshots s where upper(s.asset)=upper(a) and s.observed_at between v_event_at+interval '10 minutes' and v_event_at+interval '25 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '15 minutes')))) limit 1;
    select p.price into v_post_price from public.asset_price_snapshots p where upper(p.asset)=upper(a) and p.observed_at between v_event_at+interval '10 minutes' and v_event_at+interval '25 minutes' order by abs(extract(epoch from(p.observed_at-(v_event_at+interval '15 minutes')))) limit 1;
    select t.flow_15m into v_post_flow from public.event_flow_transmissions t where upper(t.asset)=upper(a) and abs(extract(epoch from(t.event_at-v_event_at)))<=60 limit 1;
   elsif h='30m' then
    select s.sentiment_score into v_post_sent from public.asset_sentiment_snapshots s where upper(s.asset)=upper(a) and s.observed_at between v_event_at+interval '25 minutes' and v_event_at+interval '40 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '30 minutes')))) limit 1;
    select p.price into v_post_price from public.asset_price_snapshots p where upper(p.asset)=upper(a) and p.observed_at between v_event_at+interval '25 minutes' and v_event_at+interval '40 minutes' order by abs(extract(epoch from(p.observed_at-(v_event_at+interval '30 minutes')))) limit 1;
    select t.flow_30m into v_post_flow from public.event_flow_transmissions t where upper(t.asset)=upper(a) and abs(extract(epoch from(t.event_at-v_event_at)))<=60 limit 1;
   elsif h='1h' then
    select s.sentiment_score into v_post_sent from public.asset_sentiment_snapshots s where upper(s.asset)=upper(a) and s.observed_at between v_event_at+interval '55 minutes' and v_event_at+interval '65 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '1 hour')))) limit 1;
    select p.price into v_post_price from public.asset_price_snapshots p where upper(p.asset)=upper(a) and p.observed_at between v_event_at+interval '55 minutes' and v_event_at+interval '65 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '1 hour')))) limit 1;
    select t.flow_60m into v_post_flow from public.event_flow_transmissions t where upper(t.asset)=upper(a) and abs(extract(epoch from(t.event_at-v_event_at)))<=60 limit 1;
   elsif h='4h' then
    select s.sentiment_score into v_post_sent from public.asset_sentiment_snapshots s where upper(s.asset)=upper(a) and s.observed_at between v_event_at+interval '235 minutes' and v_event_at+interval '245 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '4 hours')))) limit 1;
    select p.price into v_post_price from public.asset_price_snapshots p where upper(p.asset)=upper(a) and p.observed_at between v_event_at+interval '235 minutes' and v_event_at+interval '245 minutes' order by abs(extract(epoch from(p.observed_at-(v_event_at+interval '4 hours')))) limit 1;
   else
    select s.sentiment_score into v_post_sent from public.asset_sentiment_snapshots s where upper(s.asset)=upper(a) and s.observed_at between v_event_at+interval '1435 minutes' and v_event_at+interval '1445 minutes' order by abs(extract(epoch from(s.observed_at-(v_event_at+interval '24 hours')))) limit 1;
    select p.price into v_post_price from public.asset_price_snapshots p where upper(p.asset)=upper(a) and p.observed_at between v_event_at+interval '1435 minutes' and v_event_at+interval '1445 minutes' order by abs(extract(epoch from(p.observed_at-(v_event_at+interval '24 hours')))) limit 1;
   end if;

   v_sd:=case when v_pre_sent is not null and v_post_sent is not null then v_post_sent-v_pre_sent end;
   v_ps:=case when v_pre_price is not null and v_post_price is not null and v_pre_price<>0 then v_post_price/v_pre_price-1 end;
   v_fd:=case when v_pre_flow is not null and v_post_flow is not null then v_post_flow-v_pre_flow end;
   v_score:=least(1,greatest(0,coalesce(abs(v_sd),0)*0.35+coalesce(abs(v_ps),0)*8*0.40+coalesce(abs(v_fd),0)*0.25));

   if v_pre_price is null or v_post_price is null then v_class:='insufficient'; v_reason:='missing_price_endpoint';
   elsif v_score>=0.80 then v_class:='market_moving'; v_reason:='large_post_event_response';
   elsif v_score>=0.55 then v_class:='major_response'; v_reason:='strong_post_event_response';
   elsif v_score>=0.30 then v_class:='notable_response'; v_reason:='measurable_post_event_response';
   elsif v_score>0 then v_class:='weak_response'; v_reason:='small_post_event_response';
   else v_class:='insufficient'; v_reason:='no_measurable_response'; end if;

   insert into public.influential_social_market_observations
    (event_id,asset,horizon,sentiment_before,sentiment_after,sentiment_delta,price_before,price_after,price_return,flow_before,flow_after,flow_delta,evidence_class,evidence_score,evidence_reason)
   values(p_event_id,upper(a),h,v_pre_sent,v_post_sent,v_sd,v_pre_price,v_post_price,v_ps,v_pre_flow,v_post_flow,v_fd,v_class,round(v_score,4),v_reason)
   on conflict(event_id,asset,horizon) do update set
    sentiment_before=excluded.sentiment_before,sentiment_after=excluded.sentiment_after,sentiment_delta=excluded.sentiment_delta,
    price_before=excluded.price_before,price_after=excluded.price_after,price_return=excluded.price_return,
    flow_before=excluded.flow_before,flow_after=excluded.flow_after,flow_delta=excluded.flow_delta,
    evidence_class=excluded.evidence_class,evidence_score=excluded.evidence_score,evidence_reason=excluded.evidence_reason,observed_at=now();
   v_count:=v_count+1;
  end loop;
 end loop;

 update public.influential_social_events set market_link_status=case
  when exists(select 1 from public.influential_social_market_observations o where o.event_id=p_event_id and o.evidence_class='market_moving') then 'linked'
  when exists(select 1 from public.influential_social_market_observations o where o.event_id=p_event_id and o.evidence_class in('major_response','notable_response')) then 'linked'
  when exists(select 1 from public.influential_social_market_observations o where o.event_id=p_event_id and o.price_return is not null) then 'no_response'
  else 'insufficient' end,updated_at=now() where id=p_event_id;

 return jsonb_build_object('event_id',p_event_id,'status','observed','observations',v_count,'research_only',true);
end; $$;

revoke all on function public.observe_influential_social_market_response(uuid) from public,anon,authenticated;
grant execute on function public.observe_influential_social_market_response(uuid) to service_role;