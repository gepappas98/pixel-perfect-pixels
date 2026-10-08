import { createFileRoute } from "@tanstack/react-router";

// READ-ONLY MCP endpoint. Public path (bypasses site auth) but every request
// must carry `Authorization: Bearer <MCP_DIAGNOSTIC_TOKEN>`.
export const Route = createFileRoute("/api/public/mcp-diagnostic")({
  server: {
    handlers: {
      GET: async () =>
        new Response("Method Not Allowed: use POST (JSON-RPC)", { status: 405, headers: { Allow: "POST" } }),
      POST: async ({ request }) => {
        const m = await import("@/lib/mcp-diagnostic.server");
        if (!m.verifyBearer(request.headers.get("authorization"), process.env["MCP_DIAGNOSTIC_TOKEN"])) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const raw = await request.text();
        if (raw.length > 100_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = m.readOnlyDb(supabaseAdmin as any);
        const msgs = Array.isArray(body) ? body.slice(0, 20) : [body];
        const out = (await Promise.all(msgs.map((x) => m.handleRpc(x as never, db)))).filter(Boolean);
        if (out.length === 0) return new Response(null, { status: 202 });
        return Response.json(Array.isArray(body) ? out : out[0]);
      },
    },
  },
});
