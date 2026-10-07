-- Rediscover the shadow research universe every 6 hours.
do $$
begin
  if exists (select 1 from cron.job where jobname='event-flow-lab-discovery') then
    perform cron.unschedule('event-flow-lab-discovery');
  end if;
  perform cron.schedule(
    'event-flow-lab-discovery',
    '17 */6 * * *',
    $job$select net.http_post(
      url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/event-flow-lab',
      headers := '{"Content-Type":"application/json","apikey":"sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx"}'::jsonb,
      body := '{"action":"discover"}'::jsonb,
      timeout_milliseconds := 120000
    );$job$
  );
end $$;