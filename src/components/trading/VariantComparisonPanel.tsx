"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, GitCompare } from "lucide-react";

interface VariantRow {
  strategy_name: string;
  symbol: string;
  recommendation: string | null;
  confidence: number | null;
  created_at: string;
}

const PRESET_ORDER = [
  "balanced",
  "whale-focused",
  "chart-trader",
  "sentiment-first",
  "ai-driven",
  "conservative",
];

const PRESET_LABEL: Record<string, string> = {
  balanced: "Balanced",
  "whale-focused": "Whale",
  "chart-trader": "Chart",
  "sentiment-first": "Sentiment",
  "ai-driven": "AI",
  conservative: "Conservative",
};

const REC_TONE: Record<string, string> = {
  buy: "text-bull",
  sell: "text-bear",
  watch: "text-warn",
  hold: "text-muted-foreground",
};

export function VariantComparisonPanel() {
  const { data, isLoading, error } = useQuery<VariantRow[]>({
    queryKey: ["strategy-variants-24h"],
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("strategy_variant_signals")
        .select("strategy_name, symbol, recommendation, confidence, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(3000);
      if (error) throw error;
      return (data ?? []) as VariantRow[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <section className="panel">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading variant signals…</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <h2 className="panel-title text-destructive">Variant Signals</h2>
        <p className="mt-2 text-xs text-destructive/80">
          {(error as Error).message}
        </p>
      </section>
    );
  }

  const rows = data ?? [];

  // Aggregate: per strategy → buy/sell/watch counts
  const agg = new Map<
    string,
    { buy: number; sell: number; watch: number; total: number }
  >();
  for (const r of rows) {
    const s = r.strategy_name;
    const rec = String(r.recommendation ?? "").toLowerCase();
    const bucket = agg.get(s) ?? { buy: 0, sell: 0, watch: 0, total: 0 };
    if (rec === "buy") bucket.buy++;
    else if (rec === "sell") bucket.sell++;
    else if (rec === "watch") bucket.watch++;
    bucket.total++;
    agg.set(s, bucket);
  }

  const strategies = PRESET_ORDER.filter((s) => agg.has(s));

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-accent" />
            Variant Signals (24h)
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Shadow mode · what each preset would have recommended
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {rows.length} signals
        </span>
      </div>

      {strategies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No variant signals yet — will populate on the next pipeline run.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pb-2 pr-3 font-normal">Strategy</th>
                <th className="pb-2 pr-3 font-normal text-bull">Buy</th>
                <th className="pb-2 pr-3 font-normal text-bear">Sell</th>
                <th className="pb-2 pr-3 font-normal text-warn">Watch</th>
                <th className="pb-2 font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => {
                const a = agg.get(s)!;
                return (
                  <tr key={s} className="border-t border-border font-mono text-xs">
                    <td className="py-1.5 font-semibold">
                      {PRESET_LABEL[s] ?? s}
                    </td>
                    <td className={`py-1.5 ${REC_TONE["buy"]}`}>{a.buy}</td>
                    <td className={`py-1.5 ${REC_TONE["sell"]}`}>{a.sell}</td>
                    <td className={`py-1.5 ${REC_TONE["watch"]}`}>{a.watch}</td>
                    <td className="py-1.5 text-muted-foreground">{a.total}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Shadow-only — these signals do NOT affect trades or the composite feed.
      </p>
    </section>
  );
}

export default VariantComparisonPanel;
