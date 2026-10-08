-- Sync research-only runtime overrides that were applied after the original research migrations.
-- This migration keeps GitHub/main reproducible with the current Supabase research layer.
-- No V1/V2 execution, risk, signal selection, or trade path is changed.

-- 1) Social transmission link: service-role guard and valid insufficient_data status.
create or replace function public.link_influential_social_transmission(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.influential_social_events%rowtype; a text; n record; ss record; f record;
score numeric; cls text; reason text; cnt int:=0; evts int:=0;
begin
if current_user not in ('service_role','postgres') then raise exception 'service_role required'; end if;
select * into e from public.influential_social_events where id=p_event_id;
if not found then raise exception 'event % not found',p_event_id; end if;
if e.classification_status <> 'classified' then return jsonb_build_object('event_id',p_event_id,'status','insufficient','reason','event_not_classified','research_only',true); end if;
foreach a in array coalesce(e.affected_assets,array[]::text[]) loop
n:=null; ss:=null; f:=null;
select * into n from public.asset_news_events x where upper(x.asset)=upper(a) and x.event_at between e.published_at-interval '5 minutes' and e.published_at+interval '30 minutes' order by case when x.event_at>=e.published_at then 0 else 1 end,abs(extract(epoch from(x.event_at-e.published_at))) limit 1;
select * into ss from public.asset_sentiment_snapshots x where upper(x.asset)=upper(a) and x.observed_at between e.published_at-interval '5 minutes' and e.published_at+interval '30 minutes' order by case when x.observed_at>=e.published_at then 0 else 1 end,abs(extract(epoch from(x.observed_at-e.published_at))) limit 1;
select * into f from public.event_flow_transmissions x where upper(x.asset)=upper(a) and x.event_at between e.published_at and e.published_at+interval '4 hours' order by abs(extract(epoch from(x.event_at-e.published_at))) limit 1;
score:=0; cls:='post_only'; reason:='social_event_only';
if n.id is not null then score:=score+0.15; reason:=reason||';news_link'; end if;
if ss.observed_at is not null and abs(coalesce(ss.shock_score,0))>0 then score:=score+0.30; reason:=reason||';sentiment_shock'; end if;
if f.id is not null then score:=score+0.30; reason:=reason||';flow_response'; end if;
if f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null then score:=score+0.15; reason:=reason||';price_response'; end if;
if f.id is not null and (f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null) then cls:='flow_to_price';
elsif f.id is not null and ss.observed_at is not null then cls:='sentiment_to_flow';
elsif ss.observed_at is not null then cls:='sentiment_only'; end if;
if ss.observed_at is not null and f.id is not null and (f.price_return_15m is not null or f.price_return_30m is not null or f.price_return_1h is not null) then cls:='full_chain'; end if;
insert into public.influential_social_transmission_links(event_id,asset,news_event_id,sentiment_snapshot_at,sentiment_shock,news_shock,flow_event_id,flow_shock,price_return_15m,price_return_30m,price_return_1h,price_return_4h,price_return_24h,latency_post_to_sentiment_minutes,latency_sentiment_to_flow_minutes,latency_post_to_flow_minutes,transmission_class,chain_score,chain_reason)
values(p_event_id,upper(a),n.id,ss.observed_at,ss.shock_score,n.shock_score,f.id,f.shock_score,f.price_return_15m,f.price_return_30m,f.price_return_1h,f.price_return_4h,f.price_return_24h,
case when ss.observed_at is not null then extract(epoch from(ss.observed_at-e.published_at))/60 end,
case when ss.observed_at is not null and f.event_at is not null then extract(epoch from(f.event_at-ss.observed_at))/60 end,
case when f.event_at is not null then extract(epoch from(f.event_at-e.published_at))/60 end,cls,least(1,score),reason)
on conflict(event_id,asset) do update set news_event_id=excluded.news_event_id,sentiment_snapshot_at=excluded.sentiment_snapshot_at,sentiment_shock=excluded.sentiment_shock,news_shock=excluded.news_shock,flow_event_id=excluded.flow_event_id,flow_shock=excluded.flow_shock,price_return_15m=excluded.price_return_15m,price_return_30m=excluded.price_return_30m,price_return_1h=excluded.price_return_1h,price_return_4h=excluded.price_return_4h,price_return_24h=excluded.price_return_24h,latency_post_to_sentiment_minutes=excluded.latency_post_to_sentiment_minutes,latency_sentiment_to_flow_minutes=excluded.latency_sentiment_to_flow_minutes,latency_post_to_flow_minutes=excluded.latency_post_to_flow_minutes,transmission_class=excluded.transmission_class,chain_score=excluded.chain_score,chain_reason=excluded.chain_reason,observed_at=now();
cnt:=cnt+1;
end loop;
select count(*) into evts from public.influential_social_transmission_links where event_id=p_event_id;
update public.influential_social_events set market_link_status=case when exists(select 1 from public.influential_social_transmission_links l where l.event_id=p_event_id and l.transmission_class='full_chain') then 'linked' when evts>0 then 'linked' else 'insufficient_data' end,updated_at=now() where id=p_event_id;
return jsonb_build_object('event_id',p_event_id,'status','linked','assets',cnt,'research_only',true);
end; $$;
revoke all on function public.link_influential_social_transmission(uuid) from public,anon,authenticated;
grant execute on function public.link_influential_social_transmission(uuid) to service_role;

-- 2) Social chain validator: service-role guard and deterministic timing/evidence validation.
create or replace function public.validate_influential_social_transmission(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare l record; pre_exists boolean; v_quality text; v_timing text; v_evidence text; v_flags jsonb; v_count int:=0;
begin
if current_user not in ('service_role','postgres') then raise exception 'service_role required'; end if;
delete from public.influential_social_chain_quality where event_id=p_event_id;
for l in select x.* from public.influential_social_transmission_links x where x.event_id=p_event_id loop
v_flags:='{}'::jsonb;
select exists(select 1 from public.asset_sentiment_snapshots s where upper(s.asset)=upper(l.asset) and s.observed_at between (select published_at from public.influential_social_events where id=p_event_id)-interval '10 minutes' and (select published_at from public.influential_social_events where id=p_event_id)) into pre_exists;
if not pre_exists then v_flags:=v_flags||jsonb_build_object('missing_pre_event_sentiment',true); end if;
if l.latency_post_to_sentiment_minutes is not null and l.latency_post_to_sentiment_minutes<0 then v_flags:=v_flags||jsonb_build_object('negative_post_to_sentiment_latency',true); end if;
if l.latency_sentiment_to_flow_minutes is not null and l.latency_sentiment_to_flow_minutes<0 then v_flags:=v_flags||jsonb_build_object('negative_sentiment_to_flow_latency',true); end if;
if l.latency_post_to_flow_minutes is not null and l.latency_post_to_flow_minutes<0 then v_flags:=v_flags||jsonb_build_object('negative_post_to_flow_latency',true); end if;
if l.transmission_class='full_chain' then v_evidence:='full_chain'; elsif l.transmission_class in ('sentiment_only','sentiment_to_flow','flow_to_price','mixed') then v_evidence:='partial_chain'; else v_evidence:='post_only'; end if;
if (v_flags ? 'negative_post_to_sentiment_latency') or (v_flags ? 'negative_sentiment_to_flow_latency') or (v_flags ? 'negative_post_to_flow_latency') then v_timing:='invalid'; v_quality:='invalid';
elsif l.transmission_class='full_chain' and l.latency_post_to_sentiment_minutes is not null and l.latency_sentiment_to_flow_minutes is not null and l.latency_post_to_flow_minutes is not null then v_timing:='ordered'; v_quality:=case when pre_exists then 'valid' else 'ambiguous' end;
elsif l.transmission_class<>'post_only' then v_timing:=case when l.latency_post_to_sentiment_minutes is null and l.latency_post_to_flow_minutes is null then 'missing' else 'ordered' end; v_quality:=case when pre_exists then 'valid' else 'ambiguous' end;
else v_timing:='missing'; v_quality:='insufficient'; end if;
insert into public.influential_social_chain_quality(event_id,asset,link_id,quality_status,timing_status,evidence_status,flags,validated_at)
values(p_event_id,l.asset,l.id,v_quality,v_timing,v_evidence,v_flags,now())
on conflict(event_id,asset) do update set link_id=excluded.link_id,quality_status=excluded.quality_status,timing_status=excluded.timing_status,evidence_status=excluded.evidence_status,flags=excluded.flags,validated_at=now();
v_count:=v_count+1;
end loop;
return jsonb_build_object('event_id',p_event_id,'status','validated','links',v_count,'research_only',true);
end; $$;
revoke all on function public.validate_influential_social_transmission(uuid) from public,anon,authenticated;
grant execute on function public.validate_influential_social_transmission(uuid) to service_role;

-- 3) Lead/lag aggregate: anti-lookahead guard.
create or replace function public.capture_influential_social_lead_lag_stats()
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_rows integer:=0;
begin
delete from public.influential_social_lead_lag_stats;
insert into public.influential_social_lead_lag_stats(captured_at,platform,event_type,event_direction,severity,asset,transmission_class,sample_size,avg_post_to_sentiment_minutes,median_post_to_sentiment_minutes,avg_sentiment_to_flow_minutes,median_sentiment_to_flow_minutes,avg_post_to_flow_minutes,median_post_to_flow_minutes,avg_sentiment_shock,avg_flow_shock,avg_flow_acceleration,avg_price_return_15m,avg_price_return_30m,avg_price_return_1h,avg_price_return_4h,avg_price_return_24h)
select now(),e.platform,e.event_type,e.event_direction,e.severity,l.asset,l.transmission_class,count(*)::integer,avg(l.latency_post_to_sentiment_minutes),percentile_cont(0.5) within group(order by l.latency_post_to_sentiment_minutes),avg(l.latency_sentiment_to_flow_minutes),percentile_cont(0.5) within group(order by l.latency_sentiment_to_flow_minutes),avg(l.latency_post_to_flow_minutes),percentile_cont(0.5) within group(order by l.latency_post_to_flow_minutes),avg(l.sentiment_shock),avg(l.flow_shock),avg(case when l.latency_sentiment_to_flow_minutes is not null and l.latency_sentiment_to_flow_minutes>0 then l.flow_shock/l.latency_sentiment_to_flow_minutes end),avg(l.price_return_15m),avg(l.price_return_30m),avg(l.price_return_1h),avg(l.price_return_4h),avg(l.price_return_24h)
from public.influential_social_transmission_links l
join public.influential_social_events e on e.id=l.event_id
join public.influential_social_chain_quality q on q.event_id=l.event_id and q.asset=l.asset
where e.published_at<=now() and q.quality_status='valid' and q.timing_status='ordered' and q.evidence_status in ('full_chain','partial_chain')
and coalesce(l.latency_post_to_sentiment_minutes,0)>=0 and coalesce(l.latency_sentiment_to_flow_minutes,0)>=0 and coalesce(l.latency_post_to_flow_minutes,0)>=0
group by e.platform,e.event_type,e.event_direction,e.severity,l.asset,l.transmission_class;
select count(*) into v_rows from public.influential_social_lead_lag_stats;
return jsonb_build_object('status','ok','rows',v_rows,'research_only',true,'lookahead_guard','future_events_excluded_nonnegative_latencies_only_valid_ordered_chains','aggregation','platform_event_type_direction_severity_asset_transmission_class');
end; $$;
revoke all on function public.capture_influential_social_lead_lag_stats() from public,anon,authenticated;
grant execute on function public.capture_influential_social_lead_lag_stats() to service_role;

