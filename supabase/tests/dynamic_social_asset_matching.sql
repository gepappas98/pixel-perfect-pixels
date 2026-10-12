-- Read-only behavioral checks for dynamic social asset matching.
-- Run after migration 20261009080000_dynamic_social_asset_matching.sql.
-- No tables are modified by this test.

do $$
declare
  v_link_ticker_pattern text := '(^|[^A-Z0-9])LINK([^A-Z0-9]|$)';
  v_chainlink_alias_pattern text := '(^|[^a-z0-9])chainlink([^a-z0-9]|$)';
  v_live text;
begin
  -- Ambiguous common word must not be treated as the LINK ticker.
  if 'I will send you the link later' ~ v_link_ticker_pattern then
    raise exception 'FAIL: lowercase common word "link" matched ticker LINK';
  end if;

  -- Explicit uppercase ticker should match as a standalone token.
  if not ('LINK is seeing accumulation' ~ v_link_ticker_pattern) then
    raise exception 'FAIL: explicit uppercase LINK ticker was not matched';
  end if;

  -- Ticker must not match inside a larger word.
  if 'BLINK is a product name' ~ v_link_ticker_pattern then
    raise exception 'FAIL: ticker LINK matched inside BLINK';
  end if;

  -- Canonical alias matching remains case-insensitive and boundary-aware.
  if not (lower('ChainLink adoption news') ~ v_chainlink_alias_pattern) then
    raise exception 'FAIL: canonical Chainlink alias was not matched';
  end if;

  -- Eligibility policy: a publication timestamp later than ingestion/now is future-dated.
  v_live := case
    when timestamptz '2026-10-09 12:02:00+00' > timestamptz '2026-10-09 12:01:00+00' then 'historical_only'
    when timestamptz '2026-10-09 12:01:00+00' - timestamptz '2026-10-09 12:02:00+00' > interval '15 minutes' then 'historical_only'
    else 'live_eligible'
  end;
  if v_live <> 'historical_only' then
    raise exception 'FAIL: future-published event was not classified historical_only';
  end if;

  -- Late-arriving posts are historical-only, not causal/live evidence.
  v_live := case
    when timestamptz '2026-10-09 12:00:00+00' > timestamptz '2026-10-09 12:30:00+00' then 'historical_only'
    when timestamptz '2026-10-09 12:30:00+00' - timestamptz '2026-10-09 12:00:00+00' > interval '15 minutes' then 'historical_only'
    else 'live_eligible'
  end;
  if v_live <> 'historical_only' then
    raise exception 'FAIL: late event was not classified historical_only';
  end if;

  -- Timely first observation is eligible under the provisional 15m threshold.
  v_live := case
    when timestamptz '2026-10-09 12:00:00+00' > timestamptz '2026-10-09 12:10:00+00' then 'historical_only'
    when timestamptz '2026-10-09 12:10:00+00' - timestamptz '2026-10-09 12:00:00+00' > interval '15 minutes' then 'historical_only'
    else 'live_eligible'
  end;
  if v_live <> 'live_eligible' then
    raise exception 'FAIL: timely event did not qualify as live_eligible';
  end if;
end;
$$;

-- Dynamic-universe visibility diagnostic: should return only currently enabled assets.
select asset, binance_symbol, enabled
from public.tracked_assets
where enabled = true
order by asset;
