"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Briefcase,
  TrendingUp,
  TrendingDown,
  Target,
  Activity,
  Loader2,
} from "lucide-react";

/* ───────────── Types ───────────── */

interface PortfolioSummary {
  open_count: number;
  open_notional: number;
  closed_count: number;
  realized_pnl: number;
  win_rate_pct: number;
  win_count: number;
  loss_count: number;
  gross_profit: number;
  gross_loss: number;
  profit_factor: number | null;
  avg_win_usd: number;
  avg_loss_usd: number;
  last_24h_closed: number;
  last_24h_pnl: number;
}

/* ───────────── Formatters ───────────── */

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const moneyCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function fmtSigned(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${money.format(Math.abs(value))}`;
}

/* ───────────── Component ───────────── */

export function PortfolioPanel() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery<PortfolioSummary | null>({
    queryKey: ["portfolio-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_portfolio_summary");
      if (error) throw error;
      if (!data || (Array.isArray(data) && data.length === 0)) return null;
      return (Array.isArray(data) ? data[0] : data) as PortfolioSummary;
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
  });

  if (isLoading) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading portfolio summary…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 text-destructive">
          <Activity className="h-4 w-4" />
          <h2 className="panel-title text-destructive">Portfolio Summary</h2>
        </div>
        <p className="mt-3 text-xs text-destructive/80">
          Failed to load portfolio stats.
        </p>
        <p className="mt-2 break-words font-mono text-[10px] text-destructive/60">
          {(error as Error).message}
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel">
        <h2 className="panel-title">Portfolio Summary</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          No portfolio data yet — run the pipeline to open positions.
        </p>
      </section>
    );
  }

  const realizedPositive = data.realized_pnl >= 0;
  const last24Positive = data.last_24h_pnl >= 0;
  const pf = data.profit_factor;
  const pfLabel = pf == null ? "—" : pf.toFixed(2);

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-accent" />
            Portfolio Summary
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Realized · open · 24h performance
          </p>
        </div>
        {dataUpdatedAt > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Top stats: 3 columns */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {/* Realized PnL */}
        <div className="rounded-md border border-border/70 bg-background/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Realized PnL
            </span>
            {realizedPositive ? (
              <TrendingUp className="h-3.5 w-3.5 text-bull" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bear" />
            )}
          </div>
          <p
            className={`mt-1 font-mono text-lg font-semibold ${
              realizedPositive ? "text-bull" : "text-bear"
            }`}
          >
            {fmtSigned(data.realized_pnl)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {data.closed_count} closed
          </p>
        </div>

        {/* Open positions */}
        <div className="rounded-md border border-border/70 bg-background/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Open Positions
            </span>
            <Briefcase className="h-3.5 w-3.5 text-accent" />
          </div>
          <p className="mt-1 font-mono text-lg font-semibold text-foreground">
            {data.open_count}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {moneyCompact.format(data.open_notional)} notional
          </p>
        </div>

        {/* Last 24h */}
        <div className="rounded-md border border-border/70 bg-background/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Last 24h
            </span>
            {last24Positive ? (
              <TrendingUp className="h-3.5 w-3.5 text-bull" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5 text-bear" />
            )}
          </div>
          <p
            className={`mt-1 font-mono text-lg font-semibold ${
              data.last_24h_closed === 0
                ? "text-muted-foreground"
                : last24Positive
                  ? "text-bull"
                  : "text-bear"
            }`}
          >
            {data.last_24h_closed === 0 ? "—" : fmtSigned(data.last_24h_pnl)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {data.last_24h_closed} closed
          </p>
        </div>
      </div>

      {/* Win rate bar */}
      <div className="mt-3 rounded-md border border-border/70 bg-background/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Target className="h-3 w-3" />
            Win Rate
          </span>
          <span className="font-mono text-sm font-semibold text-foreground">
            {data.win_rate_pct.toFixed(1)}%
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all ${
              data.win_rate_pct >= 50 ? "bg-bull" : "bg-warn"
            }`}
            style={{ width: `${Math.min(100, Math.max(0, data.win_rate_pct))}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="text-bull">
            {data.win_count} wins · {moneyCompact.format(data.gross_profit)}
          </span>
          <span className="text-bear">
            {data.loss_count} losses · {moneyCompact.format(data.gross_loss)}
          </span>
        </div>
      </div>

      {/* Advanced stats grid: 2 columns */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Profit Factor
          </span>
          <p
            className={`mt-0.5 font-mono text-base font-semibold ${
              pf == null
                ? "text-muted-foreground"
                : pf >= 1.5
                  ? "text-bull"
                  : pf >= 1
                    ? "text-foreground"
                    : "text-bear"
            }`}
          >
            {pfLabel}
          </p>
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            {pf == null
              ? "no data"
              : pf >= 1.5
                ? "excellent"
                : pf >= 1
                  ? "profitable"
                  : "unprofitable"}
          </p>
        </div>

        <div className="rounded-md border border-border/70 bg-background/30 p-2.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Avg Win / Loss
          </span>
          <p className="mt-0.5 font-mono text-base font-semibold">
            <span className="text-bull">{moneyCompact.format(data.avg_win_usd)}</span>
            <span className="text-muted-foreground mx-1">/</span>
            <span className="text-bear">
              {data.avg_loss_usd === 0 ? "—" : moneyCompact.format(data.avg_loss_usd)}
            </span>
          </p>
          <p className="mt-0.5 text-[9px] text-muted-foreground">
            per trade (realized)
          </p>
        </div>
      </div>

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Realized = κλειστά trades (stop_loss / take_profit) · refreshes every 30s
      </p>
    </section>
  );
}

export default PortfolioPanel;
