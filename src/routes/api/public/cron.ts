import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/cron")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = request.headers.get("x-cron-secret") ?? "";
        if (!secret || secret.length > 200)
          return new Response("Unauthorized", { status: 401 });

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data: ok } = await (supabaseAdmin.rpc as any)(
          "verify_cron_secret",
          { _secret: secret },
        );
        if (ok !== true) return new Response("Unauthorized", { status: 401 });

        // The application-hosted cron route is intentionally disabled.
        // Canonical production execution is owned exclusively by the
        // Supabase trading-pipeline-orchestrator. Keeping this route as a
        // second executor can create duplicate composite/variant data.
        console.warn("[cron] legacy application pipeline route disabled; canonical orchestrator is the only pipeline owner");

        return Response.json(
          {
            ok: false,
            disabled: true,
            reason: "legacy_pipeline_disabled",
            message: "Canonical trading-pipeline-orchestrator is the only production pipeline entrypoint.",
          },
          { status: 410 },
        );
      },
    },
  },
});