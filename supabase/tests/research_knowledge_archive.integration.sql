\set ON_ERROR_STOP on

-- Minimal isolated PostgreSQL fixture for the additive archive migration.
-- All objects/data live in the ephemeral CI database, never in canonical Supabase.

create table public.trades (
  id uuid primary key, composite_signal_id uuid, symbol text, side text, mode text, status text,
  created_at timestamptz, closed_at timestamptz, close_reason text, pnl numeric, net_pnl numeric,
  total_fees numeric, entry_price numeric, regime_label text, source_tags text[], market_session text,
  entry_source text
);
create table public.composite_signals (
  id uuid primary key, symbol text, created_at timestamptz, confidence numeric, recommendation text,
  regime_label text, source_tags text[]
);
create table public.strategy_variant_signals (
  id uuid primary key, strategy_name text, symbol text, source_fingerprint text, created_at timestamptz,
  resolved_at timestamptz, outcome text, pnl_pct numeric, regime_label text, confidence numeric,
  recommendation text, score numeric, source_tags text[], production_regime_label text,
  market_regime_score numeric, asset_trend_regime text, asset_volatility_regime text
);
create table public.asset_price_snapshots (
  id uuid primary key, asset text, observed_at timestamptz, price numeric, source text, created_at timestamptz
);
create table public.asset_flow_snapshots (
  id uuid primary key, asset text, bucket_at timestamptz, sample_size integer, buy_usd numeric,
  sell_usd numeric, total_usd numeric, flow_score numeric, dominant_state text, source text, created_at timestamptz
);
create table public.asset_sentiment_snapshots (
  id uuid primary key, asset text, observed_at timestamptz, source text, mention_count integer,
  unique_items integer, bullish_count integer, bearish_count integer, neutral_count integer,
  sentiment_score numeric, mention_velocity numeric, sentiment_velocity numeric, shock_score numeric, created_at timestamptz
);
create table public.asset_news_events (
  id uuid primary key, asset text, event_at timestamptz, source text, title text, sentiment_score numeric,
  sentiment_label text, event_type text, relevance numeric, novelty numeric, shock_score numeric,
  fingerprint text, created_at timestamptz
);
create table public.event_flow_transmissions (
  id uuid primary key, asset text, source_kind text, source_id uuid, event_at timestamptz,
  shock_score numeric, event_sentiment numeric, flow_delta_15m numeric, flow_delta_30m numeric,
  flow_delta_60m numeric, price_return_15m numeric, price_return_1h numeric, price_return_4h numeric,
  price_return_24h numeric, transmission_class text, data_quality text, created_at timestamptz, updated_at timestamptz
);
create table public.whale_flow_shock_followups (
  id uuid primary key, transition_id uuid, shock_at timestamptz, shock_delta_pp numeric, shock_speed text,
  flow_15m numeric, flow_30m numeric, flow_60m numeric, flow_4h numeric, flow_24h numeric,
  delta_15m_pp numeric, delta_30m_pp numeric, delta_60m_pp numeric, delta_4h_pp numeric, delta_24h_pp numeric,
  velocity_0_15_pph numeric, velocity_15_30_pph numeric, acceleration_pph2 numeric, peak_abs_delta_4h_pp numeric,
  time_to_peak_minutes integer, btc_return_15m numeric, btc_return_30m numeric, btc_return_1h numeric,
  btc_return_4h numeric, btc_return_24h numeric, flow_response text, price_response text, curvature text,
  data_quality text, created_at timestamptz, updated_at timestamptz
);
create table public.whale_flow_transition_context (
  id uuid primary key, transition_id uuid, captured_at timestamptz, lookback_minutes integer,
  indicator_context jsonb, signal_context jsonb, prediction_context jsonb, sentiment_context jsonb,
  news_context jsonb, data_quality text, created_at timestamptz
);
create table public.whale_flow_transitions (
  id uuid primary key, from_snapshot_id uuid, to_snapshot_id uuid, previous_state text, new_state text,
  detected_at timestamptz, delta_score numeric, delta_pp numeric, velocity_pp_per_hour numeric,
  transition_speed text, classification text, confirmation_at timestamptz, persistence_snapshots integer,
  persistence_minutes integer, created_at timestamptz
);
create table public.whale_flow_snapshots (
  id uuid primary key, bucket_at timestamptz, sample_size integer, accumulation_usd numeric,
  distribution_usd numeric, total_usd numeric, accumulation_pct numeric, neutral_pct numeric,
  distribution_pct numeric, flow_score numeric, dominant_state text, source text, created_at timestamptz
);

