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

interface TradingSettings {
  variant_max_hours: number;
  variant_tp_pct: number;
  variant_sl_pct: number;
}

/**
 * Πλήρης λίστα preset keys σε order εμφάνισης.
 * ΠΡΕΠΕΙ να είναι σε sync με το STRATEGY_PRESETS στο strategy.presets.ts.
 */
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
  "smc-reversal": "SMC Pro",
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

const ZERO_STATS: StrategyStats = {
  wins: 0,
  losses: 0,
  expired: 0,
  open: 0,
  resolved: 0,
  totalPnlPct: 0,
};

const POSITION_SIZE_USD = 1000;

const FALLBACK_SETTINGS: TradingSettings = {
  variant_max_hours: 72,
  variant_tp_pct: 0.04,
  variant_sl_pct: 0.03,
};

export function VariantComparisonPanel() {
  // ── Fetch performance data ──
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

  // ── Fetch dynamic settings ──
  const { data: settings } = useQuery<TradingSettings>({
    queryKey: ["trading-settings-variant"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pipeline_settings")
        .select("variant_max_hours, variant_tp_pct, variant_sl_pct")
        .single();
      if (error) throw error;
      const row = (data ?? {}) as unknown as Record<string, unknown>;
      return {
        variant_max_hours: Number(row["variant_max_hours"] ?? 72),
        variant_tp_pct: Number(row["variant_tp_pct"] ?? 0.04),
        variant_sl_pct: Number(row["variant_sl_pct"] ?? 0.03),
      };
    },
    refetchInterval: 300_000,
    staleTime: 60_000,
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
  const s = settings ?? FALLBACK_SETTINGS;

  // ── Build aggregation ──
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

  const strategies = PRESET_ORDER;
  const totalResolved = strategies.reduce(
    (sum, s2) => sum + (agg.get(s2)?.resolved ?? 0),
    0,
  );

  // ── Best strategy ──
  // A negative total can still be the least-bad preset. Do not label it BEST.
  const MIN_BEST_SAMPLE = 25;
  const maxPositiveAvg = Math.max(
    0,
    ...strategies.map((s2) => {
      const a = agg.get(s2) ?? ZERO_STATS;
      return a.resolved >= MIN_BEST_SAMPLE && a.resolved > 0
        ? a.totalPnlPct / a.resolved
        : 0;
    }),
  );
  const bestStrategy =
    maxPositiveAvg > 0
      ? strategies.find((s2) => {
          const a = agg.get(s2) ?? ZERO_STATS;
          return (
            a.resolved >= MIN_BEST_SAMPLE &&
            a.totalPnlPct / a.resolved === maxPositiveAvg
          );
        }) ?? null
      : null;

  // ── Dynamic labels ──
  const tpLabel = `TP +${(s.variant_tp_pct * 100).toFixed(0)}%`;
  const slLabel = `SL −${(s.variant_sl_pct * 100).toFixed(0)}%`;
  const expiryLabel = `${s.variant_max_hours}h expiry`;

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
          <strong className="text-foreground">every executable BUY signal</strong>{" "}
          from each preset with{" "}
          <strong className="text-foreground">
            ${POSITION_SIZE_USD.toLocaleString()}
          </strong>{" "}
          per trade —{" "}
          <strong className="text-foreground">{tpLabel}</strong>,{" "}
          <strong className="text-foreground">{slLabel}</strong>,{" "}
          <strong className="text-foreground">{expiryLabel}</strong>, no
          position caps.
          <br />
          <span className="text-muted-foreground/70">
            Shadow-only: does NOT affect real trades.
          </span>
        </p>
      </div>

      {totalResolved === 0 ? (
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
              {strategies.map((s2) => {
                const a = agg.get(s2) ?? ZERO_STATS;
                const decided = a.wins + a.losses;
                const winRate =
                  decided > 0 ? (a.wins / decided) * 100 : 0;
                const avgPnl =
                  a.resolved > 0 ? a.totalPnlPct / a.resolved : 0;
                const totalPnlUsd =
                  a.totalPnlPct * (POSITION_SIZE_USD / 100);
                const pnlPositive = totalPnlUsd >= 0;
                const isBest = bestStrategy === s2;
                const hasData = a.resolved > 0 || a.open > 0;

                return (
                  <tr
                    key={s2}
                    className={`border-t border-border font-mono text-xs ${
                      isBest
                        ? "bg-bull/5"
                        : !hasData
                          ? "opacity-50"
                          : ""
                    }`}
                  >
                    <td className="py-1.5 pr-3 font-semibold">
                      {PRESET_LABEL[s2] ?? s2}
                      {isBest && (
                        <span className="ml-1.5 rounded border border-bull/40 bg-bull/10 px-1 py-0.5 text-[9px] font-semibold text-bull">
                          BEST
                        </span>
                      )}
                      {!hasData && (
                        <span className="ml-1.5 rounded border border-border/70 px-1 py-0.5 text-[9px] font-normal text-muted-foreground">
                          awaiting
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {a.resolved}
                    </td>
                    <td className="py-1.5 pr-3 text-bull">
                      {hasData ? a.wins : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-bear">
                      {hasData ? a.losses : "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      {decided > 0 ? `${winRate.toFixed(0)}%` : "—"}
                    </td>
                    <td
                      className={`py-1.5 pr-3 ${
                        hasData && avgPnl >= 0
                          ? "text-bull"
                          : hasData
                            ? "text-bear"
                            : ""
                      }`}
                    >
                      {a.resolved > 0
                        ? `${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td
                      className={`py-1.5 pr-3 font-semibold ${
                        hasData && pnlPositive
                          ? "text-bull"
                          : hasData
                            ? "text-bear"
                            : ""
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
          {PRESET_LABEL[bestStrategy] ?? bestStrategy} with positive average
          expectancy across {agg.get(bestStrategy)?.resolved ?? 0} resolved
          signals.
        </p>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Assumptions: {tpLabel} · {slLabel} · {expiryLabel} · $
        {POSITION_SIZE_USD} per trade · entry at 4h candle close.
      </p>
    </section>
  );
}

export default VariantComparisonPanel;
