-- CMC research-only historical features and forward outcome labels.
-- This view never feeds canonical signal scoring or trade execution.
-- Forward returns are labels only; feature columns are computed from the source snapshot and earlier data.
create index if not exists idx_cmc_listing_snapshots_asset_time
  on public.cmc_listing_snapshots (cmc_id, captured_at desc);

create index if not exists idx_cmc_listing_snapshots_time
  on public.cmc_listing_snapshots (captured_at desc);

create or replace view public.cmc_listing_research_observations
with (security_invoker = true)
as
select
  cur.id as snapshot_id,
  cur.cmc_id,
  cur.captured_at as observed_at,
  cur.name,
  cur.symbol,
  cur.cmc_rank,
  prev.cmc_rank as prior_rank,
  case
    when cur.cmc_rank is not null and prev.cmc_rank is not null
      then prev.cmc_rank - cur.cmc_rank
    else null
  end as rank_improvement,
  cur.price_usd,
  cur.volume_24h_usd,
  cur.market_cap_usd,
  case
    when cur.volume_24h_usd is not null and cur.market_cap_usd > 0
      then (cur.volume_24h_usd / cur.market_cap_usd) * 100
    else null
  end as volume_to_market_cap_pct,
  cur.percent_change_1h,
  cur.percent_change_24h,
  cur.percent_change_7d,
  case
    when cur.percent_change_1h > 0 and cur.percent_change_24h > 0 and cur.percent_change_7d > 0 then 'aligned_up'
    when cur.percent_change_1h < 0 and cur.percent_change_24h < 0 and cur.percent_change_7d < 0 then 'aligned_down'
    when cur.percent_change_24h > 0 and cur.percent_change_1h < 0 then 'cooling'
    when cur.percent_change_24h < 0 and cur.percent_change_1h > 0 then 'bounce'
    else 'mixed_or_incomplete'
  end as momentum_alignment,
  case
    when prev.volume_24h_usd > 0 and cur.volume_24h_usd is not null
      then cur.volume_24h_usd / prev.volume_24h_usd
    else null
  end as volume_multiple_vs_prior_snapshot,
  prev.captured_at as prior_observed_at,
  extract(epoch from (cur.captured_at - prev.captured_at)) / 3600.0 as hours_since_prior_snapshot,
  f24.price_usd as forward_price_24h,
  f24.captured_at as forward_observed_at_24h,
  case
    when cur.price_usd > 0 and f24.price_usd > 0
      then ((f24.price_usd / cur.price_usd) - 1) * 100
    else null
  end as forward_return_pct_24h,
  extract(epoch from (f24.captured_at - cur.captured_at)) / 3600.0 as forward_actual_hours_24h,
  f72.price_usd as forward_price_72h,
  f72.captured_at as forward_observed_at_72h,
  case
    when cur.price_usd > 0 and f72.price_usd > 0
      then ((f72.price_usd / cur.price_usd) - 1) * 100
    else null
  end as forward_return_pct_72h,
  extract(epoch from (f72.captured_at - cur.captured_at)) / 3600.0 as forward_actual_hours_72h,
  cur.tags,
  cur.batch_version,
  cur.source
from public.cmc_listing_snapshots cur
left join lateral (
  select p.cmc_rank, p.volume_24h_usd, p.captured_at
  from public.cmc_listing_snapshots p
  where p.cmc_id = cur.cmc_id
    and p.captured_at < cur.captured_at
  order by p.captured_at desc
  limit 1
) prev on true
left join lateral (
  select f.price_usd, f.captured_at
  from public.cmc_listing_snapshots f
  where f.cmc_id = cur.cmc_id
    and f.captured_at >= cur.captured_at + interval '18 hours'
    and f.captured_at <= cur.captured_at + interval '30 hours'
  order by f.captured_at
  limit 1
) f24 on true
left join lateral (
  select f.price_usd, f.captured_at
  from public.cmc_listing_snapshots f
  where f.cmc_id = cur.cmc_id
    and f.captured_at >= cur.captured_at + interval '66 hours'
    and f.captured_at <= cur.captured_at + interval '78 hours'
  order by f.captured_at
  limit 1
) f72 on true;

grant select on public.cmc_listing_research_observations to anon, authenticated;
comment on view public.cmc_listing_research_observations is
  'Research-only CMC listing features and forward-return labels. Never a canonical BUY voter. Forward outcomes use observed snapshots within 18-30h and 66-78h windows; no 1h/4h labels because keyless listing snapshots refresh on a multi-hour cadence.';
