ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS entry_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fees numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_pnl numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_pnl numeric DEFAULT 0;

-- DB-side mirror of TRADING_FEE_RATE (src/lib/fees.ts). Keep both in sync.
CREATE OR REPLACE FUNCTION public.trading_fee_rate()
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$ select 0.0005::numeric $$;

-- Backfill: entry fee for all trades; realized fees + net pnl for closed trades.
UPDATE public.trades SET entry_fee = entry_price * quantity * public.trading_fee_rate();
UPDATE public.trades
SET gross_pnl = coalesce(pnl, 0),
    exit_fee = exit_price * quantity * public.trading_fee_rate(),
    total_fees = entry_fee + exit_price * quantity * public.trading_fee_rate(),
    net_pnl = coalesce(pnl, 0) - (entry_fee + exit_price * quantity * public.trading_fee_rate()),
    pnl = coalesce(pnl, 0) - (entry_fee + exit_price * quantity * public.trading_fee_rate())
WHERE status = 'closed' AND exit_price IS NOT NULL;

CREATE OR REPLACE FUNCTION public.check_and_close_trades()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'net', 'extensions'
AS $function$
declare
  trade record; req_id bigint; resp record; attempts int; prices jsonb;
  price_map jsonb := '{}'::jsonb; p record; cur_price numeric; binance_symbol text;
  hit_stop boolean; hit_target boolean; gross numeric; e_fee numeric; x_fee numeric; net numeric;
  pnl_pct numeric; reason text; closed_count int := 0;
begin
  req_id := net.http_get(url := 'https://api.binance.com/api/v3/ticker/price');
  attempts := 0;
  while attempts < 20 loop
    select * into resp from net._http_response where id = req_id;
    if resp.id is not null and resp.status_code is not null then exit; end if;
    perform pg_sleep(0.2);
    attempts := attempts + 1;
  end loop;
  if resp.status_code is distinct from 200 or resp.content is null then
    delete from net._http_response where id = req_id;
    return 0;
  end if;
  prices := resp.content::jsonb;
  delete from net._http_response where id = req_id;
  for p in select * from jsonb_array_elements(prices) as elem(item) loop
    price_map := price_map || jsonb_build_object(p.item->>'symbol', p.item->>'price');
  end loop;

  for trade in select * from public.trades where status = 'open' and mode = 'paper' loop
    binance_symbol := case trade.symbol when 'MATIC' then 'POL' when 'RNDR' then 'RENDER' else trade.symbol end || 'USDT';
    if not (price_map ? binance_symbol) then continue; end if;
    cur_price := (price_map ->> binance_symbol)::numeric;
    if cur_price is null then continue; end if;
    hit_stop := false; hit_target := false;
    if trade.side = 'buy' then
      if trade.stop_loss is not null and cur_price <= trade.stop_loss then hit_stop := true; end if;
      if trade.take_profit is not null and cur_price >= trade.take_profit then hit_target := true; end if;
    else
      if trade.stop_loss is not null and cur_price >= trade.stop_loss then hit_stop := true; end if;
      if trade.take_profit is not null and cur_price <= trade.take_profit then hit_target := true; end if;
    end if;

    if hit_stop or hit_target then
      reason := case when hit_stop then 'stop_loss' else 'take_profit' end;
      if trade.side = 'buy' then gross := (cur_price - trade.entry_price) * trade.quantity;
      else gross := (trade.entry_price - cur_price) * trade.quantity; end if;
      e_fee := trade.entry_price * trade.quantity * public.trading_fee_rate();
      x_fee := cur_price * trade.quantity * public.trading_fee_rate();
      net := gross - e_fee - x_fee;
      pnl_pct := net / nullif(trade.entry_price * trade.quantity, 0) * 100;

      update public.trades
      set status = 'closed', exit_price = cur_price, pnl = net,
          gross_pnl = gross, net_pnl = net, entry_fee = e_fee, exit_fee = x_fee, total_fees = e_fee + x_fee,
          close_reason = reason, closed_at = now()
      where id = trade.id and status = 'open';

      if found then
        insert into public.trade_alerts (trade_id, symbol, side, event_type, entry_price, exit_price, pnl, pnl_pct)
        values (trade.id, trade.symbol, trade.side, reason, trade.entry_price, cur_price, net, coalesce(pnl_pct, 0));
        closed_count := closed_count + 1;
      end if;
    end if;
  end loop;
  return closed_count;
end;
$function$;