-- Make external ingestion idempotent and safe to rerun.
-- Existing duplicate rows are collapsed before unique indexes are created.

with ranked as (
  select id,
         row_number() over (
           partition by source, tx_hash
           order by created_at desc, id desc
         ) as rn
  from public.whale_alerts
  where tx_hash is not null
)
delete from public.whale_alerts w
using ranked r
where w.id = r.id and r.rn > 1;

with ranked as (
  select id,
         row_number() over (
           partition by symbol, timeframe, created_at
           order by id desc
         ) as rn
  from public.indicator_snapshots
)
delete from public.indicator_snapshots i
using ranked r
where i.id = r.id and r.rn > 1;

with ranked as (
  select id,
         row_number() over (
           partition by market_slug
           order by created_at desc, id desc
         ) as rn
  from public.prediction_snapshots
)
delete from public.prediction_snapshots p
using ranked r
where p.id = r.id and r.rn > 1;

alter table public.composite_signals add column if not exists fingerprint text;

update public.composite_signals
set fingerprint = md5(
  concat_ws('|', symbol, coalesce(whale_alert_id::text, ''),
    coalesce(indicator_snapshot_id::text, ''),
    coalesce(prediction_snapshot_id::text, ''),
    coalesce(council_signal_id::text, ''),
    coalesce(recommendation, ''), coalesce(reasoning, ''))
)
where fingerprint is null;

with ranked as (
  select id,
         row_number() over (
           partition by fingerprint
           order by created_at desc, id desc
         ) as rn
  from public.composite_signals
  where fingerprint is not null
)
delete from public.composite_signals c
using ranked r
where c.id = r.id and r.rn > 1;

create unique index if not exists uq_whale_alerts_source_tx
  on public.whale_alerts (source, tx_hash)
  where tx_hash is not null;

create unique index if not exists uq_indicator_snapshots_source_point
  on public.indicator_snapshots (symbol, timeframe, created_at);

create unique index if not exists uq_prediction_snapshots_market
  on public.prediction_snapshots (market_slug);

create unique index if not exists uq_composite_signals_fingerprint
  on public.composite_signals (fingerprint);

alter table public.composite_signals alter column fingerprint set not null;
