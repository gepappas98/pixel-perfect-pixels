-- Whale Flow Intelligence: observational context captured at transition time.
-- Shadow-only: no execution/signal/scoring writes.

create table if not exists public.whale_flow_transition_context (
  id uuid primary key default gen_random_uuid(),
  transition_id uuid not null unique references public.whale_flow_transitions(id) on delete cascade,
  captured_at timestamptz not null,
  lookback_minutes integer not null default 15,
  indicator_context jsonb not null default '{}'::jsonb,
  signal_context jsonb not null default '{}'::jsonb,
  prediction_context jsonb not null default '{}'::jsonb,
  sentiment_context jsonb not null default '{"available":false,"reason":"No historical sentiment snapshots are persisted yet"}'::jsonb,
  news_context jsonb not null default '{"available":false,"reason":"No historical news snapshots are persisted yet"}'::jsonb,
  data_quality text not null default 'partial',
  created_at timestamptz not null default now()
);

create index if not exists idx_wf_transition_context_captured_at
  on public.whale_flow_transition_context (captured_at desc);

alter table public.whale_flow_transition_context enable row level security;

drop policy if exists "whale_flow_transition_context_public_read" on public.whale_flow_transition_context;
create policy "whale_flow_transition_context_public_read"
  on public.whale_flow_transition_context for select to anon, authenticated using (true);

create or replace function public.capture_whale_flow_transition_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_at timestamptz := NEW.detected_at; v_window interval := interval '15 minutes';
begin
  insert into public.whale_flow_transition_context
    (transition_id,captured_at,lookback_minutes,indicator_context,signal_context,prediction_context,data_quality)
  values (
    NEW.id,v_at,15,
    jsonb_build_object(
      'available',true,
      'samples',(select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at),
      'bullish',(select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='bullish'),
      'bearish',(select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='bearish'),
      'neutral',(select count(*) from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at and lower(coalesce(i.signal,''))='neutral')
    ),
    jsonb_build_object(
      'available',true,
      'samples',(select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at),
      'buy',(select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='buy'),
      'sell',(select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='sell'),
      'hold',(select count(*) from public.composite_signals s where s.created_at between v_at-v_window and v_at and lower(coalesce(s.recommendation,''))='hold'),
      'avg_confidence',(select round(avg(s.confidence)::numeric,4) from public.composite_signals s where s.created_at between v_at-v_window and v_at)
    ),
    jsonb_build_object(
      'available',true,
      'samples',(select count(*) from public.prediction_snapshots p where p.created_at between v_at-v_window and v_at)
    ),
    case when exists(select 1 from public.indicator_snapshots i where i.created_at between v_at-v_window and v_at)
       or exists(select 1 from public.composite_signals s where s.created_at between v_at-v_window and v_at)
      then 'partial' else 'whale_only' end
  ) on conflict (transition_id) do nothing;
  return NEW;
exception when others then
  raise warning '[WHALE_FLOW_CONTEXT] capture failed for transition %: %',NEW.id,sqlerrm;
  return NEW;
end;
$$;

drop trigger if exists trg_capture_whale_flow_transition_context on public.whale_flow_transitions;
create trigger trg_capture_whale_flow_transition_context
after insert on public.whale_flow_transitions for each row
execute function public.capture_whale_flow_transition_context();

revoke execute on function public.capture_whale_flow_transition_context() from public,anon,authenticated;
grant execute on function public.capture_whale_flow_transition_context() to service_role;

insert into public.whale_flow_transition_context
  (transition_id,captured_at,lookback_minutes,indicator_context,signal_context,prediction_context,data_quality)
select t.id,t.detected_at,15,
  jsonb_build_object(
    'available',true,
    'samples',(select count(*) from public.indicator_snapshots i where i.created_at between t.detected_at-interval '15 minutes' and t.detected_at),
    'bullish',(select count(*) from public.indicator_snapshots i where i.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(i.signal,''))='bullish'),
    'bearish',(select count(*) from public.indicator_snapshots i where i.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(i.signal,''))='bearish'),
    'neutral',(select count(*) from public.indicator_snapshots i where i.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(i.signal,''))='neutral')
  ),
  jsonb_build_object(
    'available',true,
    'samples',(select count(*) from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at),
    'buy',(select count(*) from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(s.recommendation,''))='buy'),
    'sell',(select count(*) from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(s.recommendation,''))='sell'),
    'hold',(select count(*) from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at and lower(coalesce(s.recommendation,''))='hold'),
    'avg_confidence',(select round(avg(s.confidence)::numeric,4) from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at)
  ),
  jsonb_build_object('available',true,'samples',(select count(*) from public.prediction_snapshots p where p.created_at between t.detected_at-interval '15 minutes' and t.detected_at)),
  case when exists(select 1 from public.indicator_snapshots i where i.created_at between t.detected_at-interval '15 minutes' and t.detected_at)
       or exists(select 1 from public.composite_signals s where s.created_at between t.detected_at-interval '15 minutes' and t.detected_at)
       then 'partial' else 'whale_only' end
from public.whale_flow_transitions t
on conflict (transition_id) do nothing;

notify pgrst,'reload schema';