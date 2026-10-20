"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  summarizeStrategies,
  tallyShadowDecisions,
  type AttributionTrade,
  type ShadowTally,
} from "@/lib/strategy-attribution";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const SHADOW_VARIANT: Record<string, string> = {
  early_b: "B_EARLY_REVERSAL",
  early_c: "C_ADAPTIVE_REVERSAL",
};

export function StrategyPortfolioSummary() {
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ["strategy-portfolio-summary", "paper", "v2"],
    queryFn: async () => {
      const { data: rows, error: queryError } = await supabase
        .from("trades")
        .select("status,mode,net_pnl,pnl,entry_source,entry_metadata")
        .eq("mode", "paper")
        .in("status", ["closed", "open"]);
      if (queryError) throw queryError;
      // Generated types lag behind entry_source/entry_metadata columns.
      const results = summarizeStrategies((rows ?? []) as unknown as AttributionTrade[]);

      // Shadow decisions are optional context; failure must not hide trade results.
      let shadow: ShadowTally[] = [];
      try {
        const { data: dec, error: decErr } = await (supabase as any)
          .from("early_entry_variant_decisions")
          .select("variant,decision,trade_id")
          .in("variant", ["B_EARLY_REVERSAL", "C_ADAPTIVE_REVERSAL"])
          .limit(5000);
        if (!decErr) shadow = tallyShadowDecisions(dec ?? []);
      } catch {
        shadow = [];
      }
      return { results, shadow };
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
            Real paper trades only · realized net PnL after fees · shadow decisions are never counted as trades
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
          Could not load strategy results: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : (
        <div className="space-y-2">
          {data?.results.map((s) => {
            const shadow = SHADOW_VARIANT[s.key]
              ? data.shadow.find((t) => t.variant === SHADOW_VARIANT[s.key])
              : undefined;
            return (
              <div key={s.key} className="rounded-md border border-border/70 bg-background/30 px-3 py-2">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3">
                  <span className="text-xs font-medium">{s.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {s.state === "no_entries"
                      ? "No qualifying paper entries yet"
                      : `${s.closed} closed · ${s.open} open${s.closed ? ` · ${s.wins}W` : ""}`}
                  </span>
                  <span
                    className={`text-right font-mono text-xs font-semibold ${
                      s.state !== "has_closed"
                        ? "text-muted-foreground"
                        : s.pnl > 0
                          ? "text-bull"
                          : s.pnl < 0
                            ? "text-bear"
                            : "text-muted-foreground"
                    }`}
                  >
                    {s.state === "has_closed"
                      ? `${s.pnl >= 0 ? "+" : "−"}${usd.format(Math.abs(s.pnl))}`
                      : s.state === "open_only"
                        ? "awaiting close"
                        : "—"}
                  </span>
                </div>
                {shadow && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Shadow gate log (not trades): {shadow.noEntry} no-entry · {shadow.eligibleNoAsset} eligible/no asset ·{" "}
                    {shadow.paperOpenLinked} linked paper opens
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 border-t border-border/70 pt-2 text-[10px] text-muted-foreground">
        Refreshes every 30 seconds. “—” means the strategy’s own gate has not yet opened a paper trade, not a zero result.
        Open-position unrealized PnL is excluded.
      </p>
    </section>
  );
}

export default StrategyPortfolioSummary;
