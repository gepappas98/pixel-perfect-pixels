import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { SignalFeed } from "@/components/trading/SignalFeed";
import { WhalePanel } from "@/components/trading/WhalePanel";
import { IndicatorPanel } from "@/components/trading/IndicatorPanel";
import { PredictionPanel } from "@/components/trading/PredictionPanel";
import { CouncilPanel } from "@/components/trading/CouncilPanel";
import { TradesPanel } from "@/components/trading/TradesPanel";
import { getTradingStatus, runPipeline } from "@/lib/pipeline.functions";
import { getSchedule, setSchedule } from "@/lib/schedule.functions";
import { useQueryClient } from "@tanstack/react-query";

function ScheduleControl() {
  const getFn = useServerFn(getSchedule);
  const setFn = useServerFn(setSchedule);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["schedule"], queryFn: () => getFn() });
  const m = useMutation({
    mutationFn: (minutes: 0 | 2 | 5 | 10) => setFn({ data: { minutes } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule"] }),
  });
  return (
    <select
      aria-label="Auto-run interval"
      value={data?.minutes ?? 0}
      disabled={m.isPending}
      onChange={(e) => m.mutate(Number(e.target.value) as 0 | 2 | 5 | 10)}
      className="rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
    >
      <option value={0}>Auto: Off</option>
      <option value={2}>Every 2 min</option>
      <option value={5}>Every 5 min</option>
      <option value={10}>Every 10 min</option>
    </select>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Trading Command Center — whale flow, technicals & signals" },
      {
        name: "description",
        content:
          "One screen combining whale flow, technical indicators, prediction markets and AI council verdicts into live trade signals.",
      },
      { property: "og:title", content: "Trading Command Center" },
      {
        property: "og:description",
        content:
          "Live whale flow, technicals, prediction markets and AI council verdicts combined into one signal feed.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CommandCenter,
});

function CommandCenter() {
  const statusFn = useServerFn(getTradingStatus);
  const pipelineFn = useServerFn(runPipeline);

  const { data: status } = useQuery({
    queryKey: ["trading-status"],
    queryFn: () => statusFn(),
  });

  const run = useMutation({ mutationFn: () => pipelineFn({ data: undefined }) });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border px-5 py-4 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-base font-semibold tracking-tight">
              Trading Command Center
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Whale flow · technicals · prediction markets · AI council — combined into one signal feed.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                status?.mode === "live"
                  ? "border-warn/40 bg-warn/10 text-warn"
                  : "border-border bg-muted text-muted-foreground"
              }`}
            >
              {status?.mode ?? "paper"} mode
            </span>
            <ScheduleControl />
            <button
              onClick={() => run.mutate()}
              disabled={run.isPending}
              className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {run.isPending ? "Running…" : "Run pipeline"}
            </button>
          </div>
        </div>
        {run.data && (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground">
            {run.data.whales} whale prints · {run.data.indicators} technicals ·{" "}
            {run.data.predictions} markets · {run.data.signals} signals · {run.data.trades} trades
          </p>
        )}
        {run.isError && (
          <p className="mt-2 text-[11px] text-destructive">
            Pipeline failed: {(run.error as Error).message}
          </p>
        )}
      </header>

      <main className="grid grid-cols-1 gap-4 p-5 sm:p-8 lg:grid-cols-3">
        <div className="lg:col-span-2 lg:row-span-2">
          <SignalFeed />
        </div>
        <WhalePanel />
        <IndicatorPanel />
        <PredictionPanel />
        <CouncilPanel />
        <div className="lg:col-span-3">
          <TradesPanel />
        </div>
      </main>
    </div>
  );
}
