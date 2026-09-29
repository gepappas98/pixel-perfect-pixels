import { createFileRoute } from "@tanstack/react-router";
import {
  getWatchDiagnostic,
  getShadowConflicts,
} from "@/lib/diagnostic.functions";

export const Route = createFileRoute("/api/diagnostic")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        // Το params._splat περιέχει το subpath (π.χ. "shadow")
        const splat = (params as { _splat?: string })._splat ?? "";
        const subpath = splat.replace(/^\/+/, "");

        try {
          if (subpath === "shadow") {
            const data = await getShadowConflicts();
            return Response.json(data);
          }

          // Default: watch diagnostic
          const data = await getWatchDiagnostic();
          return Response.json(data);
        } catch (e) {
          const message = e instanceof Error ? e.message : "unknown error";
          console.error(`[DIAGNOSTIC_ERROR] ${subpath || "watch"}: ${message}`);
          return Response.json(
            { error: message, subpath: subpath || "watch" },
            { status: 500 },
          );
        }
      },
    },
  },
});
