"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, GitCompare, Info } from "lucide-react";

interface VariantPerfRow {
  strategy_name: string;
  wins: number;
  losses: number;
  expired: number;
  open_count: number;
  resolved: number;
  total_pnl_pct: number;
}

const PRESET_ORDER = [
  "balanced",
  "whale-focused",
  "chart-trader",
  "smc-reversal",
  "volatility-timing",
  "vwap-momentum",
  "sentiment-first",
  "ai-driven",
  "conservative",
];

const PRESET_LABEL: Record<string, string> = {
  balanced: "Balanced",
  "whale-focused": "Whale",
  "chart-trader": "Chart",
  "smc-reversal": "SMC ChoCh",
  "volatility-timing": "BB + Aroon",
  "vwap-momentum": "VWAP+RSI",
  "sentiment-first": "Sentiment",
  "ai-driven": "AI",
  conservative: "Conservative",
};

interface StrategyStats {
  wins: number;
  losses: number;
  expired: number;
  open: number;
  resolved: number;
  totalPnlPct: number;
}

const POSITION_SIZE_USD = 1000;

export function VariantComparisonPanel() {
  const { data, isLoading, error } = useQuery<VariantPerfRow[]>({
    queryKey: ["strategy-variants-perf"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_variant_performance", {
        days: 7,
      });
      if (error) throw error;
      return (data ?? []) as VariantPerfRow[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });


  if (isLoading) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading variant performance…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <h2 className="panel-title text-destructive">Variant Performance</h2>
        <p className="mt-2 text-xs text-destructive/80">
          {(error as Error).message}
        </p>
      </section>
    );
  }

  const rows = data ?? [];

  const agg = new Map<string, StrategyStats>();
  for (const r of rows) {
    agg.set(r.strategy_name, {
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      expired: Number(r.expired ?? 0),
      open: Number(r.open_count ?? 0),
      resolved: Number(r.resolved ?? 0),
      totalPnlPct: Number(r.total_pnl_pct ?? 0),
    });
  }


  const strategies = PRESET_ORDER.filter((s) => agg.has(s));
  const totalResolved = strategies.reduce(
    (sum, s) => sum + (agg.get(s)?.resolved ?? 0),
    0,
  );

  // Find best strategy by total PnL
  let bestStrategy: { name: string; pnl: number } | null = null;
  for (const s of strategies) {
    const a = agg.get(s)!;
    const pnlUsd = a.totalPnlPct * (POSITION_SIZE_USD / 100);
    if (
      a.resolved >= 5 &&
      (!bestStrategy || pnlUsd > bestStrategy.pnl)
    ) {
      bestStrategy = { name: s, pnl: pnlUsd };
    }
  }

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-accent" />
            Variant Performance (7d)
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Shadow mode · hypothetical results per preset
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {totalResolved} resolved
        </span>
      </div>

      {/* Explanation */}
      <div className="mb-3 flex items-start gap-2 rounded-md border border-accent/20 bg-accent/5 p-2.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          If you had traded{" "}
          <strong className="text-foreground">every buy/sell signal</strong>{" "}
          from each preset with{" "}
          <strong className="text-foreground">
            ${POSITION_SIZE_USD.toLocaleString()}
          </strong>{" "}
          per trade — TP +4%, SL −3%, 7-day expiry, no position caps.
          <br />
          <span className="text-muted-foreground/70">
            Shadow-only: does NOT affect real trades.
          </span>
        </p>
      </div>

      {strategies.length === 0 || totalResolved === 0 ? (
        <p className="text-sm text-muted-foreground">
          No resolved variant signals yet — will populate as signals hit their
          TP/SL thresholds.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 pr-3 font-normal">Strategy</th>
                <th className="pb-2 pr-3 font-normal">Resolved</th>
                <th className="pb-2 pr-3 font-normal text-bull">W</th>
                <th className="pb-2 pr-3 font-normal text-bear">L</th>
                <th className="pb-2 pr-3 font-normal">Win%</th>
                <th className="pb-2 pr-3 font-normal">Avg</th>
                <th className="pb-2 pr-3 font-normal">Total PnL</th>
                <th className="pb-2 font-normal text-muted-foreground">
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => {
                const a = agg.get(s)!;
                const decided = a.wins + a.losses;
                const winRate =
                  decided > 0 ? (a.wins / decided) * 100 : 0;
                const avgPnl =
                  a.resolved > 0 ? a.totalPnlPct / a.resolved : 0;
                const totalPnlUsd =
                  a.totalPnlPct * (POSITION_SIZE_USD / 100);
                const pnlPositive = totalPnlUsd >= 0;
                const isBest = bestStrategy?.name === s;

                return (
                  <tr
                    key={s}
                    className={`border-t border-border font-mono text-xs ${
                      isBest ? "bg-bull/5" : ""
                    }`}
                  >
                    <td className="py-1.5 pr-3 font-semibold">
                      {PRESET_LABEL[s] ?? s}
                      {isBest && (
                        <span className="ml-1.5 rounded border border-bull/40 bg-bull/10 px-1 py-0.5 text-[9px] font-semibold text-bull">
                          BEST
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {a.resolved}
                    </td>
                    <td className="py-1.5 pr-3 text-bull">{a.wins}</td>
                    <td className="py-1.5 pr-3 text-bear">{a.losses}</td>
                    <td className="py-1.5 pr-3">
                      {decided > 0 ? `${winRate.toFixed(0)}%` : "—"}
                    </td>
                    <td
                      className={`py-1.5 pr-3 ${
                        avgPnl >= 0 ? "text-bull" : "text-bear"
                      }`}
                    >
                      {a.resolved > 0
                        ? `${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td
                      className={`py-1.5 pr-3 font-semibold ${
                        pnlPositive ? "text-bull" : "text-bear"
                      }`}
                    >
                      {a.resolved > 0
                        ? `${pnlPositive ? "+" : "-"}$${Math.abs(totalPnlUsd).toFixed(0)}`
                        : "—"}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {a.open}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {bestStrategy && (
        <p className="mt-3 rounded-md border border-bull/30 bg-bull/5 p-2 text-[11px] text-foreground">
          <strong className="text-bull">📊 Top performer:</strong>{" "}
          {PRESET_LABEL[bestStrategy.name] ?? bestStrategy.name} with{" "}
          <span
            className={bestStrategy.pnl >= 0 ? "text-bull" : "text-bear"}
          >
            {bestStrategy.pnl >= 0 ? "+" : "-"}$
            {Math.abs(bestStrategy.pnl).toFixed(0)}
          </span>{" "}
          hypothetical PnL across{" "}
          {agg.get(bestStrategy.name)?.resolved ?? 0} resolved signals.
        </p>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Assumptions: TP +4% · SL −3% · expiry 7d · ${POSITION_SIZE_USD} per
        trade · entry at 4h candle close.
      </p>
    </section>
  );
}

export default VariantComparisonPanel;
