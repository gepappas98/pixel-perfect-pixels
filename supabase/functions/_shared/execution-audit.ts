export interface AuditSignal {
  id: unknown;
  confidence: unknown;
}

export interface AuditEvent {
  signal_id?: unknown;
}

/**
 * Count eligible BUY signals as audited by stable signal ID, not by the
 * optional confidence field on an audit event. Gate-rejection events may
 * legitimately omit confidence while still recording the signal decision.
 */
export function summarizeEligibleSignalAudit(
  signals: readonly AuditSignal[],
  events: readonly AuditEvent[],
  minConfidence: number,
): {
  eligible_buy_signals: number;
  audited_eligible_signals: number;
  uncovered_eligible_signals: number;
} {
  const eligibleSignals = signals.filter(
    (signal) => Number(signal.confidence) >= minConfidence,
  );
  const eligibleIds = new Set(
    eligibleSignals
      .map((signal) => String(signal.id ?? "").trim())
      .filter(Boolean),
  );
  const auditedIds = new Set(
    events
      .map((event) => String(event.signal_id ?? "").trim())
      .filter((id) => eligibleIds.has(id)),
  );

  // Signal IDs are primary keys; set counts avoid duplicate audit events
  // inflating coverage while preserving a conservative uncovered count.
  const eligibleCount = eligibleSignals.length;
  const auditedCount = Math.min(eligibleCount, auditedIds.size);
  return {
    eligible_buy_signals: eligibleCount,
    audited_eligible_signals: auditedCount,
    uncovered_eligible_signals: Math.max(0, eligibleCount - auditedCount),
  };
}
