/**
 * Pure attribution for the "Paper strategy results" panel.
 * Only real rows from `trades` (mode=paper) are counted. Shadow/variant
 * decisions are never trades and must never contribute PnL.
 */
export type AttributionTrade = {
  status: string | null;
  mode: string | null;
  net_pnl: number | null;
  pnl: number | null;
  entry_source: string | null;
  entry_metadata: Record<string, unknown> | null;
};

export const STRATEGIES = [
  { key: "cmc", label: "CMC Paper" },
  { key: "early", label: "Early Entry Regime (A)" },
  { key: "early_b", label: "Early Entry — B Reversal" },
  { key: "early_c", label: "Early Entry — C Adaptive" },
  { key: "event", label: "Event Flow Paper" },
  { key: "whale_shock", label: "Whale Shock Reversal" },
  { key: "standard", label: "Standard" },
] as const;

export type StrategyKey = (typeof STRATEGIES)[number]["key"];

export function strategyOf(trade: AttributionTrade): StrategyKey {
  const m = trade.entry_metadata;
  const metaStrategy = m && typeof m === "object" && !Array.isArray(m) ? m["strategy"] : undefined;
  const raw = String(metaStrategy ?? trade.entry_source ?? "").toLowerCase();
  const source = String(trade.entry_source ?? "").toLowerCase();
  if (source === "cmc_paper" || raw.includes("cmc-paper") || raw.includes("cmc_paper")) return "cmc";
  if (source === "early_entry_b_reversal" || raw.includes("early-entry-b-reversal")) return "early_b";
  if (source === "early_entry_c_adaptive" || raw.includes("early-entry-c-adaptive")) return "early_c";
  if (source === "early_entry_regime" || raw.includes("early-entry-regime")) return "early";
  if (source === "event_flow_paper" || raw.includes("event_flow") || raw.includes("event-flow")) return "event";
  if (source === "whale_shock" || raw.includes("whale-shock")) return "whale_shock";
  return "standard";
}

/** Realized net PnL (after fees). Closed rows only; open rows contribute 0. */
export function realizedNet(trade: AttributionTrade): number {
  if (trade.status !== "closed") return 0;
  const v = Number(trade.net_pnl ?? trade.pnl ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export type StrategyState = "has_closed" | "open_only" | "no_entries";

export interface StrategyResult {
  key: StrategyKey;
  label: string;
  closed: number;
  open: number;
  pnl: number;
  wins: number;
  state: StrategyState;
}

export function summarizeStrategies(rows: AttributionTrade[]): StrategyResult[] {
  const paper = rows.filter((r) => r.mode === "paper");
  return STRATEGIES.map((s) => {
    const mine = paper.filter((t) => strategyOf(t) === s.key);
    const closedRows = mine.filter((t) => t.status === "closed");
    const open = mine.filter((t) => t.status === "open").length;
    const pnl = closedRows.reduce((sum, t) => sum + realizedNet(t), 0);
    const wins = closedRows.filter((t) => realizedNet(t) > 0).length;
    const state: StrategyState =
      closedRows.length > 0 ? "has_closed" : open > 0 ? "open_only" : "no_entries";
    return { key: s.key, label: s.label, closed: closedRows.length, open, pnl, wins, state };
  });
}

/** Shadow decision tallies (early_entry_variant_decisions). Never PnL. */
export interface ShadowTally {
  variant: string;
  paperOpenLinked: number;
  noEntry: number;
  eligibleNoAsset: number;
}

export function tallyShadowDecisions(
  rows: Array<{ variant: string | null; decision: string | null; trade_id: string | null }>,
): ShadowTally[] {
  const map = new Map<string, ShadowTally>();
  for (const r of rows) {
    const v = String(r.variant ?? "");
    if (!v) continue;
    const t = map.get(v) ?? { variant: v, paperOpenLinked: 0, noEntry: 0, eligibleNoAsset: 0 };
    if (r.decision === "PAPER_OPEN" && r.trade_id) t.paperOpenLinked++;
    else if (r.decision === "NO_ENTRY") t.noEntry++;
    else if (r.decision === "ELIGIBLE_NO_ASSET") t.eligibleNoAsset++;
    map.set(v, t);
  }
  return [...map.values()];
}
