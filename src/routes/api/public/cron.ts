import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = request.headers.get("x-cron-secret") ?? "";
        if (!secret || secret.length > 200) return new Response("Unauthorized", { status: 401 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: ok } = await (supabaseAdmin.rpc as any)("verify_cron_secret", { _secret: secret });
        if (ok !== true) return new Response("Unauthorized", { status: 401 });
        const { runFullPipeline } = await import("@/lib/pipeline.server");
        const result = await runFullPipeline();
        return Response.json({ ok: true, result });
      },
    },
  },
});
