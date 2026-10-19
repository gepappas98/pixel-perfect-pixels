import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpen, RefreshCw, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getResearchKnowledge } from "@/lib/research-knowledge.functions";
import { dedupeCases, eligibleEntryEvidence, isEvaluated, validateFinding, type Cohort, type KnowledgeSnapshot } from "@/lib/research-knowledge";

export function ResearchKnowledgeView({ snapshot, loading, error, refreshing = false, onRefresh, onExport }: {
  snapshot: KnowledgeSnapshot | undefined; loading: boolean; error: string | null; refreshing?: boolean;
  onRefresh?: () => void; onExport?: () => void;
}) {
  const [cohort, setCohort] = useState<Cohort>("V3");
  const cases = dedupeCases(snapshot?.cases ?? []).filter(c => c.cohort === cohort);
  const evaluated = snapshot ? cases.filter(c => isEvaluated(c, snapshot.checked_at)) : [];
  const covered = cases.filter(c => snapshot?.evidence.some(e => c.evidence_ids.includes(e.id) && eligibleEntryEvidence(e, c.entry_at)));
  const orphanLessons = snapshot?.lessons.filter(l => l.provenance !== "linked") ?? [];
  const archiveState = snapshot?.archival ?? "unverified";
  const archiveStatus = snapshot?.archive_status;
  const archiveMessage = archiveState === "ready"
    ? "All currently retention-eligible source IDs have evidence records. This is not a guarantee of full-history coverage or exact source-content equivalence."
    : archiveState === "incomplete"
      ? "Some retention-eligible sources are missing evidence. A fail-closed cleanup must abort rather than delete these rows."
      : archiveState === "migration_pending"
        ? "Archive migration is not installed. The current production retention function may still delete old source rows."
        : "Archive readiness could not be verified; assume it is not ready.";
  return <section aria-label="Research Knowledge" className="space-y-4 border-t border-border py-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-medium"><BookOpen className="size-5 text-primary" />Research Knowledge</h2>
        <p className="text-xs text-muted-foreground">Research evidence · not a BUY recommendation</p></div>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}><RefreshCw className={refreshing ? "animate-spin motion-reduce:animate-none" : ""} />Refresh</Button>
        <Button variant="outline" size="sm" disabled={!snapshot} onClick={onExport}><Download />Provenance audit</Button></div>
    </div>
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading research evidence…</p>}
    {error && <p role="alert" className="text-sm text-destructive">Research evidence unavailable: {error}</p>}
    {snapshot && <>
      <p className="text-xs text-muted-foreground">Checked {snapshot.checked_at} · {snapshot.bounded ? "Bounded sample; not full-history statistics" : "Current source snapshot; not full-history statistics"}</p>
      <div role="group" aria-label="Historical cohorts" className="flex flex-wrap gap-1">{(["Legacy", "V2", "V3", "Unknown"] as Cohort[]).map(c => <Button key={c} size="sm" variant={c === cohort ? "secondary" : "ghost"} aria-pressed={c === cohort} onClick={() => setCohort(c)}>{c}</Button>)}</div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{[["Observed cases", cases.length], ["Outcome-evaluated", evaluated.length], ["Entry evidence coverage", `${covered.length}/${cases.length}`], ["Missing lesson links", orphanLessons.length]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono text-lg">{value}</dd></div>)}</dl>
      <div className={`border-l-2 pl-3 text-sm ${archiveState === "ready" ? "border-bull" : "border-warn"}`}>
        <p className={`font-medium ${archiveState === "ready" ? "text-bull" : "text-warn"}`}>Retention / archive readiness: {archiveState.toUpperCase()}</p>
        <p className="text-xs text-muted-foreground">72h raw / 168h derived retention. {archiveMessage} V3 rows without an explicit resolved timestamp remain unevaluated.</p>
        {archiveStatus && <p className="mt-1 text-xs text-muted-foreground">Eligible: {archiveStatus.eligible_sources.toLocaleString()} · archived source IDs: {archiveStatus.archived_sources.toLocaleString()} · missing: {archiveStatus.missing_sources.toLocaleString()} · last evidence capture: {archiveStatus.last_archive_at ?? "none recorded"}</p>}
        {archiveStatus && archiveStatus.missing_sources > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs">Missing evidence by source</summary><ul className="mt-1 list-disc pl-5 text-xs">{Object.entries(archiveStatus.by_table).filter(([, row]) => row.missing > 0).map(([table, row]) => <li key={table}>{table}: {row.missing} / {row.eligible} missing</li>)}</ul></details>}
      </div>
      {snapshot.issues.length > 0 && <details><summary className="cursor-pointer text-sm text-warn">Source availability ({snapshot.issues.length})</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{snapshot.issues.map(i => <li key={i}>{i}</li>)}</ul></details>}
      <h3 className="text-sm font-medium">Findings / hypotheses</h3>
      {snapshot.findings.filter(f => f.cohort === cohort).length === 0 ? <p className="text-sm text-muted-foreground">No evidence-backed findings available for this cohort.</p> : snapshot.findings.filter(f => f.cohort === cohort).map(f => {
        const failures = validateFinding(f, snapshot.cases, snapshot.evidence, snapshot.checked_at);
        return <details key={f.id} className="border-b border-border pb-3"><summary className="cursor-pointer text-sm">{f.title} · {failures.length ? "unverified" : f.status} · n={f.sample_size}</summary>
          <div className="mt-2 space-y-1 break-words text-xs"><p>{f.statement}</p><p>Version: {f.scorer_version} · confidence: {(f.confidence * 100).toFixed(0)}% · checked: {f.checked_at}</p><p>Evidence: {f.evidence_ids.join(", ")}</p><p>Limitations: {f.limitations}</p><p>Reproduction: {f.reproduction}</p>{failures.length > 0 && <p className="text-warn">Validation gaps: {failures.join(", ")}</p>}</div></details>;
      })}
      <details><summary className="cursor-pointer text-sm">Unresolved provenance ({orphanLessons.length})</summary><ul className="mt-2 space-y-2 text-xs">{orphanLessons.map(l => <li key={l.id} className="break-words">{l.symbol} · {l.provenance} · lesson {l.id} · trade {l.source_trade_id ?? "missing"}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">Audit export records IDs for manual evidence review. No deletion or automatic remapping.</p></details>
      <details><summary className="cursor-pointer text-sm">Evidence layers / historical cases</summary><p className="mt-2 text-xs text-muted-foreground">Raw observations: {snapshot.evidence.filter(e => e.role === "observation").length} · Compressed AI memory: unavailable, not treated as facts.</p><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{["Symbol", "Strategy", "Outcome", "Net PnL / unit", "Regime", "Entry", "Close reason"].map(h => <th className="px-2 py-2" key={h}>{h}</th>)}</tr></thead><tbody>{cases.slice(0, 30).map(c => <tr key={`${c.id}:${c.scorer_version}`} className="border-t border-border"><td className="px-2 py-2">{c.symbol}</td><td className="px-2 py-2">{c.strategy}</td><td className="px-2 py-2">{c.outcome}</td><td className="px-2 py-2">{c.net_pnl ?? "—"} {c.pnl_unit}</td><td className="px-2 py-2">{c.regime ?? "unknown"}</td><td className="whitespace-nowrap px-2 py-2">{c.entry_at}</td><td className="px-2 py-2">{c.close_reason ?? "—"}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
export default function ResearchKnowledgePanel() {
  const read = useServerFn(getResearchKnowledge);
  const query = useQuery({ queryKey: ["research-knowledge"], queryFn: () => read(), staleTime: 60_000, retry: false });
  const exportAudit = () => {
    if (!query.data) return;
    const blob = new Blob([JSON.stringify({ checked_at: query.data.checked_at, scope: "bounded_provenance_review", lessons: query.data.lessons.filter(l => l.provenance !== "linked"), limitations: query.data.issues, automatic_repair: false }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "research-provenance-audit.json"; a.click(); URL.revokeObjectURL(url);
  };
  return <ResearchKnowledgeView snapshot={query.data} loading={query.isLoading} refreshing={query.isFetching} error={query.error ? "Read failed; no source data was changed." : null} onRefresh={() => void query.refetch()} onExport={exportAudit} />;
}