import { createFileRoute } from "@tanstack/react-router";
import {
  getWatchDiagnostic,
  getShadowConflicts,
} from "@/lib/diagnostic.functions";

export const Route = createFileRoute("/api/diagnostic")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const type = url.searchParams.get("type") ?? "watch";

        try {
          if (type === "shadow") {
            const data = await getShadowConflicts();
            return Response.json(data);
          }

          const data = await getWatchDiagnostic();
          return Response.json(data);
        } catch (e) {
          const message = e instanceof Error ? e.message : "unknown error";
          console.error(`[DIAGNOSTIC_ERROR] ${type}: ${message}`);
          return Response.json({ error: message, type }, { status: 500 });
        }
      },
    },
  },
});
