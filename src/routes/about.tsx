import { createFileRoute, Link } from "@tanstack/react-router";
import { SupportDeveloper } from "@/components/trading/SupportDeveloper";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Research Lab" },
      {
        name: "description",
        content:
          "Research Lab studies cryptocurrency market data by combining whale flow, technical indicators, prediction-market signals, and AI analysis. It records and compares simulated research outcomes.",
      },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border px-5 py-4 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-mono text-base font-semibold tracking-tight">
              About Research Lab
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              A research platform for studying crypto-market behavior.
            </p>
          </div>
          <Link
            to="/"
            className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/80"
          >
            ← Back to dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 p-5 sm:p-8">
        <section className="panel">
          <h2 className="panel-title">What we do</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">
            <strong>Research Lab</strong> brings together four sources of
            cryptocurrency-market evidence: large-trade activity (whale flow),
            technical indicators, prediction markets, and AI analysis. It
            combines those inputs into research signals, tracks what happens
            afterward, and compares experimental strategies using simulated
            results.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Why it exists</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">
            The goal is to test hypotheses, measure signal quality, study
            market behavior, and make the reasoning and outcomes easier to
            inspect. Diagnostics and recorded results help us identify what
            works, what fails, and what still needs verification.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Research, not financial advice</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">
            Research Lab is an experimental analysis platform, not a promise of
            profitable trading and not a source of financial advice. Signals
            and simulated performance are hypothetical and do not predict
            future results. Cryptocurrency markets involve substantial risk.
            Verify that live execution is disabled before use.
          </p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Contact</h2>
          <p className="mt-3 text-sm leading-relaxed text-foreground/90">
            Questions, research ideas, or suggestions are welcome.
          </p>
          <a
            href="mailto:gepappas98@gmail.com?subject=Research%20Lab"
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 font-mono text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            ✉️ Contact the developer
          </a>
        </section>

        <SupportDeveloper />

        <p className="pb-4 text-center text-[11px] text-muted-foreground">
          Research Lab · Experimental research environment
        </p>

        <div className="flex justify-center pt-2">
          <Link
            to="/"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            ← Back to dashboard
          </Link>
        </div>
      </main>
    </div>
  );
}
