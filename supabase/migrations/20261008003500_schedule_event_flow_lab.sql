-- Shadow-only collector: every 5 minutes, independent of trading execution.
-- Publishable key is intentionally used only as an Edge Function gateway credential.
do $$
begin
  if exists (select 1 from cron.job where jobname='event-flow-lab-collector') then
    perform cron.unschedule('event-flow-lab-collector');
  end if;
  perform cron.schedule(
    'event-flow-lab-collector',
    '*/5 * * * *',
    $job$select net.http_post(
      url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/event-flow-lab',
      headers := '{"Content-Type":"application/json","apikey":"sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx"}'::jsonb,
      body := '{"action":"collect"}'::jsonb,
      timeout_milliseconds := 120000
    );$job$
  );
end $$;