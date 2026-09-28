"use client";

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { GraduationCap, TrendingUp, TrendingDown, Minus, Loader2 } from "lucide-react";

interface CouncilLesson {
  id: string;
  symbol: string;
  verdict: string | null;
  outcome: "win" | "loss" | "breakeven";
  realized_pnl: number | null;
  lesson: string;
  created_at: string;
}

const outcomeTone: Record<string, string> = {
  win: "border-bull/30 bg-bull/10 text-bull",
  loss: "border-bear/30 bg-bear/10 text-bear",
  breakeven: "border-border bg-muted text-muted-foreground",
};

const outcomeIcon: Record<string, typeof TrendingUp> = {
  win: TrendingUp,
  loss: TrendingDown,
  breakeven: Minus,
};

function timeAgo(value: string): string {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function LessonsPanel() {
  const { data, isLoading, error } = useQuery<CouncilLesson[]>({
    queryKey: ["council-lessons"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("council_lessons")
        .select("id, symbol, verdict, outcome, realized_pnl, lesson, created_at")
        .order("created_at", { ascending: false })
        .limit(15);
      if (error) throw error;
      return (data ?? []) as CouncilLesson[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <section className="panel">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-accent" />
            Council Lessons
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Post-mortems · {data?.length ?? 0} lessons
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] text-bull">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bull" /> learning
        </span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-sm">Loading lessons…</span>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}

      <ul className="space-y-2">
        {(data ?? []).map((l) => {
          const Icon = outcomeIcon[l.outcome] ?? Minus;
          const tone = outcomeTone[l.outcome] ?? outcomeTone["breakeven"];
          return (
            <li
              key={l.id}
              className="rounded-md border border-border/70 bg-background/30 p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs font-semibold">{l.symbol}</span>
                  <span
                    className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone}`}
                  >
                    <Icon className="h-2.5 w-2.5" />
                    {l.outcome}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {timeAgo(l.created_at)}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">{l.lesson}</p>
            </li>
          );
        })}
        {!isLoading && !error && (data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">
            No lessons yet — they'll appear after the first closed trade.
          </p>
        )}
      </ul>
    </section>
  );
}

export default LessonsPanel;
