export type AuditCategory =
  | "confirmed_bug"
  | "research_comparability"
  | "needs_recheck"
  | "verified_ok";

export interface AuditFinding {
  category: AuditCategory;
  title: string;
  detail: string;
}

export interface AuditReport {
  id?: string;
  created_at?: string;
  checked_at: string;
  title: string;
  severity: "info" | "warning" | "critical";
  status: string;
  summary: string;
  findings: AuditFinding[];
  source: string;
  window_label: string | null;
}

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  confirmed_bug: "Confirmed bugs",
  research_comparability: "Research comparability issues",
  needs_recheck: "Needs re-check",
  verified_ok: "Checked — no issue found",
};

export const STALE_AFTER_HOURS = 24;

export function auditAgeHours(checkedAt: string, now = Date.now()): number {
  const t = Date.parse(checkedAt);
  return Number.isFinite(t) ? (now - t) / 3_600_000 : Infinity;
}

export function isAuditStale(checkedAt: string, now = Date.now()): boolean {
  return auditAgeHours(checkedAt, now) > STALE_AFTER_HOURS;
}

export function groupFindings(findings: AuditFinding[]) {
  const order: AuditCategory[] = [
    "confirmed_bug",
    "research_comparability",
    "needs_recheck",
    "verified_ok",
  ];
  return order
    .map((c) => ({ category: c, items: findings.filter((f) => f.category === c) }))
    .filter((g) => g.items.length > 0);
}