\i supabase/migrations/20261020160000_research_knowledge_archive.sql
\i supabase/migrations/20261020173000_research_archive_delete_guard.sql
\i supabase/migrations/20261020180000_research_knowledge_sync_batch_fix.sql
\i supabase/migrations/20261020182000_research_archive_capture_gate.sql

insert into public.composite_signals(id,symbol,created_at,confidence,recommendation,regime_label,source_tags)
values ('10000000-0000-0000-0000-000000000001','BTC',now()-interval '2 hours',0.8,'BUY','bullish',array['mtf','whale']);

insert into public.trades(id,composite_signal_id,symbol,side,mode,status,created_at,closed_at,close_reason,pnl,net_pnl,total_fees,entry_price,regime_label,source_tags,market_session,entry_source)
values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','BTC','buy','paper','closed',
  now()-interval '1 hour',now()-interval '30 minutes','take_profit',42,40,2,100,'bullish',array['mtf','whale'],'US','early-entry');

insert into public.strategy_variant_signals(id,strategy_name,symbol,source_fingerprint,created_at,resolved_at,outcome,pnl_pct,regime_label,confidence,recommendation,score,source_tags,production_regime_label,market_regime_score,asset_trend_regime,asset_volatility_regime)
values
 ('30000000-0000-0000-0000-000000000001','accumulation','BTC','v3|accumulation|BTC|test-open',now()-interval '2 hours',null,'open',null,'neutral',0.7,'BUY',1.8,array['whale'],'neutral',0.2,'up','normal'),
 ('30000000-0000-0000-0000-000000000002','whale-focused','ETH','v3|whale-focused|ETH|test-resolved',now()-interval '4 hours',now()-interval '1 hour','win',4,'bullish',0.8,'BUY',2.1,array['whale','mtf'],'bullish',0.6,'up','normal');

insert into public.asset_price_snapshots values ('40000000-0000-0000-0000-000000000001','BTC',now()-interval '200 hours',100,'binance',now()-interval '199 hours');
insert into public.asset_flow_snapshots values ('40000000-0000-0000-0000-000000000002','BTC',now()-interval '200 hours',4,100,40,140,0.3,'accumulation','whale',now()-interval '199 hours');
insert into public.asset_sentiment_snapshots values ('40000000-0000-0000-0000-000000000003','BTC',now()-interval '200 hours','rss',5,4,3,1,1,0.4,0.2,0.1,0.6,now()-interval '199 hours');
insert into public.asset_news_events values ('40000000-0000-0000-0000-000000000004','BTC',now()-interval '200 hours','feed','BTC test headline',0.5,'bullish','listing',0.9,1,0.6,'news-fingerprint-test',now()-interval '199 hours');
insert into public.event_flow_transmissions values ('40000000-0000-0000-0000-000000000005','BTC','news','40000000-0000-0000-0000-000000000004',now()-interval '200 hours',0.6,0.5,0.2,0.3,0.4,0.1,0.2,0.3,0.4,'flow_followed','complete',now()-interval '199 hours',now()-interval '198 hours');
insert into public.whale_flow_shock_followups values ('40000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000001',now()-interval '200 hours',2,'fast',0.1,0.2,0.3,0.4,0.5,0.1,0.2,0.3,0.4,0.5,1,2,3,4,30,0.1,0.2,0.3,0.4,0.5,'followed','up','curving','complete',now()-interval '199 hours',now()-interval '198 hours');
insert into public.whale_flow_transition_context values ('40000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000001',now()-interval '200 hours',15,'{"samples":3}'::jsonb,'{"samples":4,"buy":2,"sell":1}'::jsonb,'{"samples":1}'::jsonb,'{"samples":2,"avg_score":0.4,"bullish":1}'::jsonb,'{"samples":1,"avg_score":0.5,"bullish":1}'::jsonb,'partial',now()-interval '199 hours');
insert into public.whale_flow_transitions values ('50000000-0000-0000-0000-000000000001',null,null,'neutral','accumulation',now()-interval '200 hours',0.3,4,2,'fast','confirmed',now()-interval '199 hours',3,30,now()-interval '199 hours');
insert into public.whale_flow_snapshots values ('50000000-0000-0000-0000-000000000002',now()-interval '200 hours',5,100,20,120,60,20,20,0.5,'accumulation','whale',now()-interval '199 hours');

