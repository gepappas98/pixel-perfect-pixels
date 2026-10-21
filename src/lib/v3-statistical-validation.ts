export type V3OutcomeRow = {
  id: string;
  strategy_name: string | null;
  symbol: string | null;
  created_at: string;
  resolved_at: string | null;
  outcome: string | null;
  pnl_pct: number | string | null;
  source_fingerprint: string | null;
};

export type WilsonInterval = { low: number; high: number };
export type OutcomeMetrics = {
  n: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  wilson95Pct: WilsonInterval | null;
  meanPnlPct: number | null;
  medianPnlPct: number | null;
  profitFactor: number | null;
};

export type SymbolCycle = {
  key: string;
  symbol: string;
  cycle: string;
  outcome: "win" | "loss";
  pnlPct: number;
  createdAt: string;
  resolvedAt: string;
  strategies: string[];
  rawRows: number;
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function wilsonInterval(wins: number, n: number, z = 1.959963984540054): WilsonInterval | null {
  if (!Number.isInteger(wins) || !Number.isInteger(n) || n <= 0 || wins < 0 || wins > n || !Number.isFinite(z) || z <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;
  return { low: Math.max(0, (center - margin) * 100), high: Math.min(100, (center + margin) * 100) };
}

export function outcomeMetrics(rows: Array<{ outcome: string | null; pnl_pct: number | string | null }>): OutcomeMetrics {
  const resolved = rows.filter(row => ["win", "loss"].includes((row.outcome ?? "").toLowerCase()));
  const wins = resolved.filter(row => row.outcome?.toLowerCase() === "win").length;
  const losses = resolved.length - wins;
  const values = resolved.map(row => finite(row.pnl_pct)).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const positive = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const middle = Math.floor(values.length / 2);
  const median = values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null;
  return {
    n: resolved.length,
    wins,
    losses,
    winRatePct: resolved.length ? wins / resolved.length * 100 : null,
    wilson95Pct: wilsonInterval(wins, resolved.length),
    meanPnlPct: mean,
    medianPnlPct: median,
    profitFactor: negative > 0 ? positive / negative : positive > 0 ? null : null,
  };
}

export function cycleFromFingerprint(fingerprint: string | null): { symbol: string; cycle: string } | null {
  if (!fingerprint) return null;
  const parts = fingerprint.split("|");
  if (parts.length < 4 || parts[0] !== "v3" || !parts[2] || !parts[3]) return null;
  return { symbol: parts[2], cycle: parts.slice(3).join("|") };
}

export function dedupeSymbolCycles(rows: V3OutcomeRow[]): { units: SymbolCycle[]; invalidRows: number; conflictingUnits: number } {
  const groups = new Map<string, V3OutcomeRow[]>();
  let invalidRows = 0;
  for (const row of rows) {
    const outcome = (row.outcome ?? "").toLowerCase();
    const fingerprint = cycleFromFingerprint(row.source_fingerprint);
    const pnl = finite(row.pnl_pct);
    if (!fingerprint || !row.symbol || fingerprint.symbol !== row.symbol || !["win", "loss"].includes(outcome) || pnl === null || !row.resolved_at || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.resolved_at)) || Date.parse(row.resolved_at) < Date.parse(row.created_at)) {
      invalidRows++;
      continue;
    }
    const key = JSON.stringify([row.symbol, fingerprint.cycle]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const units: SymbolCycle[] = [];
  let conflictingUnits = 0;
  for (const [key, group] of groups) {
    const outcomes = new Set(group.map(row => (row.outcome ?? "").toLowerCase()));
    if (outcomes.size !== 1) { conflictingUnits++; continue; }
    const parsed = group.map(row => finite(row.pnl_pct) as number);
    units.push({
      key,
      symbol: group[0].symbol as string,
      cycle: (cycleFromFingerprint(group[0].source_fingerprint) as { cycle: string }).cycle,
      outcome: [...outcomes][0] as "win" | "loss",
      pnlPct: parsed.reduce((sum, value) => sum + value, 0) / parsed.length,
      createdAt: group.map(row => row.created_at).sort()[0],
      resolvedAt: group.map(row => row.resolved_at as string).sort().at(-1) as string,
      strategies: [...new Set(group.map(row => row.strategy_name ?? "unknown"))].sort(),
      rawRows: group.length,
    });
  }
  return { units, invalidRows, conflictingUnits };
}

export function chronologyIsValid(entryAt: string | null, featureAvailableAt: string | null): boolean {
  if (!entryAt || !featureAvailableAt) return false;
  const entry = Date.parse(entryAt);
  const available = Date.parse(featureAvailableAt);
  return Number.isFinite(entry) && Number.isFinite(available) && available <= entry;
}

export function feeAwareNetPnl(grossPnl: number | null, fees: number | null): number | null {
  if (grossPnl === null || fees === null || !Number.isFinite(grossPnl) || !Number.isFinite(fees) || fees < 0) return null;
  return grossPnl - fees;
}

export function chronologicalCohorts(units: SymbolCycle[]): Array<{ week: string; metrics: OutcomeMetrics }> {
  const cohorts = new Map<string, SymbolCycle[]>();
  for (const unit of units) {
    const date = new Date(unit.createdAt);
    if (!Number.isFinite(date.getTime())) continue;
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const weekday = day.getUTCDay();
    day.setUTCDate(day.getUTCDate() - ((weekday + 6) % 7));
    const week = day.toISOString().slice(0, 10);
    cohorts.set(week, [...(cohorts.get(week) ?? []), unit]);
  }
  return [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, rows]) => ({
    week,
    metrics: outcomeMetrics(rows.map(row => ({ outcome: row.outcome, pnl_pct: row.pnlPct }))),
  }));
}
