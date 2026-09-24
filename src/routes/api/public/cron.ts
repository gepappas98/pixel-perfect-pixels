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
        const startedAt = new Date().toISOString();
        const { runFullPipeline } = await import("@/lib/pipeline.server");
        try {
          const result = await runFullPipeline();
          await (supabaseAdmin.from as any)("pipeline_runs").insert({
            status: "success",
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            result,
          });
          return Response.json({ ok: true, result });
        } catch (error) {
          await (supabaseAdmin.from as any)("pipeline_runs").insert({
            status: "failure",
            started_at: startedAt,
            completed_at: new Date().toISOString(),
            error_message: error instanceof Error ? error.message : "Unknown pipeline error",
          });
          throw error;
        }
      },
    },
  },
});
