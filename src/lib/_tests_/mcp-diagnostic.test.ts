import { describe, it, expect, vi } from "vitest";
import { readOnlyDb, verifyBearer, handleRpc, analyzeAudits, TOOLS } from "../mcp-diagnostic.server";

function fakeClient() {
  const builder: any = new Proxy({}, {
    get: (_t, p) => (p === "then" ? (r: any) => r({ data: [], error: null }) : () => builder),
  });
  const table = { select: vi.fn(() => builder), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() };
  return { client: { from: vi.fn(() => table), rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) }, table };
}

describe("mcp diagnostic auth", () => {
  const tok = "x".repeat(32);
  it("rejects missing/short/wrong tokens", () => {
    expect(verifyBearer(null, tok)).toBe(false);
    expect(verifyBearer(`Bearer ${tok}`, undefined)).toBe(false);
    expect(verifyBearer("Bearer short", "short")).toBe(false);
    expect(verifyBearer(`Bearer ${"y".repeat(32)}`, tok)).toBe(false);
    expect(verifyBearer(`Bearer ${tok}`, tok)).toBe(true);
  });
});

describe("read-only guard", () => {
  it("blocks non-whitelisted tables and rpcs, exposes only select", () => {
    const { client } = fakeClient();
    const db = readOnlyDb(client);
    expect(() => db.select("whale_alerts")).toThrow(/read_only_guard/);
    expect(() => db.rpc("reconcile_stuck_pipeline_runs")).toThrow(/read_only_guard/);
    expect(Object.keys(db).sort()).toEqual(["rpc", "select"]);
  });
  it("all tools never call insert/update/delete/upsert", async () => {
    const { client, table } = fakeClient();
    const db = readOnlyDb(client);
    for (const t of Object.values(TOOLS)) await t.run(db, {});
    expect(table.insert).not.toHaveBeenCalled();
    expect(table.update).not.toHaveBeenCalled();
    expect(table.delete).not.toHaveBeenCalled();
    expect(table.upsert).not.toHaveBeenCalled();
  });
});

describe("signal-level audit with seeds", () => {
  it("separates seed and non-seed events", () => {
    const r = analyzeAudits([{ run: { id: "r1" }, audit: { events: [
      { signal_id: "a", symbol: "BTC", stage: "CANDIDATE_FILTER", decision: "ACCEPT", details: { audit_seed: true } },
      { signal_id: "b", symbol: "ETH", stage: "CANDIDATE_FILTER", decision: "ACCEPT", details: {} },
    ] } }]);
    expect(r.counts.seed_events).toBe(1);
    expect(r.counts.non_seed_events).toBe(1);
    expect(r.counts.real_candidate_accepts).toBe(1);
    expect(r.auditedSignalIds.has("a")).toBe(true);
    expect(r.realSignalIds.has("a")).toBe(false);
  });
});

describe("json-rpc", () => {
  const db = readOnlyDb(fakeClient().client);
  it("initialize + tools/list", async () => {
    const init: any = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, db);
    expect(init.result.serverInfo.name).toBe("trading-diagnostic-readonly");
    const list: any = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, db);
    expect(list.result.tools).toHaveLength(7);
  });
  it("tools/call includes read_only source metadata", async () => {
    const res: any = await handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_execution_gap", arguments: {} } }, db);
    expect(res.result.structuredContent.source.read_only).toBe(true);
    expect(res.result.structuredContent.data.coverage_level).toBe("signal");
  });
  it("notifications get no response, unknown methods error", async () => {
    expect(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, db)).toBeNull();
    const r: any = await handleRpc({ jsonrpc: "2.0", id: 4, method: "x" }, db);
    expect(r.error.code).toBe(-32601);
  });
});
