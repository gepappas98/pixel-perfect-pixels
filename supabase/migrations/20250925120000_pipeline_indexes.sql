-- Composite indexes για το pipeline με ~95 symbols.
-- Χωρίς αυτά, τα "order by created_at" + ".in(symbol, [...])" queries
-- γίνονται seq scans και το pipeline αργεί.

create index if not exists idx_whale_alerts_symbol_created
  on whale_alerts (symbol, created_at desc);

create index if not exists idx_whale_alerts_created
  on whale_alerts (created_at desc);

create index if not exists idx_indicator_snapshots_symbol_created
  on indicator_snapshots (symbol, created_at desc);

create index if not exists idx_indicator_snapshots_symbol_tf_created
  on indicator_snapshots (symbol, timeframe, created_at desc);

create index if not exists idx_prediction_snapshots_symbol_created
  on prediction_snapshots (related_symbol, created_at desc);

create index if not exists idx_council_signals_symbol_source_created
  on council_signals (symbol, source_created_at desc);

create index if not exists idx_composite_signals_created
  on composite_signals (created_at desc);

create index if not exists idx_composite_signals_symbol_created
  on composite_signals (symbol, created_at desc);

create index if not exists idx_composite_signals_recommendation_created
  on composite_signals (recommendation, created_at desc)
  where recommendation in ('buy', 'sell');

create index if not exists idx_trades_status_symbol
  on trades (status, symbol);

create index if not exists idx_trades_status_closed_at
  on trades (status, closed_at desc);
