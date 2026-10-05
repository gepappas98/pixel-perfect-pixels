import { createFileRoute } from "@tanstack/react-router";
import AIReport from "@/pages/AIReport";

export const Route = createFileRoute("/ai-report")({
  head: () => ({
    meta: [
      { title: "AI Diagnostic Report — Trading Command Center" },
      {
        name: "description",
        content:
          "Operational diagnostic snapshot with health status, portfolio metrics, variant breakdown, and error logs.",
      },
      { property: "og:title", content: "AI Diagnostic Report" },
      {
        property: "og:description",
        content: "Operational snapshot and system findings for Trading Command Center.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AIReport,
});
