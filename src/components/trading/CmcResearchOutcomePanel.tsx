"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type OutcomeRow = {
  momentum_alignment: string;
  forward_return_pct_24h: number | null;
  forward_return_pct_72h: number | null;
};

const COHORTS = ["aligned_up", "aligned_down", "cooling", "bounce", "mixed_or_incomplete"];

function formatPct(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function CmcResearchOutcomePanel() {
  const outcomes = useQuery({
    queryKey: ["cmc-listing-research-outcomes"],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("cmc_listing_research_observations")
        .select("momentum_alignment,forward_return_pct_24h,forward_return_pct_72h")
        .or("forward_return_pct_24h.not.is.null,forward_return_pct_72h.not.is.null")
        .order("observed_at", { ascending: false })
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as OutcomeRow[];
    },
    staleTime: 15 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: 1,
  });

  const rows = outcomes.data ?? [];
  const summary = COHORTS.map((cohort) => {
    const subset = rows.filter((row) => row.momentum_alignment === cohort);
    const stats = (horizon: "24h" | "72h") => {
      const values = subset.map((row) => horizon === "24h" ? row.forward_return_pct_24h : row.forward_return_pct_72h)
        .filter((value): value is number => value != null && Number.isFinite(value));
      return {
        n: values.length,
        avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        positive: values.length ? values.filter((value) => value > 0).length / values.length * 100 : null,
      };
    };
    return { cohort, h24: stats("24h"), h72: stats("72h") };
  });
  const n24 = summary.reduce((sum, row) => sum + row.h24.n, 0);
  const n72 = summary.reduce((sum, row) => sum + row.h72.n, 0);

  return (
    <div className="mt-4 border-t border-border/70 pt-3">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-foreground">CMC forward-outcome research</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">Descriptive evaluation only · future returns are outcome labels, never entry features</p>
        </div>
        <span className="text-[10px] text-muted-foreground">24h labels: {n24.toLocaleString()} · 72h labels: {n72.toLocaleString()}</span>
      </div>
      {outcomes.isError ? (
        <p className="text-xs text-muted-foreground">Research outcomes temporarily unavailable; listing context remains available.</p>
      ) : n24 === 0 && n72 === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          Warming up: no valid 24h/72h forward labels yet. CMC keyless snapshots arrive on a multi-hour cadence, so 1h/4h outcomes are not inferred from this feed.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="pb-2 pr-3">Momentum cohort</th><th className="pb-2 pr-3 text-right">24h n</th><th className="pb-2 pr-3 text-right">24h avg</th><th className="pb-2 pr-3 text-right">24h positive</th><th className="pb-2 pr-3 text-right">72h n</th><th className="pb-2 pr-3 text-right">72h avg</th><th className="pb-2 text-right">72h positive</th></tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.cohort} className="border-t border-border/50">
                  <td className="py-2 pr-3">{row.cohort.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-3 text-right font-mono">{row.h24.n}</td>
                  <td className={`py-2 pr-3 text-right font-mono ${row.h24.avg == null ? "text-muted-foreground" : row.h24.avg > 0 ? "text-bull" : row.h24.avg < 0 ? "text-bear" : "text-muted-foreground"}`}>{formatPct(row.h24.avg)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{row.h24.positive == null ? "—" : `${row.h24.positive.toFixed(1)}%`}</td>
                  <td className="py-2 pr-3 text-right font-mono">{row.h72.n}</td>
                  <td className={`py-2 pr-3 text-right font-mono ${row.h72.avg == null ? "text-muted-foreground" : row.h72.avg > 0 ? "text-bull" : row.h72.avg < 0 ? "text-bear" : "text-muted-foreground"}`}>{formatPct(row.h72.avg)}</td>
                  <td className="py-2 text-right font-mono">{row.h72.positive == null ? "—" : `${row.h72.positive.toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted-foreground">Forward windows use observed snapshots at 18–30h and 66–78h after each source observation. Small samples are not evidence of a profitable strategy.</p>
        </div>
      )}
    </div>
  );
}
