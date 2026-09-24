"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle, Clock, AlertCircle } from "lucide-react";
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
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString();
}

function until(value?: string | null) {
  if (!value) return "—";
  const minutes = Math.ceil((new Date(value).getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "due now";
  return minutes < 60 ? `in ${minutes}m` : `in ${Math.ceil(minutes / 60)}h`;
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
    const reason = health && "reason" in health ? health.reason : "Health storage is unavailable";
    return (
      <section className="panel border-destructive/30 bg-destructive/5">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <h2 className="panel-title text-destructive">Pipeline Health</h2>
        </div>
        <p className="mt-3 text-xs text-destructive/80">
          Health data is unavailable. Apply the pipeline health migration and confirm the cron can write run records.
        </p>
        <p className="mt-2 break-words font-mono text-[10px] text-destructive/60">{reason}</p>
      </section>
    );
  }

  const { lastSuccess, nextRunAt, consecutiveFailures, stale, staleAfterMinutes, intervalMinutes } = health;
  const healthyStatus = lastSuccess && !stale && consecutiveFailures === 0;

  return (
    <section className="panel overflow-hidden">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title">Pipeline Health</h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">Cron monitoring</p>
        </div>
        <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
          healthyStatus
            ? "border-bull/30 bg-bull/10 text-bull"
            : stale
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-warn/30 bg-warn/10 text-warn"
        }`}>
          {healthyStatus ? (
            <><CheckCircle className="h-3.5 w-3.5" /> Healthy</>
          ) : stale ? (
            <><AlertTriangle className="h-3.5 w-3.5" /> Stale</>
          ) : (
            <><AlertCircle className="h-3.5 w-3.5" /> Warning</>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {/* Last Run */}
        <div className="rounded-md border border-border/70 bg-background/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Last Successful Run</span>
            {lastSuccess ? (
              <span className="font-mono text-sm font-semibold text-foreground">{timeAgo(lastSuccess.completed_at)}</span>
            ) : (
              <span className="font-mono text-sm text-destructive">Never</span>
            )}
          </div>
          {lastSuccess && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Completed at {formatTime(lastSuccess.completed_at)}
            </p>
          )}
        </div>

        {/* Next Scheduled Run */}
        {nextRunAt && intervalMinutes > 0 && (
          <div className="rounded-md border border-border/70 bg-background/30 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Next Scheduled Run</span>
              <span className="flex items-center gap-1.5 font-mono text-sm font-semibold">
                <Clock className="h-3.5 w-3.5 text-bull" />
                {until(nextRunAt)}
              </span>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Every {intervalMinutes} minutes · next at {formatTime(nextRunAt)}
            </p>
          </div>
        )}

        {/* Consecutive Failures */}
        {consecutiveFailures > 0 && (
          <div className="rounded-md border border-warn/30 bg-warn/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-warn">Consecutive Failures</span>
              <span className="font-mono text-sm font-semibold text-warn">{consecutiveFailures}</span>
            </div>
            <p className="mt-2 text-[10px] text-warn/80">
              Pipeline has failed {consecutiveFailures} time{consecutiveFailures !== 1 ? "s" : ""} in a row. Check logs for details.
            </p>
          </div>
        )}

        {/* Stale Warning */}
        {stale && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-destructive">Pipeline Stale</span>
            </div>
            <p className="mt-2 text-[10px] text-destructive/80">
              No successful run in the last {staleAfterMinutes} minutes. The pipeline may be failing silently or cron not triggering.
            </p>
          </div>
        )}

        {/* Healthy Status */}
        {healthyStatus && (
          <div className="rounded-md border border-bull/30 bg-bull/10 p-3">
            <p className="text-[11px] font-semibold text-bull">
              ✓ Pipeline is running smoothly on schedule with no failures.
            </p>
          </div>
        )}
      </div>

      <p className="mt-4 border-t border-border/70 pt-3 text-[10px] text-muted-foreground">
        Refreshes every 30 seconds · stale threshold {staleAfterMinutes}m
      </p>
    </section>
  );
}
