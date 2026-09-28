import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { SignalFeed } from "@/components/trading/SignalFeed";
import { WhalePanel } from "@/components/trading/WhalePanel";
import { IndicatorPanel } from "@/components/trading/IndicatorPanel";
import { PredictionPanel } from "@/components/trading/PredictionPanel";
import { CouncilPanel } from "@/components/trading/CouncilPanel";
import { RegimePanel } from "@/components/trading/RegimePanel";
import { StrategyPanel } from "@/components/trading/StrategyPanel";
import { LessonsPanel } from "@/components/trading/LessonsPanel";
import { TradesPanel } from "@/components/trading/TradesPanel";
import { TradeAlertsPanel } from "@/components/trading/TradeAlertsPanel";
import { CronHealthPanel } from "@/components/trading/CronHealthPanel";
import { AIRiskSummary } from "@/components/trading/AIRiskSummary";
import { PortfolioPanel } from "@/components/trading/PortfolioPanel";
import { SupportDeveloper } from "@/components/trading/SupportDeveloper";
import { getTradingStatus, runPipeline } from "@/lib/pipeline.functions";
import { resetAllData } from "@/lib/admin.functions";
import { getSchedule, setSchedule } from "@/lib/schedule.functions";

/* ───────────── Reusable PIN dialog ───────────── */

function PinDialog({
  open,
  title,
  description,
  warning,
  confirmLabel,
  confirmVariant = "primary",
  isPending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  warning?: string;
  confirmLabel: string;
  confirmVariant?: "primary" | "destructive";
  isPending: boolean;
  error: string | null;
  onConfirm: (pin: string) => void;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");

  function handleClose() {
    setPin("");
    onClose();
  }

  function handleConfirm() {
    if (pin.length === 0 || isPending) return;
    onConfirm(pin);
  }

  if (!open) return null;

  const confirmClass =
    confirmVariant === "destructive"
      ? "bg-destructive text-destructive-foreground"
      : "bg-primary text-primary-foreground";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        {warning && <p className="mt-1.5 text-xs text-bull">{warning}</p>}

        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirm();
            if (e.key === "Escape") handleClose();
          }}
          placeholder="Enter PIN"
          autoFocus
          disabled={isPending}
          className="mt-3 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-center font-mono text-lg tracking-widest text-foreground focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />

        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={handleClose}
            disabled={isPending}
            className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-foreground transition hover:bg-muted/80 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={pin.length === 0 || isPending}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition hover:opacity-90 disabled:opacity-50 ${confirmClass}`}
          >
            {isPending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────── Schedule control ───────────── */

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

/* ───────────── Run pipeline (PIN protected) ───────────── */

function RunPipelineButton() {
  const pipelineFn = useServerFn(runPipeline);
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (pin: string) => pipelineFn({ data: { pin } }),
    onSuccess: () => {
      setShowDialog(false);
      setError(null);
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <>
      <button
        onClick={() => {
          setShowDialog(true);
          setError(null);
        }}
        title="Run the pipeline now (requires PIN)"
        className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Run pipeline
      </button>

      <PinDialog
        open={showDialog}
        title="Run pipeline"
        description="Manually trigger the pipeline. This consumes API quotas and takes ~60 seconds."
        warning="✓ Requires PIN to prevent accidental spam."
        confirmLabel={run.isPending ? "Running…" : "Run"}
        isPending={run.isPending}
        error={error}
        onConfirm={(pin) => run.mutate(pin)}
        onClose={() => {
          setShowDialog(false);
          setError(null);
        }}
      />
    </>
  );
}

/* ───────────── Reset data (PIN protected) ───────────── */

function ResetButton() {
  const resetFn = useServerFn(resetAllData);
  const [showDialog, setShowDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: (pin: string) => resetFn({ data: { pin } }),
    onSuccess: (data) => {
      if (!data.ok) {
        setError(data.error ?? "Reset failed");
        return;
      }
      setShowDialog(false);
      setError(null);
      console.log("[RESET] cleared:", data);
      setTimeout(() => window.location.reload(), 200);
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <>
      <button
        onClick={() => {
          setShowDialog(true);
          setError(null);
        }}
        title="Reset pipeline data — keeps trades and lessons"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/20"
      >
        Reset data
      </button>

      <PinDialog
        open={showDialog}
        title="Reset pipeline data"
        description="Deletes signals, whale alerts, technicals, predictions, council verdicts and pipeline runs."
        warning="✓ Trades and council lessons are preserved."
        confirmLabel={reset.isPending ? "Clearing…" : "Confirm"}
        confirmVariant="destructive"
        isPending={reset.isPending}
        error={error}
        onConfirm={(pin) => reset.mutate(pin)}
        onClose={() => {
          setShowDialog(false);
          setError(null);
        }}
      />
    </>
  );
}

/* ───────────── Route ───────────── */

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

  const { data: status } = useQuery({
    queryKey: ["trading-status"],
    queryFn: () => statusFn(),
  });

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
            <ResetButton />
            <RunPipelineButton />
          </div>
        </div>
      </header>

      <main className="grid grid-cols-1 gap-4 p-5 sm:p-8 lg:grid-cols-3">
        <div className="lg:col-span-2 lg:row-span-2">
          <SignalFeed />
        </div>
        <WhalePanel />
        <IndicatorPanel />
        <PredictionPanel />
        <CouncilPanel />
        <RegimePanel />
        <StrategyPanel />
        <LessonsPanel />
        <AIRiskSummary />
        <CronHealthPanel />
        <PortfolioPanel />
        <div className="lg:col-span-3">
          <TradesPanel />
        </div>
        <div className="lg:col-span-3">
          <TradeAlertsPanel />
        </div>
      </main>

      <footer className="border-t border-border px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-4xl space-y-4">
          <div className="flex flex-col items-center justify-center gap-3 text-center sm:flex-row sm:gap-6">
            <Link
              to="/about"
              className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-xs font-semibold text-accent transition hover:bg-accent/20"
            >
              📖 What is this? How does it work?
            </Link>
            <p className="text-[11px] text-muted-foreground">
              Interested in this tool?{" "}
              <a
                href="mailto:gepappas98@gmail.com?subject=Interested%20in%20the%20Trading%20Command%20Center"
                className="font-semibold text-bull underline-offset-2 hover:underline"
              >
                Contact gepappas98@gmail.com
              </a>
            </p>
          </div>

          <SupportDeveloper />
        </div>
      </footer>
    </div>
  );
}
