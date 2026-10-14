select cron.schedule('market-candle-collector','*/10 * * * *',$job$
 select net.http_post(url := 'https://yckewtpfttvwiptmmrfq.supabase.co/functions/v1/market-candle-collector',
 headers := '{"Content-Type":"application/json","apikey":"sb_publishable_v0BSD7Eg6ze85nuYPRMJ6w_M_lwwXjx"}'::jsonb,
 body := '{}'::jsonb, timeout_milliseconds := 120000);
$job$);
select cron.schedule('market-candle-retention','31 3 * * *',$job$
 delete from public.market_candles where close_time < now() - interval '30 days';
$job$);
