create table if not exists public.influential_social_transmission_links (
 id uuid primary key default gen_random_uuid(),
 event_id uuid not null references public.influential_social_events(id) on delete cascade,
 asset text not null,
 news_event_id uuid references public.asset_news_events(id) on delete set null,
 sentiment_snapshot_at timestamptz,
 sentiment_shock numeric,
 news_shock numeric,
 flow_event_id uuid references public.event_flow_transmissions(id) on delete set null,
 flow_shock numeric,
 price_return_15m numeric, price_return_30m numeric, price_return_1h numeric, price_return_4h numeric, price_return_24h numeric,
 latency_post_to_sentiment_minutes numeric, latency_sentiment_to_flow_minutes numeric, latency_post_to_flow_minutes numeric,
 transmission_class text not null default 'insufficient' check(transmission_class in ('insufficient','post_only','sentiment_only','sentiment_to_flow','flow_to_price','full_chain','mixed')),
 chain_score numeric check(chain_score between 0 and 1), chain_reason text,
 observed_at timestamptz not null default now(), created_at timestamptz not null default now(),
 unique(event_id,asset)
);
create index if not exists idx_social_transmission_event on public.influential_social_transmission_links(event_id);
create index if not exists idx_social_transmission_asset_time on public.influential_social_transmission_links(asset,observed_at desc);
alter table public.influential_social_transmission_links enable row level security;
revoke all on public.influential_social_transmission_links from anon,authenticated;
grant select,insert,update,delete on public.influential_social_transmission_links to service_role;

create or replace function public.link_influential_social_transmission(p_event_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.influential_social_events%rowtype; a text; n record; ss record; f record;
 score numeric; cls text; reason text; cnt int:=0; evts int:=0;
begin
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
  if score<0.30 and n.id is null and ss.observed_at is null and f.id is null then cls:='post_only'; end if;
  insert into public.influential_social_transmission_links(event_id,asset,news_event_id,sentiment_snapshot_at,sentiment_shock,news_shock,flow_event_id,flow_shock,price_return_15m,price_return_30m,price_return_1h,price_return_4h,price_return_24h,latency_post_to_sentiment_minutes,latency_sentiment_to_flow_minutes,latency_post_to_flow_minutes,transmission_class,chain_score,chain_reason)
  values(p_event_id,upper(a),n.id,ss.observed_at,ss.shock_score,n.shock_score,f.id,f.shock_score,f.price_return_15m,f.price_return_30m,f.price_return_1h,f.price_return_4h,f.price_return_24h,
    case when ss.observed_at is not null then extract(epoch from(ss.observed_at-e.published_at))/60 end,
    case when ss.observed_at is not null and f.event_at is not null then extract(epoch from(f.event_at-ss.observed_at))/60 end,
    case when f.event_at is not null then extract(epoch from(f.event_at-e.published_at))/60 end,cls,least(1,score),reason)
  on conflict(event_id,asset) do update set news_event_id=excluded.news_event_id,sentiment_snapshot_at=excluded.sentiment_snapshot_at,sentiment_shock=excluded.sentiment_shock,news_shock=excluded.news_shock,flow_event_id=excluded.flow_event_id,flow_shock=excluded.flow_shock,price_return_15m=excluded.price_return_15m,price_return_30m=excluded.price_return_30m,price_return_1h=excluded.price_return_1h,price_return_4h=excluded.price_return_4h,price_return_24h=excluded.price_return_24h,latency_post_to_sentiment_minutes=excluded.latency_post_to_sentiment_minutes,latency_sentiment_to_flow_minutes=excluded.latency_sentiment_to_flow_minutes,latency_post_to_flow_minutes=excluded.latency_post_to_flow_minutes,transmission_class=excluded.transmission_class,chain_score=excluded.chain_score,chain_reason=excluded.chain_reason,observed_at=now();
  cnt:=cnt+1;
 end loop;
 select count(*) into evts from public.influential_social_transmission_links where event_id=p_event_id;
 update public.influential_social_events set market_link_status=case when exists(select 1 from public.influential_social_transmission_links l where l.event_id=p_event_id and l.transmission_class='full_chain') then 'linked' when evts>0 then 'linked' else 'insufficient' end,updated_at=now() where id=p_event_id;
 return jsonb_build_object('event_id',p_event_id,'status','linked','assets',cnt,'research_only',true);
end; $$;
revoke all on function public.link_influential_social_transmission(uuid) from public,anon,authenticated;
grant execute on function public.link_influential_social_transmission(uuid) to service_role;