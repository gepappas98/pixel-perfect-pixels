"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getAiHealthStatus } from "@/lib/pipeline.functions";

function timeAgo(value?: string | null): string {
  if (!value) return "never";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "never";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function GroqStatusIndicator() {
  const healthFn = useServerFn(getAiHealthStatus);
  const { data } = useQuery({
    queryKey: ["ai-health"],
    queryFn: () => healthFn(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!data || data.available === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/30 bg-muted/30 px-2.5 py-1 text-[10px] font-mono text-muted-foreground">
        <Bot className="h-3 w-3" />
        AI: N/A
      </span>
    );
  }

  const status = data.status;

  if (status === "unknown") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[10px] font-mono text-muted-foreground">
        <Bot className="h-3 w-3" />
        AI: awaiting
      </span>
    );
  }

  if (status === "ok") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-bull/40 bg-bull/10 px-2.5 py-1 text-[10px] font-mono font-semibold text-bull"
        title={`Last success: ${timeAgo(data.lastSuccessAt)}`}
      >
        <CheckCircle2 className="h-3 w-3" />
        AI: online
      </span>
    );
  }

  if (status === "degraded_fallback") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-[10px] font-mono font-semibold text-warn"
        title={`Fallback active. ${data.error ?? "Some lessons could not be generated."}`}
      >
        <AlertTriangle className="h-3 w-3" />
        AI: fallback
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[10px] font-mono font-semibold text-destructive"
      title={data.error ?? "Groq API failure"}
    >
      <AlertTriangle className="h-3 w-3" />
      AI: error
    </span>
  );
}

export default GroqStatusIndicator;
