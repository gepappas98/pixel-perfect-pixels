select cron.schedule('early-entry-variants','*/10 * * * *',$job$
 select net.http_post(
  url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/early-entry-variants',
  headers := '{"Content-Type":"application/json","apikey":"sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx"}'::jsonb,
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
 );
$job$);