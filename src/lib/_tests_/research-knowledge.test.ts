import { describe, expect, it } from "vitest";
import {
  cohortFromFingerprint,
  dedupeEvidenceByFingerprint,
  isEvidenceAvailableAt,
  isResolvedOutcome,
  validateResearchFinding,
} from "../research-knowledge";

describe("research knowledge cohort boundaries", () => {
  it("keeps V3, V2 and legacy cohorts separate", () => {
    expect(cohortFromFingerprint("v3|mtf-weighted|x")).toBe("v3");
    expect(cohortFromFingerprint("v2|old-scorer|x")).toBe("v2");
    expect(cohortFromFingerprint("legacy-fingerprint")).toBe("legacy");
    expect(cohortFromFingerprint(null)).toBe("legacy");
  });

  it("does not count open or ambiguous outcomes as resolved", () => {
    expect(isResolvedOutcome("win")).toBe(true);
    expect(isResolvedOutcome("loss")).toBe(true);
    expect(isResolvedOutcome("expired")).toBe(true);
    expect(isResolvedOutcome("open")).toBe(false);
    expect(isResolvedOutcome("ambiguous")).toBe(false);
    expect(isResolvedOutcome(undefined)).toBe(false);
  });
});

describe("research knowledge evidence eligibility", () => {
  it("rejects evidence observed or known after the decision time", () => {
    const decisionAt = "2026-10-20T12:00:00.000Z";
    expect(isEvidenceAvailableAt({
      observedAt: "2026-10-20T11:00:00.000Z",
      knownAt: "2026-10-20T11:05:00.000Z",
    }, decisionAt)).toBe(true);
    expect(isEvidenceAvailableAt({
      observedAt: "2026-10-20T12:05:00.000Z",
      knownAt: "2026-10-20T12:05:00.000Z",
    }, decisionAt)).toBe(false);
    expect(isEvidenceAvailableAt({
      observedAt: "2026-10-20T11:00:00.000Z",
      knownAt: "2026-10-20T12:01:00.000Z",
    }, decisionAt)).toBe(false);
    expect(isEvidenceAvailableAt({ observedAt: null, knownAt: null }, decisionAt)).toBe(false);
  });

  it("requires at least one evidence reference before accepting a finding", () => {
    const base = {
      fingerprint: "research-fingerprint-0001",
      title: "Example hypothesis",
      summary: "A test summary backed by an explicit source reference.",
      cohort: "v3" as const,
      status: "candidate" as const,
      sampleSize: 0,
      evidence: [],
    };
    expect(validateResearchFinding(base)).toContain("evidence_required");
    expect(validateResearchFinding({
      ...base,
      evidence: [{
        sourceTable: "strategy_variant_signals",
        sourceId: "variant-id-1",
        fingerprint: "evidence-fingerprint-0001",
        observedAt: "2026-10-20T10:00:00.000Z",
        knownAt: "2026-10-20T10:00:01.000Z",
      }],
    })).toEqual([]);
  });

  it("deduplicates evidence by fingerprint without changing first-seen order", () => {
    const input = [
      { fingerprint: "a", value: 1 },
      { fingerprint: "a", value: 2 },
      { fingerprint: "b", value: 3 },
      { fingerprint: " ", value: 4 },
    ];
    expect(dedupeEvidenceByFingerprint(input)).toEqual([
      { fingerprint: "a", value: 1 },
      { fingerprint: "b", value: 3 },
    ]);
  });
});
