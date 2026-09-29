import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { getWatchDiagnostic } from "@/lib/diagnostic.functions";

/** Temporary debug button — shows the raw watch/council diagnostic payload. */
export function DiagnosticButton() {
  const diagnosticFn = useServerFn(getWatchDiagnostic);
  const [open, setOpen] = useState(false);

  const run = useMutation({
    mutationFn: () => diagnosticFn(),
  });

  const payload = run.data;

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          run.mutate();
        }}
        title="Temporary diagnostic — read only"
        className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted/70"
      >
        🔍 Diagnostic
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="font-mono text-sm font-semibold">Watch diagnostic</h2>
                <p className="text-[11px] text-muted-foreground">
                  Read-only snapshot · strategy, watch signals, council verdicts, source matrix
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => run.mutate()}
                  disabled={run.isPending}
                  className="rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold transition hover:bg-muted disabled:opacity-50"
                >
                  {run.isPending ? "Loading…" : "Refresh"}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-md border border-border px-2.5 py-1 text-[11px] font-semibold transition hover:bg-muted"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="overflow-auto px-4 py-3">
              {run.isPending && (
                <p className="text-xs text-muted-foreground">Fetching diagnostic…</p>
              )}
              {run.isError && (
                <p className="text-xs text-destructive">
                  {(run.error as Error).message}
                </p>
              )}
              {payload && (
                <div className="space-y-4">
                  <section>
                    <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      Source matrix (24h)
                    </h3>
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                      {JSON.stringify(payload.source_matrix, null, 2)}
                    </pre>
                  </section>
                  <section>
                    <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      Watches (30 min)
                    </h3>
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                      {JSON.stringify(payload.watches, null, 2)}
                    </pre>
                  </section>
                  <section>
                    <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      Strategy
                    </h3>
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                      {JSON.stringify(payload.strategy, null, 2)}
                    </pre>
                  </section>
                  <section>
                    <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                      Council signals
                    </h3>
                    <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[11px]">
                      {JSON.stringify(payload.councils, null, 2)}
                    </pre>
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
