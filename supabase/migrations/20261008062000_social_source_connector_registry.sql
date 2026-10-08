-- Free-first social connector registry.
-- This is configuration only; no connector may bypass authentication, bot checks,
-- access controls, or upstream rate limits.

create table if not exists public.social_source_connectors (
  id uuid primary key default gen_random_uuid(),
  connector_key text not null unique,
  platform text not null check (platform in ('x','truth_social','other')),
  access_mode text not null check (access_mode in ('public_web','official_api','rss','manual','other')),
  cost_model text not null check (cost_model in ('free','pay_per_use','subscription','unknown')),
  login_required boolean not null default false,
  api_key_required boolean not null default false,
  subscription_required boolean not null default false,
  rate_limit_required boolean not null default true,
  rate_limit_requests_per_minute integer,
  rate_limit_requests_per_hour integer,
  cache_ttl_seconds integer not null default 300,
  enabled boolean not null default false,
  dependency_role text not null default 'candidate' check (dependency_role in ('primary','fallback','candidate','disabled')),
  reliability text not null default 'unknown' check (reliability in ('high','medium','low','unknown')),
  access_risk text not null default 'unknown' check (access_risk in ('low','medium','high','unknown')),
  notes text,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_social_source_connectors_eligible
on public.social_source_connectors (platform, cost_model, login_required, subscription_required, enabled);

alter table public.social_source_connectors enable row level security;
revoke all on public.social_source_connectors from anon, authenticated;
grant select on public.social_source_connectors to service_role;

insert into public.social_source_connectors
(connector_key, platform, access_mode, cost_model, login_required, api_key_required, subscription_required,
 rate_limit_required, rate_limit_requests_per_minute, cache_ttl_seconds, enabled, dependency_role,
 reliability, access_risk, notes)
values
('x_public_web','x','public_web','free',false,false,false,true,2,300,false,'candidate','medium','high',
 'Experimental public-web adapter. No X API credentials or paid dependency. Must obey upstream access controls; never bypass login, bot checks, or rate limits.'),
('x_official_api','x','official_api','pay_per_use',true,true,false,true,null,300,false,'disabled','high','low',
 'Excluded from the free-only dependency path.'),
('truth_public_web','truth_social','public_web','free',false,false,false,true,1,300,false,'candidate','low','high',
 'Experimental public-web adapter only when posts are publicly retrievable without authentication.'),
('truth_api','truth_social','official_api','subscription',true,true,true,true,null,300,false,'disabled','high','low',
 'Excluded from the free-only dependency path.')
on conflict (connector_key) do update set
  access_mode = excluded.access_mode,
  cost_model = excluded.cost_model,
  login_required = excluded.login_required,
  api_key_required = excluded.api_key_required,
  subscription_required = excluded.subscription_required,
  rate_limit_required = excluded.rate_limit_required,
  rate_limit_requests_per_minute = excluded.rate_limit_requests_per_minute,
  cache_ttl_seconds = excluded.cache_ttl_seconds,
  dependency_role = excluded.dependency_role,
  reliability = excluded.reliability,
  access_risk = excluded.access_risk,
  notes = excluded.notes,
  verified_at = now(),
  updated_at = now();
