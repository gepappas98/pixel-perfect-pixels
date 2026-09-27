-- Prevent overlapping full-pipeline executions.
-- Existing pipeline_runs rows are preserved; only duplicate stale "running"
-- rows are reconciled so the unique partial index can be created safely.

do $$
begin
  if (
    select count(*)
    from public.pipeline_runs
    where status = 'running'
  ) > 1 then
    update public.pipeline_runs
    set
      status = 'error',
      completed_at = coalesce(completed_at, now()),
      error_message = coalesce(
        error_message,
        'Marked error while installing single-run pipeline lock'
      )
    where status = 'running'
      and id not in (
        select id
        from public.pipeline_runs
        where status = 'running'
        order by started_at desc
        limit 1
      );
  end if;
end $$;

create unique index if not exists pipeline_runs_one_active
  on public.pipeline_runs (job_name)
  where status = 'running';
