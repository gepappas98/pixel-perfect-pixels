-- Secure the scheduled orchestrator call without exposing a JWT or disabling request authentication.
-- The shared token is generated inside Vault and is never returned by this migration.
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name = 'pipeline_orchestrator_cron_token'
  ) then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'pipeline_orchestrator_cron_token',
      'Private token for pg_cron to call trading-pipeline-orchestrator'
    );
  end if;
end
$$;

create or replace function public.validate_pipeline_cron_token(p_token text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select coalesce(
    p_token is not null
    and length(p_token) >= 32
    and p_token = (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'pipeline_orchestrator_cron_token'
      limit 1
    ),
    false
  );
$$;

revoke all on function public.validate_pipeline_cron_token(text) from public, anon, authenticated;
grant execute on function public.validate_pipeline_cron_token(text) to service_role;
