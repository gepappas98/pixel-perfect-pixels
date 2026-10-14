-- Run the isolated Event → Flow paper OPEN scanner every five minutes.
-- The strategy only writes mode='paper' trades; live execution remains disabled.
do $$
begin
  if exists (select 1 from cron.job where jobname='event-flow-paper-open') then
    perform cron.unschedule('event-flow-paper-open');
  end if;
  perform cron.schedule(
    'event-flow-paper-open',
    '*/5 * * * *',
    $job$select net.http_post(
      url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/event-flow-paper-open',
      headers := '{"Content-Type":"application/json","apikey":"sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );$job$
  );
end $$;
