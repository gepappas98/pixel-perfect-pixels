import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { exportTxtReport, type DiagnosticReportLike } from "@/lib/export-txt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const pnl = (r: Row) => Number(r.net_pnl ?? r.gross_pnl ?? r.pnl ?? 0);

/* ============================================================
 * EXECUTION HEALTH DIAGNOSTIC TYPES
 * ============================================================ */

type ExecutionStatus = "ok" | "warning" | "critical";

type ExecutionHealth = {
  status: ExecutionStatus;
  buy_signals: number;
  eligible_buy_signals: number;
  audited_eligible_signals: number;
  uncovered_eligible_signals: number;
  uncovered_symbols: string[];
  risk_candidates: number | null;
  ai_risk_allowed: number | null;
  ai_risk_blocked: number | null;
  opened_trades: number;
  execution_audit_runs: number;
  total_audit_events: number;
  seed_events: number;
  execution_audit_coverage_pct: number;
  issue: string | null;
};

type Anomaly = {
  severity: "info" | "warning" | "critical";
  code: string;
  title: string;
  description: string;
};

type SuggestedAction = {
  priority: string;
  action: string;
  reason: string;
  evidence: string[];
};

type NewBuyAlert = {
  id: string;
  symbol: string;
  confidence: number;
  created_at: string;
};

/**
 * Must match executeTrades() executable-signal window.
 * 15 minutes = 0.25 hours.
 */
const EXECUTION_WINDOW_HOURS = 0.25;
const EXECUTION_CONFIDENCE_THRESHOLD = 0.6;

/* ============================================================
 * SOUND ALERT CONFIG
 * ============================================================ */

const SEEN_BUY_IDS_KEY = "ai_report_seen_buy_signal_ids_v1";
const SOUND_ENABLED_KEY = "ai_report_sound_enabled_v1";
const POLL_INTERVAL_MS = 60_000;
const MAX_SEEN_IDS = 500;

function loadSeenBuyIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_BUY_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((x): x is string => typeof x === "string"),
    );
  } catch {
    return new Set();
  }
}

function saveSeenBuyIds(ids: Set<string>): void {
  try {
    // Keep only the most recent N to avoid unbounded growth.
    const arr = [...ids].slice(-MAX_SEEN_IDS);
    localStorage.setItem(SEEN_BUY_IDS_KEY, JSON.stringify(arr));
  } catch {
    // Ignore quota / private-mode errors.
  }
}

function loadSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveSoundEnabled(value: boolean): void {
  try {
    localStorage.setItem(SOUND_ENABLED_KEY, value ? "true" : "false");
  } catch {
    // ignore
  }
}

