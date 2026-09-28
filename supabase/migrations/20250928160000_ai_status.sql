-- ══════════════════════════════════════════════════════════════
-- AI Status tracking — records Groq health per pipeline run
-- ══════════════════════════════════════════════════════════════

alter table pipeline_runs
  add column if not exists ai_status text
    check (ai_status is null or ai_status in ('ok', 'degraded_fallback', 'failed'));

alter table pipeline_runs
  add column if not exists ai_error text;

alter table pipeline_runs
  add column if not exists ai_lessons_generated integer default 0;

notify pgrst, 'reload schema';
