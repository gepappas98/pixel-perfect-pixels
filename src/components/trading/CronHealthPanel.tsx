"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle, Clock, AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import { getCronHealth } from "@/lib/pipeline.functions";

function timeAgo(value?: string | null) {
  if (!value) return "never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "invalid";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours <= 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "—";
}

function until(value?: string | null) {
  if (!value) return "—";
  const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "due now";
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.ceil(minutes / 60)}h`;
}

function formatDuration(ms?: number | null) {
  if (!ms || ms < 0) return "0.0s";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function CronHealthPanel() {
  const healthFn = useServerFn(getCronHealth);
  const { data: health, isLoading, error } = useQuery({
    queryKey: ["cron-health"],
    queryFn: () => healthFn(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading) return <section className="panel">Loading pipeline health…</section>;
  if (error || !health || health.available === false) {
    const reason = health && "reason" in health ? health.reason : "Canonical pipeline health is unavailable";
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <h2 className="panel-title text-destructive">Pipeline Health</h2>
        </div>
        <p className="mt-3 text-xs text-destructive/80">Canonical pipeline health is unavailable.</p>
        <p className="mt-2 break-words font-mono text-[10px] text-destructive/60">{reason}</p>
      </section>
    );
  }

  const status = health.status;
  const latestRun = health.latestRun;
  const lastSuccess = health.lastSuccess;
  const recentErrors = health.recentErrors ?? [];
  const intervalMinutes = health.intervalMinutes;
  const staleAfterMinutes = health.staleAfterMinutes;
  const healthyStatus = status === "HEALTHY";
  const runningStatus = status === "RUNNING";
  const failedStatus = status === "FAILED";
  const staleStatus = status === "STALE";

  return (
    <section className="panel overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Pipeline Health</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">Canonical run monitoring</p>
        </div>
        <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
          healthyStatus
            ? "border-bull/30 bg-bull/10 text-bull"
            : runningStatus
              ? "border-warn/30 bg-warn/10 text-warn"
              : "border-destructive/30 bg-destructive/10 text-destructive"
        }`}>
          {healthyStatus && <><CheckCircle className="h-3.5 w-3.5" /> Healthy</>}
          {runningStatus && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running</>}
          {failedStatus && <><AlertCircle className="h-3.5 w-3.5" /> Failed</>}
          {staleStatus && <><AlertTriangle className="h-3.5 w-3.5" /> Stale</>}
        </div>
      </div>

      <div className="space-y-3">
        {runningStatus && latestRun && (
          <div className="rounded-md border border-warn/30 bg-warn/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Current Run</span>
              <span className="font-mono text-sm font-semibold text-warn">
                {formatDuration(Math.max(0, Date.now() - new Date(latestRun.started_at ?? Date.now()).getTime()))}
              </span>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Started at {formatTime(latestRun.started_at)} · {latestRun.job_name}
            </p>
          </div>
        )}

        {lastSuccess && (
          <div className="rounded-md border border-border/70 bg-background/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Last Successful Run</span>
              <span className="font-mono text-sm font-semibold text-foreground">{timeAgo(lastSuccess.completed_at)}</span>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Completed at {formatTime(lastSuccess.completed_at)} · duration {formatDuration(lastSuccess.duration_ms)}
            </p>
          </div>
        )}

        {health.nextRunAt && intervalMinutes > 0 && (
          <div className="rounded-md border border-border/70 bg-background/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Next Scheduled Run</span>
              <span className="flex items-center gap-1.5 font-mono text-sm font-semibold">
                <Clock className="h-3.5 w-3.5 text-bull" />
                {until(health.nextRunAt)}
              </span>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Every {intervalMinutes} minutes · next at {formatTime(health.nextRunAt)}
            </p>
          </div>
        )}

        {health.consecutiveFailures > 0 && (
          <div className="rounded-md border border-warn/30 bg-warn/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-warn">Failures since last success</span>
              <span className="font-mono text-sm font-semibold text-warn">{health.consecutiveFailures}</span>
            </div>
            <p className="mt-2 text-[10px] text-warn/80">
              These are canonical pipeline failures after the latest successful run.
            </p>
          </div>
        )}

        {recentErrors.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <div className="flex items-center gap-2 mb-2">
              <AlertCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-destructive">
                Recent Errors — history ({recentErrors.length})
              </span>
            </div>
            <div className="space-y-1.5">
              {recentErrors.map((err) => (
                <details key={err.id} className="group">
                  <summary className="flex items-center gap-1.5 cursor-pointer text-[10px] text-destructive/90 hover:text-destructive">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    <span className="font-mono">{formatTime(err.started_at)}</span>
                    <span className="truncate">{err.message.slice(0, 80)}</span>
                  </summary>
                  <pre className="mt-1.5 whitespace-pre-wrap break-words rounded border border-destructive/20 bg-background/40 p-2 font-mono text-[10px] text-destructive/80">
                    {err.message}
                  </pre>
                </details>
              ))}
            </div>
          </div>
        )}

        {failedStatus && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-[11px] font-semibold text-destructive">
              Current pipeline run failed. A newer successful run is required to return to Healthy.
            </p>
          </div>
        )}

        {staleStatus && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-destructive">Pipeline Stale</span>
            </div>
            <p className="mt-2 text-[10px] text-destructive/80">
              No successful canonical run in the last {staleAfterMinutes} minutes.
            </p>
          </div>
        )}

        {healthyStatus && (
          <div className="rounded-md border border-bull/30 bg-bull/10 p-3">
            <p className="text-[11px] font-semibold text-bull">
              ✓ Latest canonical run completed successfully. Historical errors do not change current health.
            </p>
          </div>
        )}
      </div>

      <p className="mt-4 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
        Refreshes every 30 seconds · canonical stale threshold {staleAfterMinutes}m
      </p>
    </section>
  );
}
