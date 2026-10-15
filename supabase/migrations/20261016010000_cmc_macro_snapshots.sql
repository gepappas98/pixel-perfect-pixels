-- Research-only CoinMarketCap Keyless macro telemetry.
-- No API key, no trade execution effects, and no changes to existing history.
create table if not exists public.cmc_macro_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  btc_dominance numeric,
  eth_dominance numeric,
  total_mcap numeric,
  total_volume_24h numeric,
  fg_value integer check (fg_value is null or fg_value between 0 and 100),
  fg_classification text,
  fg_observed_at timestamptz,
  altcoin_season_value integer check (altcoin_season_value is null or altcoin_season_value between 0 and 100),
  altcoin_season_label text,
  mcap_change_pct numeric,
  dominance_regime text not null default 'unknown'
    check (dominance_regime in ('btc_heavy','alt_rotation','neutral','unknown')),
  market_structure_tag text not null default 'unknown'
    check (market_structure_tag in ('btc_season','alt_season','transition','unknown')),
  source_status jsonb not null default '{}'::jsonb,
  raw_summary jsonb not null default '{}'::jsonb
);

create index if not exists cmc_macro_snapshots_captured_at_idx
  on public.cmc_macro_snapshots (captured_at desc);

alter table public.cmc_macro_snapshots enable row level security;

-- Public market-wide telemetry is safe for read-only dashboard display.
drop policy if exists "Public can read CMC macro snapshots" on public.cmc_macro_snapshots;
create policy "Public can read CMC macro snapshots"
  on public.cmc_macro_snapshots for select to anon, authenticated
  using (true);

revoke insert, update, delete, truncate, references, trigger on public.cmc_macro_snapshots from anon, authenticated;
grant select on public.cmc_macro_snapshots to anon, authenticated;
grant all on public.cmc_macro_snapshots to service_role;
grant usage, select on sequence public.cmc_macro_snapshots_id_seq to service_role;