export default function AIReport() {
  const [report, setReport] = useState<DiagnosticReportLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  // ── Sound alert state ──
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() =>
    loadSoundEnabled(),
  );
  const [newBuys, setNewBuys] = useState<NewBuyAlert[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const seenBuyIdsRef = useRef<Set<string>>(loadSeenBuyIds());
  const primedRef = useRef<boolean>(false);
  const soundEnabledRef = useRef<boolean>(soundEnabled);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  /* ============================================================
   * SOUND PLAYBACK — Web Audio API beep
   * Two-tone chime: 880 Hz then 1320 Hz.
   * ============================================================ */
  const playBuyAlert = useCallback(() => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) {
        console.warn("[AIReport] AudioContext not supported");
        return;
      }

      if (!audioCtxRef.current) {
        audioCtxRef.current = new Ctor();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);

        const t0 = ctx.currentTime + start;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

        osc.start(t0);
        osc.stop(t0 + duration + 0.05);
      };

      playTone(880, 0, 0.18);
      playTone(1320, 0.20, 0.32);
    } catch (e) {
      console.warn("[AIReport] sound playback failed:", e);
    }
  }, []);

  /* ============================================================
   * SOUND TOGGLE — must run inside a user gesture to unlock AudioContext
   * ============================================================ */
  const handleToggleSound = useCallback(() => {
    setSoundEnabled((prev) => {
      const next = !prev;

      // Create / unlock AudioContext synchronously inside the click handler.
      if (next) {
        try {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (Ctor) {
            if (!audioCtxRef.current) audioCtxRef.current = new Ctor();
            if (audioCtxRef.current.state === "suspended") {
              void audioCtxRef.current.resume();
            }
            // Short confirmation beep so the user knows it's ON.
            const ctx = audioCtxRef.current;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = 660;
            osc.connect(gain);
            gain.connect(ctx.destination);
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(
              0.0001,
              ctx.currentTime + 0.15,
            );
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.2);
          }
        } catch (e) {
          console.warn("[AIReport] AudioContext unlock failed:", e);
        }
      }

      saveSoundEnabled(next);
      return next;
    });
  }, []);

  /* ============================================================
   * DISMISS BANNER
   * ============================================================ */
  const dismissNewBuys = useCallback(() => {
    setNewBuys([]);
  }, []);

  /* ============================================================
   * MAIN LOAD
   * ============================================================ */
  const load = useCallback(async () => {
    const started = Date.now();
    setLoading(true);
    setError(null);

    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();

      const [open, closed, variants, errors] = await Promise.all([
        supabase
          .from("trades")
          .select("*")
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("trades")
          .select("*")
          .eq("status", "closed")
          .order("closed_at", { ascending: false })
          .limit(100),
        supabase
          .from("strategy_variant_signals")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .limit(2000),
        supabase
          .from("pipeline_runs")
          .select("started_at, error_message, status")
          .eq("status", "error")
          .gte("started_at", since)
          .order("started_at", { ascending: false })
          .limit(30),
      ]);

      if (open.error) throw open.error;
      if (closed.error) throw closed.error;

      const openTrades = (open.data ?? []) as Row[];
      const closedTrades = (closed.data ?? []) as Row[];
      const variantRows = (variants.data ?? []) as Row[];
      const pipelineErrors = (errors.data ?? []) as Row[];

      const wins = closedTrades.filter((r) => pnl(r) > 0);
      const losses = closedTrades.filter((r) => pnl(r) < 0);

      const realized = closedTrades.reduce((s, r) => s + pnl(r), 0);
      const unrealized = openTrades.reduce((s, r) => s + pnl(r), 0);
      const grossLoss = Math.abs(losses.reduce((s, r) => s + pnl(r), 0));

      const bySymbol = new Map<
        string,
        { symbol: string; open: number; resolved: number; total: number }
      >();
      for (const row of variantRows) {
        const symbol = String(row.symbol ?? "unknown");
        const item =
          bySymbol.get(symbol) ?? { symbol, open: 0, resolved: 0, total: 0 };
        item.total++;
        if (row.outcome === "open") item.open++;
        else item.resolved++;
        bySymbol.set(symbol, item);
      }

      const issues: string[] = pipelineErrors.length
        ? [`${pipelineErrors.length} pipeline errors in the last 24 hours`]
        : [];

      /* ============================================================
       * EXECUTION HEALTH DIAGNOSTIC
       * ============================================================ */

      const executionSince = new Date(
        Date.now() - EXECUTION_WINDOW_HOURS * 60 * 60 * 1000,
      ).toISOString();

      // ── 1. BUY signals in window ──────────────────────────────
      const { data: recentSignals, error: signalsError } = await supabase
        .from("composite_signals")
        .select("id,symbol,recommendation,confidence,created_at")
        .eq("recommendation", "buy")
        .gte("created_at", executionSince)
        .order("created_at", { ascending: false });

      if (signalsError) {
        console.warn(
          "[AI_DIAGNOSTIC] execution signal query failed:",
          signalsError.message,
        );
      }

      const buySignals = (recentSignals ?? []) as Row[];

      // ── 2. Pipeline execution audits in window ───────────────
      const { data: recentRuns, error: runsError } = await supabase
        .from("pipeline_runs")
        .select("id,started_at,status,result")
        .gte("started_at", executionSince)
        .order("started_at", { ascending: false })
        .limit(500);

      if (runsError) {
        console.warn(
          "[AI_DIAGNOSTIC] pipeline run query failed:",
          runsError.message,
        );
      }

      const runs = (recentRuns ?? []) as Row[];

      const auditedRuns = runs.filter(
        (run) =>
          run.result &&
          typeof run.result === "object" &&
          (run.result as Record<string, unknown>)["execution_audit"],
      );

      const executionAudits = auditedRuns
        .map((run) => ({
          run,
          audit: (run.result as Record<string, unknown>)["execution_audit"] as
            | Record<string, unknown>
            | undefined,
        }))
        .filter((x) => x.audit);

      // ── 3. Grace period: latest audit run timestamp ──────────
      const latestAuditStartedAt = auditedRuns.reduce((max, run) => {
        const t = new Date(String(run.started_at ?? 0)).getTime();
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);

      // ── 4. Eligible BUY signals (conf + grace period) ────────
      const eligibleBuySignals = buySignals.filter((s) => {
        if (Number(s.confidence ?? 0) < EXECUTION_CONFIDENCE_THRESHOLD) {
          return false;
        }
        if (latestAuditStartedAt > 0) {
          const t = new Date(String(s.created_at ?? 0)).getTime();
          if (Number.isFinite(t) && t > latestAuditStartedAt) return false;
        }
        return true;
      });

      /* ============================================================
       * NEW BUY DETECTION + SOUND ALERT
       *
       * On the very first load after mount we prime the seen-set
       * with all current IDs (no sound). On subsequent loads we
       * alert only for IDs we have never seen before.
       * ============================================================ */
      const seenIds = seenBuyIdsRef.current;
      const currentIds = new Set(
        eligibleBuySignals.map((s) => String(s.id ?? "")).filter(Boolean),
      );

      if (!primedRef.current) {
        for (const id of currentIds) seenIds.add(id);
        saveSeenBuyIds(seenIds);
        primedRef.current = true;
      } else {
        const newlyEligible = eligibleBuySignals.filter(
          (s) => !seenIds.has(String(s.id ?? "")),
        );

        if (newlyEligible.length > 0) {
          const alerts: NewBuyAlert[] = newlyEligible.map((s) => ({
            id: String(s.id ?? ""),
            symbol: String(s.symbol ?? "UNKNOWN"),
            confidence: Number(s.confidence ?? 0),
            created_at: String(s.created_at ?? ""),
          }));

          console.log(
            "[AIReport] NEW ELIGIBLE BUY:",
            alerts.map((a) => `${a.symbol}@${a.confidence.toFixed(3)}`).join(", "),
          );

          setNewBuys((prev) => {
            // Merge with any existing undismissed alerts, dedupe by id.
            const merged = new Map<string, NewBuyAlert>();
            for (const b of prev) merged.set(b.id, b);
            for (const b of alerts) merged.set(b.id, b);
            return [...merged.values()];
          });

          if (soundEnabledRef.current) {
            playBuyAlert();
          }
        }

        for (const id of currentIds) seenIds.add(id);
        saveSeenBuyIds(seenIds);
      }

      // ── 5. Extract signal IDs + aggregate audit events ───────
      const auditedSignalIds = new Set<string>();
      const uncoveredCandidates = new Map<string, string>();

      let riskCandidates = 0;
      let aiRiskAllowed = 0;
      let aiRiskBlocked = 0;
      let openedFromAudit = 0;
      let totalAuditEvents = 0;
      let seedEvents = 0;

      for (const { audit } of executionAudits) {
        const summary = (audit?.["summary"] ?? {}) as Record<string, unknown>;
        openedFromAudit += Number(summary["opened"] ?? 0);

        const events = (audit?.["events"] ?? []) as Array<
          Record<string, unknown>
        >;
        totalAuditEvents += events.length;

        for (const ev of events) {
          const sid = ev["signal_id"];
          if (typeof sid === "string" && sid.length > 0) {
            auditedSignalIds.add(sid);
          }

          const details = (ev["details"] ?? {}) as Record<string, unknown>;
          const isSeed = details["audit_seed"] === true;

          if (isSeed) {
            seedEvents++;
            continue;
          }

          const stage = String(ev["stage"] ?? "");
          const decision = String(ev["decision"] ?? "");

          if (stage === "CANDIDATE_FILTER" && decision === "ACCEPT") {
            riskCandidates++;
          }
          if (stage === "AI_RISK" && decision === "ACCEPT") {
            aiRiskAllowed++;
          }
          if (stage === "AI_RISK" && decision === "REJECT") {
            aiRiskBlocked++;
          }
        }
      }

      // ── 6. Signal-level coverage ─────────────────────────────
      let auditedEligibleSignals = 0;
      for (const sig of eligibleBuySignals) {
        const id = String(sig.id ?? "");
        if (id && auditedSignalIds.has(id)) {
          auditedEligibleSignals++;
        } else if (id) {
          uncoveredCandidates.set(id, String(sig.symbol ?? "unknown"));
        }
      }

      const uncoveredEligibleSignals = Math.max(
        0,
        eligibleBuySignals.length - auditedEligibleSignals,
      );

      const uncoveredSymbols = [
        ...new Set(uncoveredCandidates.values()),
      ].slice(0, 10);

      const executionAuditCoveragePct =
        eligibleBuySignals.length === 0
          ? 100
          : Math.min(
              100,
              Math.round(
                (auditedEligibleSignals / eligibleBuySignals.length) * 100,
              ),
            );

      // ── 7. Real trades opened in same period ─────────────────
      // trades has no opened_at column; created_at is the real open timestamp.
      const { data: recentTrades, error: tradesError } = await supabase
        .from("trades")
        .select("id,symbol,side,status,created_at")
        .eq("side", "buy")
        .gte("created_at", executionSince);

      if (tradesError) {
        console.warn("[AI_DIAGNOSTIC] trade query failed:", tradesError.message);
      }

      // Every row returned was opened (created) inside the window.
      const openedTrades = ((recentTrades ?? []) as Row[]).length;

      // ── 8. Determine execution health ────────────────────────
      let executionStatus: ExecutionStatus = "ok";
      let executionIssue: string | null = null;

      // No eligible BUY is an absence of an executable opportunity, not
      // proof that the execution path is healthy. An audit row alone is
      // also insufficient: if it contains no real execution events, the
      // execution path was not actually exercised.
      const executionPathExercised = executionAudits.some(({ audit }) => {
        const summary = (audit?.["summary"] ?? {}) as Record<string, unknown>;
        const events = (audit?.["events"] ?? []) as Array<Record<string, unknown>>;
        const hasEligible = Number(summary["eligible_buy_signals"] ?? 0) > 0;
        const hasRealEvent = events.some(
          (event) =>
            ((event["details"] ?? {}) as Record<string, unknown>)["audit_seed"] !== true,
        );
        return hasEligible || hasRealEvent;
      });

      if (eligibleBuySignals.length === 0 && !executionPathExercised) {
        executionStatus = "warning";
        executionIssue =
          "No eligible BUY signals were present in the execution window; " +
          "the execution audit ran but the execution path was not exercised, " +
          "so execution health cannot be proven from this window.";
      } else if (eligibleBuySignals.length > 0 && executionAuditCoveragePct < 100) {
        executionStatus = "critical";
        executionIssue =
          `${uncoveredEligibleSignals} of ${eligibleBuySignals.length} ` +
          `eligible BUY signals never reached the execution audit ` +
          `(coverage ${executionAuditCoveragePct}%).` +
          (uncoveredSymbols.length > 0
            ? ` Uncovered symbols: ${uncoveredSymbols.join(", ")}.`
            : "");
      } else if (
        eligibleBuySignals.length > 0 &&
        openedTrades === 0 &&
        openedFromAudit === 0
      ) {
        executionStatus = "warning";
        executionIssue =
          "Eligible BUY signals exist but no paper trade was opened. " +
          "Check AI Risk, execution gates and trade INSERT.";
      } else if (
        aiRiskAllowed > 0 &&
        openedTrades === 0 &&
        openedFromAudit === 0
      ) {
        executionStatus = "critical";
        executionIssue =
          "AI Risk allowed one or more signals but execution opened zero trades.";
      }

      // ── 9. Build execution health object ─────────────────────
      const executionHealth: ExecutionHealth = {
        status: executionStatus,
        buy_signals: buySignals.length,
        eligible_buy_signals: eligibleBuySignals.length,
        audited_eligible_signals: auditedEligibleSignals,
        uncovered_eligible_signals: uncoveredEligibleSignals,
        uncovered_symbols: uncoveredSymbols,
        risk_candidates: executionAudits.length > 0 ? riskCandidates : null,
        ai_risk_allowed: executionAudits.length > 0 ? aiRiskAllowed : null,
        ai_risk_blocked: executionAudits.length > 0 ? aiRiskBlocked : null,
        opened_trades: openedTrades,
        execution_audit_runs: auditedRuns.length,
        total_audit_events: totalAuditEvents,
        seed_events: seedEvents,
        execution_audit_coverage_pct: executionAuditCoveragePct,
        issue: executionIssue,
      };

      console.log(
        "[AI_DIAGNOSTIC_EXECUTION]",
        JSON.stringify(executionHealth),
      );

      /* ============================================================
       * OVERALL HEALTH
       * ============================================================ */

      const databaseStatus: ExecutionStatus = "ok";
      const pipelineStatus: ExecutionStatus = issues.length ? "warning" : "ok";

      const subsystemStatuses: ExecutionStatus[] = [
        databaseStatus,
        pipelineStatus,
        executionHealth.status,
      ];

      const overall: ExecutionStatus = subsystemStatuses.includes("critical")
        ? "critical"
        : subsystemStatuses.includes("warning")
          ? "warning"
          : "ok";

      const overallScore =
        overall === "critical" ? 40 : overall === "warning" ? 70 : 100;

      /* ============================================================
       * ANOMALIES
       * ============================================================ */

      const anomalies: Anomaly[] = [];

      if (executionHealth.status === "critical") {
        anomalies.push({
          severity: "critical",
          code: "EXECUTION_AUDIT_OR_EXECUTION_FAILURE",
          title: "Execution path requires investigation",
          description:
            executionHealth.issue ??
            "Execution diagnostics detected an inconsistency.",
        });
      }

      if (
        executionHealth.status !== "critical" &&
        executionHealth.eligible_buy_signals > 0 &&
        executionHealth.opened_trades === 0
      ) {
        anomalies.push({
          severity: "warning",
          code: "ELIGIBLE_BUY_WITH_ZERO_TRADES",
          title: "Eligible BUY signals were not executed",
          description:
            `${executionHealth.eligible_buy_signals} BUY signals reached ` +
            `confidence >= ${EXECUTION_CONFIDENCE_THRESHOLD}, but ` +
            `no paper trade was opened.`,
        });
      }

      /* ============================================================
       * SUGGESTED ACTIONS
       * ============================================================ */

      const suggestedActions: SuggestedAction[] = [];

      for (const issue of issues) {
        suggestedActions.push({
          priority: "P0",
          action: "Review pipeline errors",
          reason: issue,
          evidence: pipelineErrors
            .slice(0, 3)
            .map((r) =>
              String(
                (r as Record<string, unknown>)["error_message"] ??
                  (r as Record<string, unknown>)["status"] ??
                  "error",
              ),
            ),
        });
      }

      if (executionHealth.status !== "ok") {
        const priority = executionHealth.status === "critical" ? "P0" : "P1";

        if (
          executionHealth.execution_audit_coverage_pct < 100 &&
          executionHealth.eligible_buy_signals > 0
        ) {
          suggestedActions.push({
            priority,
            action: "Investigate signal → audit gap",
            reason:
              `${executionHealth.uncovered_eligible_signals} eligible BUY signals ` +
              `did not appear in the execution audit. Signals may be dropped ` +
              `between composite_signals INSERT and executeTrades().`,
            evidence: [
              `eligible=${executionHealth.eligible_buy_signals}`,
              `audited=${executionHealth.audited_eligible_signals}`,
              `coverage=${executionHealth.execution_audit_coverage_pct}%`,
              ...(executionHealth.uncovered_symbols.length > 0
                ? [`symbols=${executionHealth.uncovered_symbols.join(",")}`]
                : []),
            ],
          });
        } else {
          suggestedActions.push({
            priority,
            action: "Inspect execution audit",
            reason:
              executionHealth.issue ??
              "Execution diagnostics flagged an issue.",
            evidence: [
              `eligible=${executionHealth.eligible_buy_signals}`,
              `opened=${executionHealth.opened_trades}`,
              `coverage=${executionHealth.execution_audit_coverage_pct}%`,
            ],
          });
        }
      }

      /* ============================================================
       * BUILD REPORT
       * ============================================================ */

      const reportRecord: Record<string, unknown> = {
        schema_version: "1.1",
        generated_at: new Date().toISOString(),
        duration_ms: Date.now() - started,

        health: {
          overall,
          score: overallScore,
          issues: [
            ...issues,
            ...(executionIssue ? [executionIssue] : []),
          ],

          subsystems: {
            database: {
              status: databaseStatus,
              note: `${openTrades.length} open trades loaded`,
            },
            pipeline: {
              status: pipelineStatus,
              note: `${pipelineErrors.length} recent errors`,
            },
            execution: {
              status: executionHealth.status,
              note:
                executionHealth.issue ??
                `${executionHealth.eligible_buy_signals} eligible BUY signals, ` +
                  `${executionHealth.opened_trades} trades opened`,
              metrics: executionHealth,
            },
          },
        },

        answers: {
          summary: {
            q: "What is the current system status?",
            a:
              executionHealth.status !== "ok"
                ? `System infrastructure is operational, but execution health is ` +
                  `not proven: ${executionHealth.issue ?? "diagnostic warning"}`
                : executionHealth.eligible_buy_signals > 0 &&
                    executionHealth.opened_trades === 0
                  ? `System infrastructure is operational, but ` +
                    `${executionHealth.eligible_buy_signals} eligible BUY ` +
                    `signals were detected and 0 trades were opened. ` +
                    `Execution requires investigation.`
                  : `${openTrades.length} open trades, ` +
                    `${closedTrades.length} closed trades, ` +
                    `${variantRows.length} recent variants.`,
            confidence: "high",
          },
          execution: {
            q: "Are eligible BUY signals being executed?",
            a:
              `${executionHealth.eligible_buy_signals} eligible BUY signals; ` +
              `${executionHealth.audited_eligible_signals} reached the execution ` +
              `audit; ${executionHealth.opened_trades} trades opened; ` +
              `coverage ${executionHealth.execution_audit_coverage_pct}%.`,
            confidence:
              executionHealth.execution_audit_coverage_pct === 100
                ? "high"
                : "medium",
          },
        },

        anomalies,

        data: {
          trades: {
            open_count: openTrades.length,
            closed_count: closedTrades.length,
            open: openTrades,
            recent_closed: closedTrades,
          },
          portfolio: {
            realized_pnl: +realized.toFixed(2),
            unrealized_pnl: +unrealized.toFixed(2),
            closed_count: closedTrades.length,
            win_count: wins.length,
            loss_count: losses.length,
            win_rate_pct: closedTrades.length
              ? +((wins.length / closedTrades.length) * 100).toFixed(2)
              : 0,
            profit_factor: grossLoss
              ? +(wins.reduce((s, r) => s + pnl(r), 0) / grossLoss).toFixed(3)
              : null,
          },
          variants: {
            open_count: variantRows.filter((r) => r.outcome === "open").length,
            total_count: variants.count ?? variantRows.length,
            resolved_count: variantRows.filter((r) => r.outcome !== "open")
              .length,
            by_symbol_top: [...bySymbol.values()]
              .sort((a, b) => b.total - a.total)
              .slice(0, 20),
          },
          pipeline: { recent_errors: pipelineErrors },
          symbols: { watched: [], blacklisted: [], with_live_price: [] },
        },

        suggested_actions: suggestedActions,

        narrative_md: "",

        ai_context: `
Trading Command Center diagnostic

Health: ${overall}
Realized PnL: ${realized.toFixed(2)}
Unrealized PnL: ${unrealized.toFixed(2)}

EXECUTION HEALTH
Status: ${executionHealth.status}
BUY signals (window): ${executionHealth.buy_signals}
Eligible BUY >= ${EXECUTION_CONFIDENCE_THRESHOLD}: ${executionHealth.eligible_buy_signals}
Signals reaching execution audit: ${executionHealth.audited_eligible_signals}
Uncovered eligible signals: ${executionHealth.uncovered_eligible_signals}${
          executionHealth.uncovered_symbols.length > 0
            ? ` (${executionHealth.uncovered_symbols.join(", ")})`
            : ""
        }
Signal-level audit coverage: ${executionHealth.execution_audit_coverage_pct}%
Risk candidates (CANDIDATE_FILTER ACCEPT, non-seed): ${executionHealth.risk_candidates ?? "unknown"}
AI Risk allowed: ${executionHealth.ai_risk_allowed ?? "unknown"}
AI Risk blocked: ${executionHealth.ai_risk_blocked ?? "unknown"}
Trades opened: ${executionHealth.opened_trades}
Runs with execution audit: ${executionHealth.execution_audit_runs}
Total audit events: ${executionHealth.total_audit_events}
Seed events (audit-seed only): ${executionHealth.seed_events}

Execution issue:
${executionHealth.issue ?? "none"}

Interpretation rules:
- Coverage is SIGNAL-LEVEL, not run-level.
- The window is 15 minutes to match executeTrades().
- Seed events (details.audit_seed === true) are diagnostic markers,
  NOT real candidate accepts.
- If coverage < 100% while eligible_buy_signals > 0, the execution
  pipeline is losing signals between composite_signals INSERT and
  executeTrades(). This is a critical observability failure.
- Do NOT report the system as fully healthy merely because the pipeline
  and database are operational.
`,
      };

      setReport(reportRecord as unknown as DiagnosticReportLike);
      setLastLoadedAt(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [playBuyAlert]);

  /* ============================================================
   * INITIAL LOAD + AUTO-POLL
   * ============================================================ */
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  /* ============================================================
   * CLEANUP AUDIOCONTEXT ON UNMOUNT
   * ============================================================ */
  useEffect(() => {
    return () => {
      try {
        if (audioCtxRef.current) {
          void audioCtxRef.current.close();
          audioCtxRef.current = null;
        }
      } catch {
        // ignore
      }
    };
  }, []);

  const handleDownload = useCallback(() => {
    if (!report) return;
    try {
      exportTxtReport(report);
    } catch (e) {
      console.error("[AIReport] exportTxtReport failed:", e);
    }
  }, [report]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {/* ───────── New BUY alert banner ───────── */}
      {newBuys.length > 0 && (
        <div className="sticky top-0 z-50 rounded border-2 border-green-600 bg-green-50 p-4 shadow-lg">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="text-lg font-bold text-green-800">
                🔔 New eligible BUY signal
                {newBuys.length > 1 ? `s (${newBuys.length})` : ""}
              </div>
              <ul className="mt-2 space-y-1 text-sm text-green-900">
                {newBuys.map((b) => (
                  <li key={b.id}>
                    <span className="font-mono font-semibold">{b.symbol}</span>{" "}
                    — confidence {(b.confidence * 100).toFixed(1)}%
                    {b.created_at && (
                      <span className="ml-2 text-xs text-green-700">
                        ({new Date(b.created_at).toLocaleTimeString()})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <button
              type="button"
              onClick={dismissNewBuys}
              className="rounded border border-green-700 bg-white px-3 py-1 text-sm font-medium text-green-800 hover:bg-green-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Trading Command Center</h1>
        <h2 className="text-xl font-medium">AI diagnostic report</h2>
        <p className="text-sm text-muted-foreground">
          Operational snapshot with portfolio, variants, errors, and raw JSON.
          Auto-refresh every {POLL_INTERVAL_MS / 1000}s.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded border px-3 py-1 text-sm"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!report}
            className="rounded border px-3 py-1 text-sm"
          >
            Download .txt
          </button>
          <button
            type="button"
            onClick={handleToggleSound}
            className={
              "rounded border px-3 py-1 text-sm font-medium " +
              (soundEnabled
                ? "border-green-600 bg-green-50 text-green-800"
                : "border-gray-300 bg-white text-gray-700")
            }
            title={
              soundEnabled
                ? "Sound is ON — you will hear a chime on new eligible BUY"
                : "Sound is OFF — click to enable"
            }
          >
            {soundEnabled ? "🔔 Sound: ON" : "🔕 Sound: OFF"}
          </button>
          {lastLoadedAt && (
            <span className="text-xs text-muted-foreground">
              Last update: {lastLoadedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-800">
          Unable to load report: {error}
        </div>
      )}

      {loading && !report && (
        <div className="text-sm text-muted-foreground">
          Loading diagnostic data…
        </div>
      )}

      {report && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                ["Health", report.health?.overall],
                ["Score", `${report.health?.score ?? 0}/100`],
                ["Open trades", report.data?.trades?.open_count ?? 0],
                [
                  "Realized PnL",
                  `$${report.data?.portfolio?.["realized_pnl"] ?? 0}`,
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded border p-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="text-lg font-semibold">{String(value)}</div>
              </div>
            ))}
          </div>

          <section className="space-y-2">
            <h3 className="text-lg font-medium">System findings</h3>
            {report.health?.issues?.length ? (
              <ul className="list-disc pl-5 text-sm">
                {report.health.issues.map((issue, i: number) => (
                  <li key={i}>{String(issue)}</li>
                ))}
              </ul>
            ) : (
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                <li>No current issues detected.</li>
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-medium">AI context</h3>
            <pre className="whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs">
              {report.ai_context}
            </pre>
          </section>

          <details className="rounded border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              View full JSON report
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
