-- ══════════════════════════════════════════════════════════════
-- TRADES DEDUP + PORTFOLIO PnL
-- Διορθώνει τα διπλά ανοιχτά trades (π.χ. δύο LINK, δύο ETH)
-- και προσθέτει view για συνολικό PnL του portfolio.
-- ══════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
-- ΜΕΡΟΣ 1: Καθαρισμός υπαρχόντων διπλών ανοιχτών θέσεων
-- Κρατάει το ΠΑΛΙΟΤΕΡΟ ανοιχτό trade ανά symbol, κλείνει τα υπόλοιπα.
-- ──────────────────────────────────────────────────────────────

-- Πρώτα, ενημέρωσε τα duplicates ως closed με ειδικό λόγο.
with ranked as (
  select
    id,
    symbol,
    row_number() over (
      partition by symbol
      order by created_at asc
    ) as rn
  from trades
  where status = 'open'
)
update trades
set
  status = 'closed',
  close_reason = 'duplicate_cleanup',
  closed_at = now(),
  pnl = 0,
  exit_price = entry_price
where id in (
  select id from ranked where rn > 1
);

-- ──────────────────────────────────────────────────────────────
-- ΜΕΡΟΣ 2: Unique partial index
-- Επιτρέπει μόνο ΕΝΑ ανοιχτό trade ανά symbol.
-- Αποτρέπει race conditions σε ταυτόχρονα pipeline runs.
-- ──────────────────────────────────────────────────────────────

drop index if exists trades_one_open_per_symbol;

create unique index trades_one_open_per_symbol
  on trades (symbol)
  where status = 'open';

-- ──────────────────────────────────────────────────────────────
-- ΜΕΡΟΣ 3: View για συνολικό portfolio PnL
-- Χρήσιμο για dashboard: realized + unrealized + counts.
-- ──────────────────────────────────────────────────────────────

create or replace view portfolio_summary as
with open_stats as (
  select
    count(*) as open_count,
    coalesce(sum(entry_price * quantity), 0) as open_notional,
    coalesce(sum(pnl), 0) as open_pnl_recorded
  from trades
  where status = 'open'
),
closed_stats as (
  select
    count(*) as closed_count,
    coalesce(sum(pnl), 0) as realized_pnl,
    count(*) filter (where pnl > 0) as win_count,
    count(*) filter (where pnl < 0) as loss_count,
    coalesce(sum(pnl) filter (where pnl > 0), 0) as gross_profit,
    coalesce(abs(sum(pnl) filter (where pnl < 0)), 0) as gross_loss,
    coalesce(avg(pnl) filter (where pnl > 0), 0) as avg_win,
    coalesce(avg(pnl) filter (where pnl < 0), 0) as avg_loss
  from trades
  where status = 'closed'
    and close_reason in ('stop_loss', 'take_profit')
),
recent as (
  select
    count(*) as last_24h_closed,
    coalesce(sum(pnl), 0) as last_24h_pnl
  from trades
  where status = 'closed'
    and closed_at >= now() - interval '24 hours'
)
select
  -- Open positions
  os.open_count,
  os.open_notional,
  -- Realized (closed) positions
  cs.closed_count,
  cs.realized_pnl,
  -- Win rate
  case
    when cs.closed_count > 0
      then round((cs.win_count::numeric / cs.closed_count) * 100, 2)
    else 0
  end as win_rate_pct,
  cs.win_count,
  cs.loss_count,
  cs.gross_profit,
  cs.gross_loss,
  -- Profit factor
  case
    when cs.gross_loss > 0
      then round((cs.gross_profit / cs.gross_loss)::numeric, 2)
    else null
  end as profit_factor,
  -- Average win/loss
  round(cs.avg_win::numeric, 2) as avg_win_usd,
  round(cs.avg_loss::numeric, 2) as avg_loss_usd,
  -- Last 24h activity
  r.last_24h_closed,
  r.last_24h_pnl
from open_stats os, closed_stats cs, recent r;

-- Δώσε δικαιώματα ανάγνωσης στο anon role.
grant select on portfolio_summary to anon, authenticated;

-- ──────────────────────────────────────────────────────────────
-- ΜΕΡΟΣ 4: Index για γρήγορα queries
-- ──────────────────────────────────────────────────────────────

create index if not exists idx_trades_status_close_reason
  on trades (status, close_reason);

create index if not exists idx_trades_closed_at
  on trades (closed_at desc)
  where status = 'closed';

-- ══════════════════════════════════════════════════════════════
-- ΤΕΛΟΣ
-- ══════════════════════════════════════════════════════════════
