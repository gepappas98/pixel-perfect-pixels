/** Research-only contracts. Never imported by trading/scoring/execution paths. */
export type Cohort = "Legacy" | "V2" | "V3" | "Unknown";
export type KnowledgeStatus = "candidate" | "validated" | "invalidated";
export type EvidenceRole = "entry_context" | "outcome" | "observation";
export interface Evidence {
  id: string;
  source_table: string;
  source_id: string;
  observed_at: string;
  available_at: string | null;
  captured_at: string;
  fingerprint: string;
  role: EvidenceRole;
  summary: string;
  symbol?: string | null;
}
export interface ResearchCase {
  id: string;
  source_table: string;
  source_id: string;
  symbol: string;
  strategy: string;
  cohort: Cohort;
  scorer_version: string;
  fingerprint: string | null;
  entry_at: string;
  resolved_at: string | null;
  maturity_at: string | null;
  outcome: string;
  net_pnl: number | null;
  pnl_unit: "USD" | "percent";
  close_reason: string | null;
  regime: string | null;
  evidence_ids: string[];
}
export interface Finding {
  id: string;
  title: string;
  statement: string;
  status: KnowledgeStatus;
  confidence: number;
  cohort: Cohort;
  scorer_version: string;
  sample_size: number;
  evidence_ids: string[];
  case_ids: string[];
  checked_at: string;
  limitations: string;
  reproduction: string;
}
export function cohortOf(fingerprint: string | null): Cohort {
  if (!fingerprint) return "Unknown";
  if (fingerprint.startsWith("v3|")) return "V3";
  if (fingerprint.startsWith("v2|")) return "V2";
  if (/^v\d+\|/.test(fingerprint)) return "Unknown";
  return "Legacy";
}
const time = (value: string | null) => value ? Date.parse(value) : NaN;
export function eligibleEntryEvidence(e: Evidence, entryAt: string): boolean {
  const entry = time(entryAt);
  const observed = time(e.observed_at);
  const available = time(e.available_at);
  return e.role === "entry_context" && Boolean(e.source_table && e.source_id && e.fingerprint)
    && Number.isFinite(entry) && Number.isFinite(observed) && Number.isFinite(available)
    && observed <= available && available <= entry;
}
export function isEvaluated(c: ResearchCase, now: string): boolean {
  const resolved = time(c.resolved_at);
  const entry = time(c.entry_at);
  const clock = time(now);
  if (!["win", "loss", "expired", "closed", "breakeven"].includes(c.outcome.toLowerCase())) return false;
  if (!Number.isFinite(entry) || !Number.isFinite(resolved) || !Number.isFinite(clock)
    || resolved < entry || resolved > clock || c.net_pnl === null || !Number.isFinite(c.net_pnl)) return false;
  // V3 requires an explicit maturity contract; never infer maturity from terminal text alone.
  if (c.cohort === "V3" && (!Number.isFinite(time(c.maturity_at)) || time(c.maturity_at) > clock)) return false;
  return true;
}
export function entryEvidenceIdsForCase(
  c: ResearchCase,
  evidence: Evidence[],
  linkedSignalId: string | null = null,
  windowMs = 15 * 60 * 1000,
): string[] {
  const entry = time(c.entry_at);
  return evidence.filter(e => {
    if (!eligibleEntryEvidence(e, c.entry_at)) return false;
    if ((c.source_table === "strategy_variant_signals" || c.source_table === "trades")
      && e.source_table === c.source_table && e.source_id === c.source_id) return true;
    if (linkedSignalId && e.source_table === "composite_signals" && e.source_id === linkedSignalId) return true;
    const observed = time(e.observed_at);
    if (!Number.isFinite(entry) || !Number.isFinite(observed) || observed > entry || entry - observed > windowMs) return false;
    if (e.symbol && e.symbol === c.symbol) return true;
    return !e.symbol && ["whale_flow_snapshots", "whale_flow_transition_context"].includes(e.source_table);
  }).map(e => e.id);
}

export function caseKey(c: ResearchCase): string {
  return JSON.stringify([c.source_table, c.source_id, c.cohort, c.scorer_version]);
}
export function dedupeCases(cases: ResearchCase[]): ResearchCase[] {
  return [...new Map(cases.map(c => [caseKey(c), c])).values()];
}
export function validateFinding(f: Finding, cases: ResearchCase[], evidence: Evidence[], now: string): string[] {
  const errors: string[] = [];
  const selected = dedupeCases(cases.filter(c => f.case_ids.includes(c.id)));
  const sources = evidence.filter(e => f.evidence_ids.includes(e.id));
  if (!f.title || !f.statement || !f.limitations || !f.reproduction || !Number.isFinite(time(f.checked_at))
    || time(f.checked_at) > time(now)) errors.push("missing_reproducibility");
  if (!Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) errors.push("invalid_confidence");
  if (!Number.isInteger(f.sample_size) || f.sample_size < 1 || selected.length !== f.sample_size
    || new Set(f.case_ids).size !== f.sample_size) errors.push("sample_mismatch");
  if (sources.length !== new Set(f.evidence_ids).size || !sources.length) errors.push("missing_evidence");
  if (selected.some(c => c.cohort !== f.cohort || c.scorer_version !== f.scorer_version)
    || f.cohort === "Unknown" || !f.scorer_version || f.scorer_version === "unknown") errors.push("cohort_or_version_mismatch");
  if (f.status === "validated" && selected.some(c => !isEvaluated(c, now))) errors.push("unresolved_cases");
  if (selected.some(c => !sources.some(e => c.evidence_ids.includes(e.id) && eligibleEntryEvidence(e, c.entry_at)))) errors.push("missing_point_in_time_evidence");
  return errors;
}
/** Capture acknowledgement must match every current source fingerprint, not just a row count. */
export function archiveReady(required: Array<{ source_id: string; fingerprint: string }>, captured: Array<{ source_id: string; fingerprint: string }>, captureSucceeded: boolean): boolean {
  if (!captureSucceeded) return false;
  const keys = new Set(captured.map(r => JSON.stringify([r.source_id, r.fingerprint])));
  return required.every(r => Boolean(r.source_id && r.fingerprint) && keys.has(JSON.stringify([r.source_id, r.fingerprint])));
}
export interface KnowledgeSnapshot {
  checked_at: string;
  cases: ResearchCase[];
  evidence: Evidence[];
  findings: Finding[];
  lessons: Array<{ id: string; source_trade_id: string | null; symbol: string; created_at: string; provenance: "linked" | "orphan" | "unresolved" }>;
  counts: Record<string, number | null>;
  issues: string[];
  archival: "unverified";
  bounded: boolean;
}