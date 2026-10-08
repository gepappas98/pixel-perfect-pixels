-- Shadow-only social event layer.
-- Stores source posts as events; does not affect signals, execution, risk, V1/V2, or trades.

create table if not exists public.influential_social_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.influential_social_sources(id) on delete restrict,
  platform text not null check (platform in ('x','truth_social','other')),
  external_post_id text,
  post_url text,
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  author_handle text,
  text_content text,
  language text,
  crypto_relevance text not null default 'pending' check (crypto_relevance in ('high','medium','low','none','pending')),
  relevance_score numeric check (relevance_score between 0 and 1),
  event_type text not null default 'unknown' check (event_type in ('policy','regulation','market','asset_specific','corporate','product','meme','geopolitical','other','unknown')),
  event_direction smallint check (event_direction in (-1,0,1)),
  severity text not null default 'unclassified' check (severity in ('normal','notable','major','extreme','unclassified')),
  severity_score numeric check (severity_score between 0 and 1),
  affected_assets text[] not null default array[]::text[],
  engagement_replies bigint,
  engagement_reposts bigint,
  engagement_likes bigint,
  engagement_quotes bigint,
  engagement_views bigint,
  source_reach_estimate bigint,
  content_hash text,
  dedupe_key text,
  parent_event_id uuid references public.influential_social_events(id) on delete set null,
  classification_status text not null default 'pending' check (classification_status in ('pending','classified','rejected','review')),
  classification_reason text,
  market_link_status text not null default 'pending' check (market_link_status in ('pending','linked','no_response','insufficient_data')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_post_id)
);

create index if not exists idx_influential_social_events_time
  on public.influential_social_events (published_at desc);
create index if not exists idx_influential_social_events_source_time
  on public.influential_social_events (source_id, published_at desc);
create index if not exists idx_influential_social_events_severity
  on public.influential_social_events (severity, published_at desc);
create unique index if not exists uq_influential_social_events_dedupe
  on public.influential_social_events (dedupe_key) where dedupe_key is not null;

alter table public.influential_social_events enable row level security;
revoke all on public.influential_social_events from anon, authenticated;
grant select on public.influential_social_events to service_role;
