# Read-only MCP Diagnostic endpoint

- **Endpoint path:** `POST /api/public/mcp-diagnostic`
  (live: `https://aicombined-trading-command-center.lovable.app/api/public/mcp-diagnostic`)
- **Protocol:** MCP over HTTP (JSON-RPC 2.0, JSON responses). Methods: `initialize`, `ping`, `tools/list`, `tools/call`.
- **Required env var / secret:** `MCP_DIAGNOSTIC_TOKEN` (min 16 chars). Header: `Authorization: Bearer <token>`.
- **Read-only:** all DB access goes through `readOnlyDb` (SELECT on whitelisted tables + read-only RPCs `get_portfolio_summary`, `get_variant_performance`). No writes, no trading.

Tools: `get_diagnostic_snapshot`, `get_pipeline_runs`, `get_execution_audit`, `get_eligible_signals`, `get_execution_gap`, `get_trade_state`, `get_variant_state`. Optional args: `window_minutes`, `limit`, `min_confidence`, `symbol`, `run_id`.
Every response includes `source` (app, project id, backend URL/ref, `read_only: true`, `generated_at`).
Coverage is signal-level; seed events (`details.audit_seed === true`) are reported separately and never counted as real accepts.

## Validation
```
bunx vitest run src/lib/_tests_/mcp-diagnostic.test.ts
bunx tsgo --noEmit
```

## Test call
```
curl -s -X POST "$URL/api/public/mcp-diagnostic" -H "Authorization: Bearer $MCP_DIAGNOSTIC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_diagnostic_snapshot","arguments":{"window_minutes":15}}}'
```

## Deploy (Lovable only, no Vercel)
One step: in Lovable click **Publish → Update** (or tell the Lovable agent: "publish").
