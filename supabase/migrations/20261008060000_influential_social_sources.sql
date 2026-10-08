-- Influential social-source registry for the shadow event-study lab.
-- Research-only metadata. No execution, signal-selection, risk, or trade dependency.

create table if not exists public.influential_social_sources (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  handle text,
  platform text not null check (platform in ('x','truth_social','other')),
  source_type text not null check (source_type in ('crypto_native','corporate','political','investor','researcher','other')),
  active boolean not null default true,
  research_priority smallint not null default 50 check (research_priority between 0 and 100),
  crypto_relevance text not null default 'candidate' check (crypto_relevance in ('high','medium','candidate')),
  evidence_level text not null default 'unverified' check (evidence_level in ('strong','moderate','weak','unverified')),
  affected_assets text[] not null default array[]::text[],
  historical_evidence text,
  evidence_urls text[] not null default array[]::text[],
  notes text,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, handle)
);

create index if not exists idx_influential_social_sources_active_priority
  on public.influential_social_sources (active, research_priority desc);

alter table public.influential_social_sources enable row level security;

revoke all on public.influential_social_sources from anon, authenticated;
grant select on public.influential_social_sources to service_role;

-- Initial evidence-backed research universe.
insert into public.influential_social_sources
(display_name, handle, platform, source_type, research_priority, crypto_relevance, evidence_level, affected_assets, historical_evidence, evidence_urls, notes)
values
('Elon Musk','elonmusk','x','corporate',100,'high','strong',
 array['BTC','DOGE'],
 'Peer-reviewed/event-study evidence documents significant short-horizon cryptocurrency return and volume effects around 47 crypto-related Musk posts.',
 array['https://www.sciencedirect.com/science/article/pii/S0040162522006333','https://link.springer.com/article/10.1007/s10614-021-10230-6'],
 'Highest-priority initial source.'),
('Donald Trump','realDonaldTrump','x','political',100,'high','strong',
 array['BTC','CRYPTO','TRUMP'],
 'Peer-reviewed analysis of 13,918 Trump tweets found predictive relationships with Bitcoin returns, volume and volatility; newer work studies high-impact political crypto communications.',
 array['https://www.sciencedirect.com/science/article/abs/pii/S2214635021000903','https://doi.org/10.1016/j.frl.2026.110381'],
 'Truth Social should be tracked as a separate platform/source stream.'),
('Michael Saylor','saylor','x','investor',95,'high','moderate',
 array['BTC'],
 'Historical market analysis reported measurable Bitcoin price, sentiment and tweet-volume changes after Saylor Bitcoin posts.',
 array['https://www.etoro.com/wp-content/uploads/tie_reports/TheTie-Q2_Report_2021.pdf'],
 'External evidence is a prior, not causal proof.'),
('Changpeng Zhao','cz_binance','x','crypto_native',90,'high','moderate',
 array['BTC','BNB'],
 'Public market analysis documented repeated short-term Bitcoin moves following CZ posts, while explicitly warning that correlation is not causation.',
 array['https://blockworks.com/news/cz-tweets-gm-bitcoin-goes-up'],
 'Falsifiable event-level candidate.'),
('Brian Armstrong','brian_armstrong','x','corporate',80,'high','weak',
 array['BTC','ETH','BASE'],
 'Public reporting documents market reactions to Armstrong-related posts/profile changes, but direct causal evidence is weaker than for Musk or Trump.',
 array['https://beincrypto.com/armstrong-defends-x-brian-meme-coin-crash/'],
 'Keep lower priority until our own event sample establishes impact.'),
('Vitalik Buterin','VitalikButerin','x','crypto_native',75,'high','weak',
 array['ETH'],
 'Crypto-native influence is well established, but direct causal price-impact evidence was not established strongly enough in the initial discovery pass.',
 array['https://www.cryptoinfluencers.net/'],
 'Hypothesis source; do not promote without event-level evidence.')
on conflict (platform, handle) do update set
  display_name = excluded.display_name,
  source_type = excluded.source_type,
  research_priority = excluded.research_priority,
  crypto_relevance = excluded.crypto_relevance,
  evidence_level = excluded.evidence_level,
  affected_assets = excluded.affected_assets,
  historical_evidence = excluded.historical_evidence,
  evidence_urls = excluded.evidence_urls,
  notes = excluded.notes,
  last_verified_at = now(),
  updated_at = now();