select public.refresh_research_knowledge_cases(72);
do $$
begin
  if not exists (select 1 from public.research_cases where source_table='trades' and source_id='20000000-0000-0000-0000-000000000001' and cardinality(evidence_ids) >= 2) then
    raise exception 'trade case or linked composite-signal evidence was not materialized';
  end if;
  if not exists (select 1 from public.research_cases where source_table='strategy_variant_signals' and source_id='30000000-0000-0000-0000-000000000001' and outcome='open' and maturity_at is null) then
    raise exception 'open V3 variant must remain unmatured';
  end if;
  if not exists (select 1 from public.research_cases where source_table='strategy_variant_signals' and source_id='30000000-0000-0000-0000-000000000002' and maturity_at=resolved_at) then
    raise exception 'resolved V3 variant must use explicit resolver timestamp as maturity';
  end if;
end $$;

select public.cleanup_research_data(72,168,true);

-- Default production control is paused: even the scheduled non-dry-run path must not write or delete.
select public.cleanup_research_data(72,168,false);
do $$
begin
  if not exists (select 1 from public.asset_price_snapshots where id='40000000-0000-0000-0000-000000000001') then
    raise exception 'source row deleted while archive gate was disabled';
  end if;
  if (public.get_research_archive_status(72,168)->>'archive_enabled')::boolean then
    raise exception 'archive gate should default to disabled';
  end if;
end $$;

-- Enable capture only inside this disposable test database to verify fail-closed behavior.
update public.research_archive_control set allow_archive=true where id=1;
create or replace function public.test_research_archive_fail() returns trigger
language plpgsql as $fail$
begin
  if new.source_table='asset_price_snapshots' then raise exception 'forced archive failure'; end if;
  return new;
end;
$fail$;
create trigger test_research_archive_fail before insert on public.research_evidence
for each row execute function public.test_research_archive_fail();

do $$
declare v_failed boolean := false;
begin
  begin
    perform public.cleanup_research_data(72,168,false);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'expected archive failure did not abort cleanup'; end if;
  if not exists (select 1 from public.asset_price_snapshots where id='40000000-0000-0000-0000-000000000001') then
    raise exception 'source row was deleted despite archive failure';
  end if;
end $$;

drop trigger test_research_archive_fail on public.research_evidence;
drop function public.test_research_archive_fail();

-- With capture enabled but deletion still locked, evidence is stored and original rows remain.
select public.cleanup_research_data(72,168,false);
do $$
begin
  if not exists (select 1 from public.asset_price_snapshots where id='40000000-0000-0000-0000-000000000001') then
    raise exception 'source row deleted while delete gate was disabled';
  end if;
  if (public.get_research_archive_status(72,168)->>'missing_sources')::integer <> 0 then
    raise exception 'archive status should report zero missing sources after capture';
  end if;
  if (public.get_research_archive_status(72,168)->>'delete_enabled')::boolean then
    raise exception 'source deletion should remain locked by default';
  end if;
end $$;

-- The delete path is exercised only after both flags are explicitly enabled in this disposable database.
update public.research_archive_control set allow_source_delete=true where id=1;
select public.cleanup_research_data(72,168,false);
do $$
begin
  if exists (select 1 from public.asset_price_snapshots where id='40000000-0000-0000-0000-000000000001')
     or exists (select 1 from public.asset_flow_snapshots where id='40000000-0000-0000-0000-000000000002')
     or exists (select 1 from public.asset_sentiment_snapshots where id='40000000-0000-0000-0000-000000000003')
     or exists (select 1 from public.asset_news_events where id='40000000-0000-0000-0000-000000000004')
     or exists (select 1 from public.event_flow_transmissions where id='40000000-0000-0000-0000-000000000005')
     or exists (select 1 from public.whale_flow_shock_followups where id='40000000-0000-0000-0000-000000000006')
     or exists (select 1 from public.whale_flow_transition_context where id='40000000-0000-0000-0000-000000000007')
     or exists (select 1 from public.whale_flow_transitions where id='50000000-0000-0000-0000-000000000001')
     or exists (select 1 from public.whale_flow_snapshots where id='50000000-0000-0000-0000-000000000002') then
    raise exception 'eligible source rows remain after both explicit archive and delete approvals';
  end if;
  if (select count(*) from public.research_evidence where source_table in (
    'asset_price_snapshots','asset_flow_snapshots','asset_sentiment_snapshots','asset_news_events',
    'event_flow_transmissions','whale_flow_shock_followups','whale_flow_transition_context',
    'whale_flow_transitions','whale_flow_snapshots'
  )) < 9 then
    raise exception 'archived evidence records missing after cleanup';
  end if;
  if (public.get_research_archive_status(72,168)->>'missing_sources')::integer <> 0 then
    raise exception 'archive status should report zero missing sources after cleanup';
  end if;
end $$;

select 'research knowledge archive integration: PASS' as result;
