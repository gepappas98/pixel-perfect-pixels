"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type TradeRow = {
  status: string | null;
  mode: string | null;
  net_pnl: number | string | null;
  pnl: number | string | null;
  entry_source: string | null;
  entry_metadata: Record<string, unknown> | null;
};

const STRATEGIES = [
  { key: "cmc", label: "CMC Paper" },
  { key: "early", label: "Early Entry Regime" },
  { key: "event", label: "Event Flow Paper" },
  { key: "standard", label: "Standard" },
] as const;

function strategyOf(t: TradeRow) {
  const metadata = t.entry_metadata ?? {};
  const raw = String(metadata.strategy ?? t.entry_source ?? "").toLowerCase();
  if (raw.includes("cmc-paper") || raw.includes("cmc_paper")) return "cmc";
  if (raw.includes("early_entry") || raw.includes("early-entry")) return "early";
  if (raw.includes("event_flow") || raw.includes("event-flow")) return "event";
  return "standard";
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function StrategyPortfolioSummary() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ["strategy-portfolio-summary", "paper"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("status,mode,net_pnl,pnl,entry_source,entry_metadata")
        .eq("mode", "paper")
        .eq("status", "closed");
      if (error) throw error;
      const rows = (data ?? []) as TradeRow[];
      return STRATEGIES.map((strategy) => {
        const trades = rows.filter((trade) => strategyOf(trade) === strategy.key);
        const pnl = trades.reduce((sum, trade) => {
          const value = Number(trade.net_pnl ?? trade.pnl ?? 0);
          return sum + (Number.isFinite(value) ? value : 0);
        }, 0);
        return { ...strategy, count: trades.length, pnl };
      });
    },
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  return (
    <section className="panel">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="panel-title">Paper strategy results</h2>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Closed paper trades · realized net PnL after fees · historical records preserved
          </p>
        </div>
        {dataUpdatedAt > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading strategy results…</p>
      ) : error ? (
        <p className="text-xs text-destructive">
          Could not load strategy results: {(error as Error).message}
        </p>
      ) : (
        <div className="space-y-2">
          {data?.map((strategy) => (
            <div
              key={strategy.key}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border border-border/70 bg-background/30 px-3 py-2"
            >
              <span className="text-xs font-medium">{strategy.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {strategy.count} closed
              </span>
              <span
                className={`text-right font-mono text-xs font-semibold ${strategy.pnl > 0 ? "text-bull" : strategy.pnl < 0 ? "text-bear" : "text-muted-foreground"}`}
              >
                {strategy.count ? `${strategy.pnl >= 0 ? "+" : "−"}${usd.format(Math.abs(strategy.pnl))}` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Refreshes every 30 seconds. Open-position unrealized PnL is excluded. Results are grouped by recorded entry strategy.
      </p>
      <div className="mt-3 rounded-md border border-dashed border-border px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Next: statistical evaluation
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Pending metrics: win rate · average profit/loss per trade · maximum drawdown (max. peak-to-trough decline). These will be added after validating strategy attribution and historical data consistency.
        </p>
      </div>
    </section>
  );
}

export default StrategyPortfolioSummary;
