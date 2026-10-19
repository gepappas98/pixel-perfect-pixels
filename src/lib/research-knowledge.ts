export type ResearchCohort =
  | "legacy"
  | "v2"
  | "v3"
  | "paper_trade"
  | "event_flow"
  | "early_entry"
  | "mixed"
  | "unknown";

export type ResearchFindingStatus = "candidate" | "validated" | "invalidated" | "needs_review";

export interface ResearchEvidenceInput {
  sourceTable: string;
  sourceId: string;
  fingerprint: string;
  observedAt?: string | null;
  knownAt?: string | null;
  role?: "support" | "counterexample" | "context" | "outcome" | "provenance";
  snippet?: string;
}

export interface ResearchFindingInput {
  fingerprint: string;
  title: string;
  summary: string;
  cohort: ResearchCohort;
  status: ResearchFindingStatus;
  sampleSize: number;
  confidence?: number | null;
  evidence: ResearchEvidenceInput[];
  limitations?: string;
}

const COHORTS = new Set<ResearchCohort>([
  "legacy", "v2", "v3", "paper_trade", "event_flow", "early_entry", "mixed", "unknown",
]);

export function cohortFromFingerprint(fingerprint: string | null | undefined): ResearchCohort {
  if (!fingerprint) return "legacy";
  if (fingerprint.startsWith("v3|")) return "v3";
  if (fingerprint.startsWith("v2|")) return "v2";
  return "legacy";
}

export function isResolvedOutcome(outcome: string | null | undefined): boolean {
  return outcome === "win" || outcome === "loss" || outcome === "expired";
}

export function isEvidenceAvailableAt(
  evidence: Pick<ResearchEvidenceInput, "observedAt" | "knownAt">,
  decisionAt: string,
): boolean {
  const decisionTime = Date.parse(decisionAt);
  if (!Number.isFinite(decisionTime)) return false;
  const knownTime = evidence.knownAt ? Date.parse(evidence.knownAt) : NaN;
  const observedTime = evidence.observedAt ? Date.parse(evidence.observedAt) : NaN;
  if (!Number.isFinite(knownTime) || !Number.isFinite(observedTime)) return false;
  return observedTime <= decisionTime && knownTime <= decisionTime;
}

export function validateResearchFinding(input: ResearchFindingInput): string[] {
  const errors: string[] = [];
  if (input.fingerprint.trim().length < 16 || input.fingerprint.length > 160) errors.push("fingerprint_invalid");
  if (!input.title.trim() || input.title.length > 180) errors.push("title_invalid");
  if (!input.summary.trim() || input.summary.length > 1500) errors.push("summary_invalid");
  if (!COHORTS.has(input.cohort)) errors.push("cohort_invalid");
  if (!["candidate", "validated", "invalidated", "needs_review"].includes(input.status)) errors.push("status_invalid");
  if (!Number.isInteger(input.sampleSize) || input.sampleSize < 0) errors.push("sample_size_invalid");
  if (input.confidence != null && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) errors.push("confidence_invalid");
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) errors.push("evidence_required");
  if (input.limitations && input.limitations.length > 1200) errors.push("limitations_too_long");
  for (const item of input.evidence ?? []) {
    if (!item.sourceTable.trim() || item.sourceTable.length > 80) errors.push("evidence_source_table_invalid");
    if (!item.sourceId.trim() || item.sourceId.length > 180) errors.push("evidence_source_id_invalid");
    if (item.fingerprint.trim().length < 16 || item.fingerprint.length > 200) errors.push("evidence_fingerprint_invalid");
    if (item.snippet && item.snippet.length > 500) errors.push("evidence_snippet_too_long");
  }
  return [...new Set(errors)];
}

export function dedupeEvidenceByFingerprint<T extends { fingerprint: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.fingerprint.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
