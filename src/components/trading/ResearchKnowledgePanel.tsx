"use client";

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpenCheck, Database, FileSearch, GitBranch, ShieldAlert, BrainCircuit, Loader2 } from "lucide-react";
import { getResearchKnowledgeOverview } from "@/lib/research-knowledge.functions";

function Metric({ label, value, detail }: { label: string; value: number | null; detail?: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold text-foreground">{value == null ? "—" : value.toLocaleString()}</div>
      {detail && <div className="mt-1 text-[10px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function Status({ value }: { value: string }) {
  const tone = value === "validated"
    ? "border-bull/30 bg-bull/10 text-bull"
    : value === "invalidated"
      ? "border-bear/30 bg-bear/10 text-bear"
      : "border-border bg-muted text-muted-foreground";
  return <span className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${tone}`}>{value.replaceAll("_", " ")}</span>;
}

export function ResearchKnowledgePanel() {
  const load = useServerFn(getResearchKnowledgeOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["research-knowledge-overview"],
    queryFn: () => load(),
    refetchInterval: 120_000,
    staleTime: 30_000,
  });

  return (
    <section className="panel lg:col-span-2">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="panel-title flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-accent" />
            Intelligent Research Knowledge
          </h2>
          <p className="mt-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Evidence archive · cohort-aware · research only
          </p>
        </div>
        <span className="flex items-center gap-1.5 rounded border border-border bg-muted px-2 py-1 text-[9px] font-mono text-muted-foreground">
          <BookOpenCheck className="h-3 w-3" /> NO BUY VOTE
        </span>
      </div>

      <div className="mb-3 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 p-2.5 text-[10px] text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
        <p>Research memory is not a trading signal. Findings must be linked to source evidence; candidate hypotheses are not treated as validated facts. Legacy, V2 and V3 results remain separate.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading research coverage…</div>
      ) : error || !data ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">Research overview is unavailable. Source data has not been changed.</div>
      ) : (
        <>
          {data.archiveStatus !== "ready" && (
            <div className="mb-3 rounded-md border border-warn/30 bg-warn/5 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground"><Database className="h-4 w-4 text-warn" />Archive schema not ready</div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{data.errors.archive ?? "The archive is not currently available."} Existing historical tables remain untouched. Additive migration must be reviewed and applied before findings can be persisted.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Paper trades" value={data.metrics.trades} />
            <Metric label="Council lessons" value={data.metrics.councilLessons} />
            <Metric label="Unresolved provenance" value={data.metrics.orphanLessons} detail="Lessons without a matching current trade" />
            <Metric label="V3 observations" value={data.metrics.v3Observations} detail={`${data.metrics.v3Open ?? "—"} open · ${data.metrics.v3Resolved ?? "—"} resolved`} />
            <Metric label="Knowledge findings" value={data.metrics.findings} detail={`${data.metrics.evidence ?? "—"} evidence links`} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="Early Entry decisions" value={data.metrics.earlyEntryDecisions} />
            <Metric label="Whale transition contexts" value={data.metrics.whaleTransitionContexts} />
            <Metric label="Event Flow latest states" value={data.metrics.eventFlowLatestStates} detail="Current state per asset, not full history" />
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <FileSearch className="h-3.5 w-3.5 text-accent" />
              <h3 className="text-xs font-semibold text-foreground">Evidence-backed findings</h3>
            </div>
            {data.recentFindings.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 text-[10px] leading-relaxed text-muted-foreground">
                No archived findings are available yet. This panel does not manufacture findings from counts alone. First create evidence links, then evaluate and promote hypotheses.
              </div>
            ) : (
              <div className="space-y-2">
                {data.recentFindings.map((finding) => (
                  <article key={String(finding.id)} className="rounded-md border border-border/70 bg-background/30 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-foreground">{String(finding.title)}</h4>
                      <div className="flex flex-wrap gap-1.5"><Status value={String(finding.status)} /><Status value={String(finding.cohort)} /></div>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{String(finding.summary)}</p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-mono text-muted-foreground">
                      <span>n={String(finding.sample_size)}</span>
                      <span>confidence {finding.confidence == null ? "—" : Number(finding.confidence).toFixed(2)}</span>
                      <span>evidence coverage {Math.round(Number(finding.evidence_coverage ?? 0) * 100)}%</span>
                      <span>{finding.scorer_version ? `scorer ${String(finding.scorer_version)}` : "scorer version unknown"}</span>
                    </div>
                    {finding.limitations ? <p className="mt-2 text-[10px] text-warn">Limitations: {String(finding.limitations)}</p> : null}
                  </article>
                ))}
              </div>
            )}
          </div>

          {(data.errors.source.length > 0 || data.errors.provenance) && (
            <div className="mt-3 rounded-md border border-warn/30 bg-warn/5 p-2.5 text-[10px] text-muted-foreground">
              Partial coverage: {[...data.errors.source, data.errors.provenance].filter(Boolean).join(" · ")}
            </div>
          )}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[9px] text-muted-foreground">
            <span><GitBranch className="mr-1 inline h-3 w-3" />Read-only overview · no execution impact</span>
            <span>Updated {new Date(data.generatedAt).toLocaleTimeString()}</span>
          </div>
        </>
      )}
    </section>
  );
}
