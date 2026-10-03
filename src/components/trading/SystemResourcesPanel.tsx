"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Database, Gauge, HardDrive, Loader2, Server } from "lucide-react";
import { getSystemResourceMetrics } from "@/lib/pipeline.functions";

function levelClass(level: string) {
  return level === "danger" ? "text-destructive" : level === "warning" ? "text-warn" : "text-bull";
}
function Bar({ value, level = "normal" }: { value: number; level?: string }) {
  return <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${level === "danger" ? "bg-destructive" : level === "warning" ? "bg-warn" : "bg-bull"}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}
function Metric({ icon: Icon, label, value, detail, percent, level = "normal" }: { icon: typeof Activity; label: string; value: string; detail: string; percent?: number; level?: string }) {
  return <div className="rounded-md border border-border/70 bg-background/30 p-3"><div className="flex items-center gap-2 text-muted-foreground"><Icon className="h-3.5 w-3.5" /><span className="text-[10px] uppercase tracking-wider">{label}</span></div><div className={`mt-2 font-mono text-lg font-semibold ${levelClass(level)}`}>{value}</div><div className="mt-1 text-[10px] text-muted-foreground">{detail}</div>{percent !== undefined && <Bar value={percent} level={level} />}</div>;
}

export function SystemResourcesPanel() {
  const fn = useServerFn(getSystemResourceMetrics);
  const { data, isLoading, error } = useQuery({ queryKey: ["system-resource-metrics"], queryFn: () => fn(), refetchInterval: 15_000, staleTime: 10_000 });
  return <section className="panel"><div className="mb-4 flex items-start justify-between"><div><h2 className="panel-title">System Resources</h2><p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">Live database limits</p></div><Server className="h-4 w-4 text-accent" /></div>{isLoading ? <div className="flex items-center gap-2 py-5 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading resource metrics…</div> : error || !data ? <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Resource metrics unavailable. Confirm get_system_resource_stats is installed.</p> : <div className="grid grid-cols-2 gap-2"><Metric icon={Activity} label="Connections" value={`${data.connections.current}/${data.connections.max}`} detail={`${data.connections.percentage.toFixed(0)}% used · ${data.connections.level}`} percent={data.connections.percentage} level={data.connections.level} /><Metric icon={Gauge} label="Pipeline" value={`${(data.pipeline.durationMs / 1000).toFixed(1)}s`} detail={`${data.pipeline.durationPct.toFixed(0)}% of 60s limit · ${data.pipeline.status}`} percent={data.pipeline.durationPct} level={data.pipeline.durationPct >= 85 ? "danger" : data.pipeline.durationPct >= 70 ? "warning" : "normal"} /><Metric icon={HardDrive} label="Storage" value={data.storage.pretty} detail={`${data.storage.variantSignals.toLocaleString()} variant rows`} /><Metric icon={Database} label="Cache hit" value={`${data.cacheHitPct.toFixed(1)}%`} detail={`Checked ${new Date(data.checkedAt).toLocaleTimeString()}`} percent={data.cacheHitPct} level={data.cacheHitPct < 90 ? "warning" : "normal"} /></div>}</section>;
}
