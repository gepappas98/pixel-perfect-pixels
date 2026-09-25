create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('success', 'failure')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  result jsonb
);

create index if not exists idx_pipeline_runs_completed_at
  on public.pipeline_runs (completed_at desc);

grant select on public.pipeline_runs to anon, authenticated;
grant all on public.pipeline_runs to service_role;
alter table public.pipeline_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'pipeline_runs'
      and policyname = 'public read pipeline_runs'
  ) then
    create policy "public read pipeline_runs"
      on public.pipeline_runs
      for select to anon, authenticated using (true);
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'pipeline_runs'
     ) then
    alter publication supabase_realtime add table public.pipeline_runs;
  end if;
end
$$;