-- 4) Dynamic tracked-asset membership audit: only genuine enter/exit events are persisted.
create or replace function public.refresh_tracked_assets_dynamic(p_candidates jsonb,p_limit integer default 30)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_limit integer:=greatest(4,least(coalesce(p_limit,30),50)); v_selected integer:=0; v_entered integer:=0; v_exited integer:=0;
begin
create temp table _tracked_asset_selection on commit drop as
with candidates as (
select upper(x.asset) asset,upper(x.binance_symbol) binance_symbol,coalesce(x.volume_24h,0) volume_24h,coalesce(x.quote_volume_24h,0) quote_volume_24h,coalesce(x.whale_alerts_7d,0) whale_alerts_7d,coalesce(x.whale_usd_7d,0) whale_usd_7d,coalesce(x.watchlist,false) watchlist
from jsonb_to_recordset(coalesce(p_candidates,'[]'::jsonb)) x(asset text,binance_symbol text,volume_24h numeric,quote_volume_24h numeric,whale_alerts_7d numeric,whale_usd_7d numeric,watchlist boolean)
where x.asset is not null and x.binance_symbol~'^[A-Z0-9]+USDT$'
), scored as (
select c.*,case when c.asset in ('BTC','ETH','SOL','BNB') then 1000000 else 0 end+ln(1+greatest(c.quote_volume_24h,0))*12+ln(1+greatest(c.whale_usd_7d,0))*6+ln(1+greatest(c.whale_alerts_7d,0))*4+case when c.watchlist then 50 else 0 end score
from candidates c
), ranked as (
select *,row_number() over(order by score desc,asset) rn from scored
) select * from ranked where rn<=v_limit;
insert into public.tracked_asset_membership_history(asset,binance_symbol,event_type,occurred_at,previous_enabled,new_enabled,selection_score,selection_reason)
select t.asset,t.binance_symbol,'exit',now(),true,false,t.selection_score,t.selection_reason from public.tracked_assets t where t.enabled and not exists(select 1 from _tracked_asset_selection s where s.asset=t.asset);
get diagnostics v_exited=row_count;
update public.tracked_assets t set enabled=false,updated_at=now() where t.enabled and not exists(select 1 from _tracked_asset_selection s where s.asset=t.asset);
insert into public.tracked_asset_membership_history(asset,binance_symbol,event_type,occurred_at,previous_enabled,new_enabled,selection_score,selection_reason)
select s.asset,s.binance_symbol,case when exists(select 1 from public.tracked_asset_membership_history h where h.asset=s.asset and h.event_type in ('initial','enter')) then 'enter' else 'initial' end,now(),false,true,round(s.score::numeric,6),
jsonb_build_object('method','binance_spot_dynamic_volume_plus_whale_activity_plus_watchlist','rank',s.rn,'quote_volume_24h',round(s.quote_volume_24h::numeric,2),'volume_24h',round(s.volume_24h::numeric,8),'whale_alerts_7d',round(s.whale_alerts_7d::numeric,0),'whale_usd_7d',round(s.whale_usd_7d::numeric,2),'watchlist',s.watchlist)
from _tracked_asset_selection s where not exists(select 1 from public.tracked_assets t where t.asset=s.asset and t.enabled);
get diagnostics v_entered=row_count;
insert into public.tracked_assets(asset,binance_symbol,tier,enabled,selection_score,selection_reason,last_selected_at,updated_at)
select s.asset,s.binance_symbol,case when s.asset in ('BTC','ETH','SOL','BNB') then 'core' else 'tracked' end,true,round(s.score::numeric,6),
jsonb_build_object('method','binance_spot_dynamic_volume_plus_whale_activity_plus_watchlist','rank',s.rn,'quote_volume_24h',round(s.quote_volume_24h::numeric,2),'volume_24h',round(s.volume_24h::numeric,8),'whale_alerts_7d',round(s.whale_alerts_7d::numeric,0),'whale_usd_7d',round(s.whale_usd_7d::numeric,2),'watchlist',s.watchlist),now(),now()
from _tracked_asset_selection s
on conflict(asset) do update set binance_symbol=excluded.binance_symbol,tier=excluded.tier,enabled=true,selection_score=excluded.selection_score,selection_reason=excluded.selection_reason,last_selected_at=now(),updated_at=now();
select count(*) into v_selected from public.tracked_assets where enabled;
return jsonb_build_object('ok',true,'selected',v_selected,'limit',v_limit,'membership_entered',v_entered,'membership_exited',v_exited,'shadow_only',true);
exception when others then raise warning '[TRACKED_ASSETS_DYNAMIC] %',sqlerrm; return jsonb_build_object('ok',false,'error',sqlerrm,'shadow_only',true);
end; $$;
revoke all on function public.refresh_tracked_assets_dynamic(jsonb,integer) from public,anon,authenticated;
grant execute on function public.refresh_tracked_assets_dynamic(jsonb,integer) to service_role;
