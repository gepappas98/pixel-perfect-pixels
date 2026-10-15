-- Research-only CMC Keyless ranked listings cache; not wired into trade eligibility.
create table if not exists public.cmc_listing_snapshots (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  cmc_id bigint not null,
  name text not null,
  symbol text not null,
  slug text,
  cmc_rank integer,
  price_usd numeric,
  volume_24h_usd numeric,
  market_cap_usd numeric,
  percent_change_1h numeric,
  percent_change_24h numeric,
  percent_change_7d numeric,
  circulating_supply numeric,
  total_supply numeric,
  max_supply numeric,
  tags text[] not null default '{}',
  source text not null default 'cmc-keyless-listings',
  unique (captured_at, cmc_id)
);
create index if not exists cmc_listing_snapshots_captured_at_idx
  on public.cmc_listing_snapshots (captured_at desc);
create index if not exists cmc_listing_snapshots_symbol_captured_at_idx
  on public.cmc_listing_snapshots (symbol, captured_at desc);
create index if not exists cmc_listing_snapshots_rank_idx
  on public.cmc_listing_snapshots (cmc_rank, captured_at desc);
alter table public.cmc_listing_snapshots enable row level security;
drop policy if exists "Public can read CMC listing snapshots" on public.cmc_listing_snapshots;
create policy "Public can read CMC listing snapshots"
  on public.cmc_listing_snapshots for select to anon, authenticated using (true);
revoke insert, update, delete, truncate, references, trigger on public.cmc_listing_snapshots from anon, authenticated;
grant select on public.cmc_listing_snapshots to anon, authenticated;
grant all on public.cmc_listing_snapshots to service_role;
grant usage, select on sequence public.cmc_listing_snapshots_id_seq to service_role;
