"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CheckCircle2, Clock3 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type PositionAlert = {
  id: string;
  trade_id: string | null;
  symbol: string | null;
  alert_code: string;
  severity: "critical" | "warning" | "info";
  status: "active" | "resolved";
  message: string;
  evidence: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "—";
}

function durationLabel(firstSeenAt: string): string {
  const ageMs = Math.max(0, Date.now() - new Date(firstSeenAt).getTime());
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function PositionWatchdogPanel() {
  const query = useQuery({
    queryKey: ["position-watchdog-alerts"],
    queryFn: async () => {
      // The new watchdog table may not yet be in generated client types.
      const { data, error } = await (supabase as any)
        .from("trade_position_alerts")
        .select("id,trade_id,symbol,alert_code,severity,status,message,evidence,first_seen_at,last_seen_at")
        .eq("status", "active")
        .order("severity", { ascending: true })
        .order("last_seen_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as PositionAlert[];
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 1,
  });

  const alerts = query.data ?? [];
  const criticalCount = alerts.filter((alert) => alert.severity === "critical").length;

  return (
    <div className="mb-4 rounded-md border border-border bg-surface-2/40 p-3" aria-live="polite">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {query.isError ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : criticalCount > 0 ? (
            <BellRing className="h-4 w-4 text-destructive" />
          ) : alerts.length > 0 ? (
            <AlertTriangle className="h-4 w-4 text-warn" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-bull" />
          )}
          <h2 className="panel-title">Open Position Watchdog</h2>
        </div>
        <span className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${query.isError || criticalCount > 0 ? "border-destructive/40 bg-destructive/10 text-destructive" : alerts.length > 0 ? "border-warn/40 bg-warn/10 text-warn" : "border-bull/30 bg-bull/5 text-bull"}`}>
          {query.isError ? "ALARM FEED UNAVAILABLE" : criticalCount > 0 ? `${criticalCount} CRITICAL` : alerts.length > 0 ? `${alerts.length} ACTIVE ALERTS` : "NO ACTIVE ALERTS"}
        </span>
      </div>

      {query.isLoading && <p className="text-xs text-muted-foreground">Checking active alarms…</p>}

      {query.isError && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <strong>Cannot verify watchdog alarms.</strong> The alert feed could not be read: {(query.error as Error).message}
          <div className="mt-1">Do not interpret this as “no problems”; verify that the database migration and app deployment are complete.</div>
        </div>
      )}

      {!query.isError && alerts.length === 0 && !query.isLoading && (
        <p className="text-xs text-bull">No active watchdog alarms. This means no unresolved exit condition was detected by the latest successful check; it is not a guarantee against intrabar price moves.</p>
      )}

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const critical = alert.severity === "critical";
            const evidence = alert.evidence ?? {};
            const currentPrice = Number(evidence.current_price);
            const reason = typeof evidence.reason === "string" ? evidence.reason.replaceAll("_", " ") : null;
            return (
              <div key={alert.id} role="alert" className={`rounded-md border p-3 ${critical ? "border-destructive/50 bg-destructive/10" : "border-warn/40 bg-warn/5"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    {critical ? <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />}
                    <div className="min-w-0">
                      <p className={`text-xs font-bold uppercase tracking-wide ${critical ? "text-destructive" : "text-warn"}`}>
                        {critical ? "CRITICAL — persistent issue" : "WARNING — checking position"}
                        {alert.symbol ? ` · ${alert.symbol}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-foreground">{alert.message}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
                        {reason && <span>Exit reason: {reason}</span>}
                        {Number.isFinite(currentPrice) && currentPrice > 0 && <span>Current: {currentPrice.toLocaleString("en-US", { maximumFractionDigits: 8 })}</span>}
                        <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" /> Open alarm: {durationLabel(alert.first_seen_at)}</span>
                        <span>First seen: {formatTime(alert.first_seen_at)}</span>
                        <span>Last checked: {formatTime(alert.last_seen_at)}</span>
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 rounded border border-current/20 px-1.5 py-0.5 font-mono text-[9px] uppercase">{alert.alert_code.replaceAll("_", " ")}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-[10px] text-muted-foreground">
        Checks every minute after deployment. A warning escalates to critical if it persists for 3 minutes. Alert-only: no position is automatically closed by this watchdog.
      </p>
    </div>
  );
}

export default PositionWatchdogPanel;
